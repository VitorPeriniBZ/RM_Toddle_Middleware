import { env } from './env';
import { logger } from './logger';

/**
 * O CANAL DE AVISO, E SE ELE EXISTE.
 *
 * ─── O DEFEITO QUE ESTE MÓDULO EXISTE PARA MATAR ────────────────────────────
 *
 * Este projeto construiu três mecanismos de aviso, todos bem desenhados:
 *
 *   heartbeat.ts   dead man's switch — um terceiro reclama do silêncio
 *   alerta.ts      webhook ativo — o processo fala quando falha vivo
 *   agenda/vigia   pergunta por último SUCESSO, DLQ e run preso
 *
 * E os três estavam MUDOS, porque nenhuma URL estava configurada. `alerta.ts`
 * abria com `if (!env.ALERTA_WEBHOOK_URL) return false;` e `heartbeat.ts` com
 * `if (!url) return;` — as duas linhas comentadas como "não configurado =
 * desligado, de propósito".
 *
 * A intenção era boa: não obrigar quem só quer rodar local a montar um webhook.
 * O efeito foi outro. O vigia rodava, encontrava o problema, chamava `alertar()`,
 * e `alertar()` devolvia `false` sem dizer nada. Toda vez. É assim que 62 jobs
 * ficaram sete dias parados na DLQ, e é assim que um worker martelou um Redis
 * morto por treze dias produzindo 6,3 GB de log que ninguém leu.
 *
 * ─── A REGRA QUE SUBSTITUI "DESLIGADO = SILENCIOSO" ─────────────────────────
 *
 * **Um monitor desligado não pode ser silencioso sobre estar desligado.**
 *
 * Continua sendo legítimo rodar sem webhook — o que deixa de ser legítimo é
 * fazer isso sem que apareça. Então: o processo diz no boot o que está cego, o
 * `/health` mostra o estado, e um alerta que não teve para onde ir é despejado
 * no log em nível `error` com o conteúdo inteiro, em vez de evaporar.
 *
 * ─── POR QUE A DECISÃO É UMA FUNÇÃO PURA ────────────────────────────────────
 *
 * `diagnosticar` recebe as URLs e devolve o veredito; quem lê o `env` é o
 * invólucro. Sem isso, testar "o que acontece quando falta a variável" exigiria
 * mexer no ambiente do processo — e a validação Zod de `env.ts` roda na
 * importação, então esse tipo de teste vira teste do `dotenv`, não do desenho.
 * É a mesma escolha de `serializarErro` em `logger.ts` e de `decidirEscrita`.
 */

export type EstadoDoCanal = 'ativo' | 'DESLIGADO';

/** Os quatro fluxos que têm dead man's switch próprio. Ver heartbeat.ts. */
export const FLUXOS_COM_HEARTBEAT = ['alunos', 'professores', 'notas', 'frequencia'] as const;
export type FluxoComHeartbeat = (typeof FLUXOS_COM_HEARTBEAT)[number];

export interface UrlsDeAviso {
  alerta?: string;
  heartbeats: Partial<Record<FluxoComHeartbeat, string | undefined>>;
}

export interface DiagnosticoDoCanal {
  /** Webhook ativo: o canal por onde DLQ e vigia falam. */
  alerta: EstadoDoCanal;
  /** Um por fluxo. Um fluxo sem heartbeat não tem quem reclame do silêncio dele. */
  heartbeats: Record<FluxoComHeartbeat, EstadoDoCanal>;
  /**
   * `true` quando NADA está configurado.
   *
   * É o estado que importa nomear: não é "faltou uma variável", é "uma falha
   * deste sistema não produz aviso nenhum para ninguém".
   */
  cego: boolean;
  /** Variáveis de ambiente que faltam, na ordem em que vale configurá-las. */
  faltando: string[];
  /** Frase pronta para o log e para a tela. Nunca vazia. */
  resumo: string;
}

/** A variável de ambiente de cada fluxo. Mesma convenção de heartbeat.ts. */
const VARIAVEL_DO_FLUXO: Record<FluxoComHeartbeat, string> = {
  alunos: 'HEARTBEAT_URL_ALUNOS',
  professores: 'HEARTBEAT_URL_PROFESSORES',
  notas: 'HEARTBEAT_URL_NOTAS',
  frequencia: 'HEARTBEAT_URL_FREQUENCIA',
};

/** Vazio para efeito da regra: ausente, string vazia ou só espaço. */
const configurado = (v: string | undefined): boolean => typeof v === 'string' && v.trim() !== '';

/**
 * O veredito. Pura: sem `env`, sem log, sem rede.
 *
 * A ordem de `faltando` é deliberada: `ALERTA_WEBHOOK_URL` primeiro porque é a
 * única que sozinha já tira o sistema da cegueira total — ela cobre DLQ e vigia,
 * que são os dois modos de falha com o processo VIVO. Os heartbeats cobrem o
 * processo morto, e para isso o monitor externo precisa existir antes.
 */
export function diagnosticar(urls: UrlsDeAviso): DiagnosticoDoCanal {
  const alerta: EstadoDoCanal = configurado(urls.alerta) ? 'ativo' : 'DESLIGADO';

  const heartbeats = {} as Record<FluxoComHeartbeat, EstadoDoCanal>;
  const faltando: string[] = [];
  if (alerta === 'DESLIGADO') faltando.push('ALERTA_WEBHOOK_URL');

  for (const fluxo of FLUXOS_COM_HEARTBEAT) {
    const ok = configurado(urls.heartbeats[fluxo]);
    heartbeats[fluxo] = ok ? 'ativo' : 'DESLIGADO';
    if (!ok) faltando.push(VARIAVEL_DO_FLUXO[fluxo]);
  }

  const heartbeatsAtivos = FLUXOS_COM_HEARTBEAT.filter((f) => heartbeats[f] === 'ativo').length;
  const cego = alerta === 'DESLIGADO' && heartbeatsAtivos === 0;

  return { alerta, heartbeats, cego, faltando, resumo: resumir(alerta, heartbeatsAtivos, cego) };
}

function resumir(alerta: EstadoDoCanal, heartbeatsAtivos: number, cego: boolean): string {
  if (cego) {
    return (
      'NENHUM canal de aviso configurado: uma falha deste sistema não vai avisar ninguém. ' +
      'Defina ALERTA_WEBHOOK_URL (Slack, Discord ou ntfy) para que DLQ e vigia falem, e as ' +
      'HEARTBEAT_URL_* (Healthchecks.io ou Uptime Kuma) para que alguém reclame do silêncio ' +
      'quando o processo morrer. Ver docs/TODO.md.'
    );
  }
  const total = FLUXOS_COM_HEARTBEAT.length;
  if (alerta === 'ativo' && heartbeatsAtivos === total) {
    return `Canal de aviso completo: webhook ativo e ${total} heartbeats configurados.`;
  }
  const partes: string[] = [];
  partes.push(alerta === 'ativo' ? 'webhook ativo' : 'webhook DESLIGADO');
  partes.push(`${heartbeatsAtivos} de ${total} heartbeats configurados`);
  return `Canal de aviso PARCIAL: ${partes.join(', ')}. O que falta não avisa.`;
}

/** As URLs como estão no ambiente deste processo. */
export function urlsDoAmbiente(): UrlsDeAviso {
  return {
    alerta: env.ALERTA_WEBHOOK_URL,
    heartbeats: {
      alunos: env.HEARTBEAT_URL_ALUNOS,
      professores: env.HEARTBEAT_URL_PROFESSORES,
      notas: env.HEARTBEAT_URL_NOTAS,
      frequencia: env.HEARTBEAT_URL_FREQUENCIA,
    },
  };
}

/** O diagnóstico deste processo, sem logar. É o que o `/health` publica. */
export function diagnosticoDoAmbiente(): DiagnosticoDoCanal {
  return diagnosticar(urlsDoAmbiente());
}

/**
 * Confere no BOOT e deixa o estado no log. Chamar uma vez, ao subir.
 *
 * Nível por gravidade, e `error` para cegueira total não é exagero: um processo
 * que escreve no registro acadêmico de alunos e não tem como pedir socorro é um
 * problema operacional, não uma preferência de configuração. `error` também é o
 * nível que costuma estar ligado em produção quando `warn` foi filtrado.
 *
 * NUNCA lança. Um processo não pode deixar de subir porque o canal de aviso está
 * incompleto — isso trocaria "falha sem aviso" por "sem sistema nenhum".
 */
export function conferirCanalDeAviso(componente: string): DiagnosticoDoCanal {
  const d = diagnosticoDoAmbiente();
  const dados = { componente, alerta: d.alerta, heartbeats: d.heartbeats, faltando: d.faltando };

  if (d.cego) logger.error(dados, d.resumo);
  else if (d.faltando.length > 0) logger.warn(dados, d.resumo);
  else logger.info(dados, d.resumo);

  return d;
}
