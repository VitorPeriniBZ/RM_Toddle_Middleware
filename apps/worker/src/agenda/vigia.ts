import { alertar, env, logger } from '@rm-toddle/config';
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
      assunto: `${fluxo.rotulo}: nenhum run bem-sucedido há ${idadeHoras.toFixed(1)}h`,
      contexto: {
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
      assunto: `${dlq.total} job(s) na DLQ`,
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
      assunto: `${presos.length} run(s) preso(s) em "executing" há mais de ${HORAS_PARA_RUN_PRESO}h`,
      contexto: {
        runs: presos.slice(0, 5).map((r) => `${r.tipo} (${r.chave}) desde ${r.criadoEm}`),
        significado: 'lote esgotou as tentativas e nunca voltou para fechar o run',
      },
    });
  }

  return achados;
}

/** Vigia e alerta. Nunca lança. */
async function vigiarEAlertar(): Promise<void> {
  try {
    const achados = await vigiarUmaVez();
    for (const a of achados) {
      logger.error({ ...a.contexto }, a.assunto);
      await alertar({ assunto: a.assunto, contexto: a.contexto });
    }
    if (achados.length === 0) {
      logger.debug({ fluxos: FLUXOS_EM_ORDEM.length }, 'Vigia: nada a reportar');
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
