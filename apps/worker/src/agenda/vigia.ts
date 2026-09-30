import { alertar, conferirCanalDeAviso, env, logger } from '@rm-toddle/config';
import { listarAgenda, runsPresos, ultimoSucessoPorTipo } from '@rm-toddle/db';
import { FLUXOS_EM_ORDEM, acharFluxo, resumoDaDlq } from '@rm-toddle/queues';

/**
 * VIGIA — o alerta que o heartbeat não dá.
 *
 * ─── A LACUNA EXATA QUE ELE FECHA ───────────────────────────────────────────
 *
 * O heartbeat (packages/config/src/heartbeat.ts) inverte o problema certo: o job
 * avisa que está vivo e um terceiro reclama do silêncio. Isso cobre container
 * morto, Redis fora, credencial expirada, deploy quebrado — tudo em que o
 * processo é o que está parado.
 *
 * Não cobre o que aconteceu com os 62 jobs da DLQ: o worker seguia vivo, os jobs
 * morriam um a um, o ping de sucesso nunca era enviado mas também nada gritava
 * ativamente, e sete dias passaram batido. Falha com o processo saudável precisa
 * do processo falando.
 *
 * ─── AS TRÊS PERGUNTAS QUE ELE FAZ ──────────────────────────────────────────
 *
 *   1. Algum fluxo LIGADO está sem run bem-sucedido além da janela dele?
 *   2. Tem algo na DLQ?
 *   3. Tem run preso em `executing` há horas (a assinatura de "morreu no meio")?
 *
 * A primeira é a que mais importa e a mais fácil de errar: ela pergunta pelo
 * último SUCESSO, não pelo último run. Um fluxo que falha de hora em hora tem
 * "último run" recentíssimo e está morto há dias.
 *
 * ─── SILÊNCIO NÃO É SUCESSO, INCLUSIVE AQUI ─────────────────────────────────
 *
 * O vigia nunca lança: uma falha na vigilância não pode derrubar o worker que
 * ela observa. Mas ela é LOGADA em nível alto, porque um vigia quebrado é
 * indistinguível de um sistema saudável — que é o modo de falha que este arquivo
 * existe para eliminar.
 */

/** Horas em `executing` a partir das quais um run é considerado preso. */
const HORAS_PARA_RUN_PRESO = 6;

export interface Achado {
  assunto: string;
  contexto: Record<string, unknown>;
}

/**
 * Uma passada de vigilância. Devolve o que achou (vazio = tudo bem).
 *
 * Separada do agendamento para poder ser chamada à mão e testada sem esperar
 * o intervalo.
 */
export async function vigiarUmaVez(): Promise<Achado[]> {
  const achados: Achado[] = [];

  const agenda = await listarAgenda();
  const ligados = agenda.filter((a) => a.ativo && acharFluxo(a.flowKey)?.podeAtivar);
  const sucessos = await ultimoSucessoPorTipo(ligados.map((a) => a.flowKey));
  const agora = Date.now();

  for (const linha of ligados) {
    const fluxo = acharFluxo(linha.flowKey);
    if (!fluxo) continue;

    const janelaMs = fluxo.janelaSemSucessoHoras * 3_600_000;
    const ultimo = sucessos[linha.flowKey];

    // Sem NENHUM sucesso: a referência passa a ser desde quando o fluxo está
    // agendado de fato. Alertar na primeira volta depois de ligar seria alarme
    // por instalação nova, e alarme por nada é alarme que alguém silencia.
    const referencia = ultimo ?? linha.aplicadaEm ?? linha.atualizadoEm;
    const idadeHoras = (agora - new Date(referencia).getTime()) / 3_600_000;
    if (agora - new Date(referencia).getTime() <= janelaMs) continue;

    achados.push({
      assunto: `${fluxo.rotulo}: nenhum run bem-sucedido dentro da janela`,
      contexto: {
        haHoras: idadeHoras.toFixed(1),
        fluxo: fluxo.key,
        cron: linha.cron,
        janelaEsperadaHoras: fluxo.janelaSemSucessoHoras,
        ultimoSucesso: ultimo ?? 'NUNCA',
        desde: ultimo ? undefined : `agendado desde ${referencia}`,
      },
    });
  }

  const dlq = await resumoDaDlq(3);
  if (dlq.total > 0) {
    achados.push({
      assunto: 'Jobs parados na DLQ',
      contexto: {
        total: dlq.total,
        maisRecentes: dlq.recentes.map((r) => `${r.jobName}: ${r.failedReason.slice(0, 120)}`),
        comoVer: 'npm run dlq',
      },
    });
  }

  const presos = await runsPresos(HORAS_PARA_RUN_PRESO);
  if (presos.length > 0) {
    achados.push({
      assunto: 'Run(s) preso(s) em "executing"',
      contexto: {
        quantidade: presos.length,
        haMaisDeHoras: HORAS_PARA_RUN_PRESO,
        runs: presos.slice(0, 5).map((r) => `${r.tipo} (${r.chave}) desde ${r.criadoEm}`),
        significado: 'lote esgotou as tentativas e nunca voltou para fechar o run',
      },
    });
  }

  return achados;
}

/**
 * Janela de repetição dos achados do vigia.
 *
 * Seis horas, e não os 10 minutos default de `alertar()`, porque o que o vigia
 * encontra é CONDIÇÃO, não evento: "nenhum run bem-sucedido há 13h" continua
 * verdade na próxima passada, e na seguinte, até alguém consertar.
 *
 * O default de 10 min é MENOR que o intervalo do vigia (15 min por padrão), o
 * que significa supressão nenhuma — uma notificação a cada 15 minutos,
 * indefinidamente, pelo mesmo problema. Canal que faz isso é canal que alguém
 * silencia no primeiro dia, e aí o alerta seguinte, o que talvez importe,
 * também se perde.
 *
 * Seis horas mantém o problema visível (quatro avisos por dia) sem transformar
 * o canal em ruído.
 */
const REPETIR_ACHADO_APOS_MS = 6 * 60 * 60 * 1_000;

/**
 * De quanto em quanto tempo relembrar o estado do canal de aviso.
 *
 * `conferirCanalDeAviso` roda no boot do worker, e num processo que fica de pé
 * por semanas essa linha fica enterrada sob tudo o que veio depois — no caso
 * medido, sob 6,3 GB. Um sistema cego precisa dizer que está cego mais de uma
 * vez na vida.
 */
const RELEMBRAR_CANAL_APOS_MS = 24 * 60 * 60 * 1_000;
let ultimoLembreteDoCanal = 0;

/** Vigia e alerta. Nunca lança. */
async function vigiarEAlertar(): Promise<void> {
  try {
    const achados = await vigiarUmaVez();
    for (const a of achados) {
      logger.error({ ...a.contexto }, a.assunto);
      await alertar({ assunto: a.assunto, contexto: a.contexto, repetirApos: REPETIR_ACHADO_APOS_MS });
    }
    if (achados.length === 0) {
      logger.debug({ fluxos: FLUXOS_EM_ORDEM.length }, 'Vigia: nada a reportar');
    }

    /*
     * O vigia é quem relembra que o canal está desligado.
     *
     * Faz sentido ser aqui e não num temporizador próprio: este é o componente
     * cujo trabalho inteiro depende de existir um canal. Um vigia que encontra
     * problemas e não tem para onde contá-los é a definição do defeito que o
     * P0-2 foi consertar, e ele precisa dizer isso periodicamente, não só uma
     * vez no boot.
     */
    const agora = Date.now();
    if (agora - ultimoLembreteDoCanal >= RELEMBRAR_CANAL_APOS_MS) {
      ultimoLembreteDoCanal = agora;
      conferirCanalDeAviso('vigia');
    }
  } catch (err) {
    logger.error(
      { err },
      'FALHA no vigia — nenhum alerta será emitido nesta volta, e vigia quebrado é ' +
        'indistinguível de sistema saudável',
    );
  }
}

/**
 * Liga o vigia. Devolve a função de encerramento.
 *
 * A primeira passada NÃO é imediata: no boot o worker acabou de subir, os runs
 * do dia podem ainda não ter acontecido e a DLQ herdada geraria um alerta a cada
 * deploy. Um intervalo de espera evita transformar "eu redeployei" em incidente.
 */
export function ligarVigia(): () => void {
  const timer = setInterval(() => void vigiarEAlertar(), env.VIGIA_INTERVALO_MS);
  logger.info(
    {
      intervaloMs: env.VIGIA_INTERVALO_MS,
      canalConfigurado: Boolean(env.ALERTA_WEBHOOK_URL),
    },
    env.ALERTA_WEBHOOK_URL
      ? 'Vigia ativo (falta de sucesso, DLQ, run preso)'
      : 'Vigia ativo, mas ALERTA_WEBHOOK_URL está VAZIA — os achados só irão para o log',
  );
  return () => clearInterval(timer);
}
