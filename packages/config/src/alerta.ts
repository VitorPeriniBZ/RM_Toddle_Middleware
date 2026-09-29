import { env } from './env';
import { logger } from './logger';

/**
 * Alerta ATIVO por webhook — o canal que faltava.
 *
 * ─── POR QUE ISTO EXISTE, TENDO HEARTBEAT ───────────────────────────────────
 *
 * O heartbeat (heartbeat.ts) é a inversão certa para UM modo de falha: o
 * processo morto. Um terceiro reclama quando o ping não chega, e isso cobre
 * container caído, Redis fora, credencial expirada e deploy quebrado.
 *
 * Ele NÃO cobre o modo de falha que deixou 62 jobs parados na DLQ por sete dias:
 * o worker seguia vivo e pingando, os jobs morriam um a um, e o silêncio nunca
 * aconteceu — logo nenhum alerta por silêncio disparou. Falha com o processo
 * saudável precisa do processo falando.
 *
 * Os dois juntos cobrem "morreu" e "está vivo e errando". Nenhum dos dois
 * sozinho cobre os dois.
 *
 * ─── MESMA DISCIPLINA DO HEARTBEAT ──────────────────────────────────────────
 *
 * NUNCA lança e NUNCA rejeita. Canal de alerta que derruba o que ele observa é
 * pior que canal nenhum. Falha de envio fica no log em nível warn.
 *
 * ─── FORMATO DO CORPO ───────────────────────────────────────────────────────
 *
 * `{ text, content }` — as duas chaves, de propósito. Slack e ntfy leem `text`,
 * Discord lê `content`. Mandar as duas faz o mesmo webhook servir aos três sem
 * uma variável de "qual provedor é este", e a chave extra é ignorada por quem
 * não a conhece.
 */

export interface Alerta {
  /**
   * Uma linha, começando pelo que quebrou. Vai no título da notificação.
   *
   * ─── O ASSUNTO TEM DE SER ESTÁVEL ENTRE REPETIÇÕES ────────────────────────
   *
   * É a CHAVE da supressão. Um assunto que carrega número variável — "sem
   * sucesso há 13.2h", "há 13.4h" — produz uma chave nova a cada passada e a
   * supressão nunca acontece. Número que muda vai no `contexto`, que é
   * renderizado no corpo da mensagem e não participa da chave.
   */
  assunto: string;
  /** Contexto estruturado: fluxo, chave do run, motivo. Vira texto legível. */
  contexto?: Record<string, unknown>;
  /**
   * Janela de supressão deste alerta, em ms. Default: 10 min.
   *
   * Existe porque os dois tipos de alerta deste sistema têm ritmos opostos:
   *
   *   RAJADA     um extract falha e 50 lotes falham atrás dele, em segundos.
   *              10 min resolve.
   *   CONDIÇÃO   "nenhum run bem-sucedido há 13h", "62 jobs na DLQ". Não é
   *              evento: é estado, e ele PERSISTE até alguém consertar. O vigia
   *              o reencontra a cada passada (15 min por default), e 10 min de
   *              janela é MENOR que isso — ou seja, nenhuma supressão, e uma
   *              notificação a cada 15 minutos, indefinidamente.
   *
   * Canal que grita a cada 15 min é canal que alguém silencia, e aí o próximo
   * alerta — o que talvez importe — também se perde. Quem alerta sobre condição
   * persistente passa uma janela em horas.
   */
  repetirApos?: number;
}

/**
 * Guarda contra tempestade de alerta.
 *
 * Um extract que falha faz 50 lotes falharem atrás dele. Sem esta guarda, o
 * canal recebe 51 mensagens do mesmo defeito, e canal que grita 51 vezes é canal
 * que alguém silencia — perdendo também o alerta seguinte, que talvez importe.
 *
 * A janela é por ASSUNTO: dois defeitos diferentes na mesma janela passam os
 * dois. É supressão de repetição, não de volume.
 */
const JANELA_REPETICAO_MS = 10 * 60 * 1_000;
const ultimoEnvio = new Map<string, number>();

/**
 * Supressão do LOG DEGRADADO, separada da supressão do ENVIO.
 *
 * São dois mapas de propósito. Com um só, um alerta que não teve canal marcaria
 * a janela de envio do mesmo assunto — e, pior, o caminho sem canal passaria a
 * povoar um mapa que antes ficava vazio.
 *
 * Separado, cada caminho tem a própria contabilidade e nenhum interfere no
 * outro.
 */
const ultimoDegradado = new Map<string, number>();

/**
 * Teto de entradas por mapa.
 *
 * Nenhum dos dois era podado, e isso não incomodava enquanto o caminho sem
 * canal retornava na primeira linha — o mapa ficava vazio. Passando a registrar,
 * um assunto de cardinalidade alta num processo de semanas cresce sem limite.
 *
 * A poda é grosseira de propósito: quando estoura, some com a metade mais
 * antiga. Perder uma marca de supressão custa uma notificação repetida; vazar
 * memória num worker que roda por semanas custa o worker.
 */
const TETO_DE_ENTRADAS = 500;

function registrar(mapa: Map<string, number>, chave: string, agora: number): void {
  if (mapa.size >= TETO_DE_ENTRADAS) {
    const porIdade = [...mapa.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of porIdade.slice(0, Math.floor(TETO_DE_ENTRADAS / 2))) mapa.delete(k);
  }
  mapa.set(chave, agora);
}

/** `true` quando o assunto ainda está dentro da janela — ou seja, deve calar. */
function dentroDaJanela(mapa: Map<string, number>, chave: string, agora: number, janela: number): boolean {
  const anterior = mapa.get(chave);
  return anterior !== undefined && agora - anterior < janela;
}

/**
 * Envia o alerta. Nunca lança. Devolve `false` quando não enviou.
 *
 * ─── SEM CANAL, O ALERTA É DEGRADADO — NUNCA PERDIDO ────────────────────────
 *
 * Esta função abria com `if (!env.ALERTA_WEBHOOK_URL) return false;`, comentado
 * como "não configurado = desligado, de propósito". A intenção era não obrigar
 * quem roda local a montar um webhook. O efeito foi outro: como NENHUMA URL
 * estava configurada em lugar nenhum, o vigia rodava, encontrava o problema,
 * chamava esta função, e ela devolvia `false` calada. Toda vez.
 *
 * Foi assim que 62 jobs ficaram sete dias parados na DLQ.
 *
 * Continua legítimo rodar sem webhook. O que deixou de ser legítimo é o alerta
 * EVAPORAR: sem canal, o conteúdo inteiro vai para o log em nível `error`, que
 * é o nível que sobrevive a um filtro de produção. A informação perde alcance,
 * não existência. A supressão por repetição vale também aqui — um extract que
 * falha faz 50 lotes falharem atrás dele, e 51 linhas de `error` idênticas é a
 * mesma tempestade que a janela existe para conter.
 */
export async function alertar(alerta: Alerta): Promise<boolean> {
  const agora = Date.now();
  const janela = alerta.repetirApos ?? JANELA_REPETICAO_MS;

  const linhas = Object.entries(alerta.contexto ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `• ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  const texto = [`[${env.TENANT_SLUG}] ${alerta.assunto}`, ...linhas].join('\n');

  /*
   * ─── SEM CANAL: SAI PELO LOG, COM CONTABILIDADE PRÓPRIA ──────────────────
   *
   * Este ramo vem ANTES da janela de envio, e isso é deliberado: um alerta que
   * nunca teve para onde ir não pode marcar a janela de envio do assunto. Do
   * contrário o caminho sem canal ficaria mexendo numa contabilidade que só faz
   * sentido para quem de fato envia.
   */
  if (!env.ALERTA_WEBHOOK_URL) {
    if (dentroDaJanela(ultimoDegradado, alerta.assunto, agora, janela)) return false;
    registrar(ultimoDegradado, alerta.assunto, agora);
    logger.error(
      { assunto: alerta.assunto, contexto: alerta.contexto, canal: 'DESLIGADO' },
      `ALERTA SEM CANAL — ninguém foi avisado. Defina ALERTA_WEBHOOK_URL (Slack, Discord ou ` +
        `ntfy) para que este aviso chegue a alguém. Conteúdo do alerta:\n${texto}`,
    );
    return false;
  }

  if (dentroDaJanela(ultimoEnvio, alerta.assunto, agora, janela)) {
    logger.debug(
      { assunto: alerta.assunto, janelaMs: janela },
      'Alerta suprimido: mesmo assunto dentro da janela de repetição',
    );
    return false;
  }
  registrar(ultimoEnvio, alerta.assunto, agora);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ALERTA_WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(env.ALERTA_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texto, content: texto }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, assunto: alerta.assunto },
        'Canal de alerta recusou a mensagem — o worker seguiu normalmente',
      );
      return false;
    }
    logger.debug({ assunto: alerta.assunto }, 'Alerta enviado');
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, assunto: alerta.assunto },
      'Alerta não pôde ser enviado — o worker seguiu normalmente. ' +
        'ATENÇÃO: este defeito ficou SEM aviso; só o log registra',
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Zera as duas supressões. Existe para o teste não depender de tempo de parede. */
export function limparJanelaDeAlerta(): void {
  ultimoEnvio.clear();
  ultimoDegradado.clear();
}
