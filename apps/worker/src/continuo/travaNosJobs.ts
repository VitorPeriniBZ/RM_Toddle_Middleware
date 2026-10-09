import { UnrecoverableError, type Job } from 'bullmq';
import { env, logger } from '@rm-toddle/config';
import { recusouCredencialDoRm } from '@rm-toddle/integrations';
import { STUDENT_JOB, credencialDoRmAceita, registrarRecusaDeCredencialDoRm } from '@rm-toddle/queues';

/**
 * Liga os JOBS à trava de credencial do RM (packages/queues/src/travaDoRm.ts).
 *
 * ─── POR QUE OS JOBS, E NÃO SÓ O DETECTOR ───────────────────────────────────
 *
 * O detector de nota não fala com o RM — ele pergunta ao Toddle. Quem fala com
 * o RM é o fluxo que ele dispara. Então é o JOB que vê a recusa primeiro, e se
 * ele não avisasse, o detector seguiria disparando um job recusado por minuto.
 *
 * ─── O JOB DO DETECTOR NÃO É RETENTADO NA RECUSA ────────────────────────────
 *
 * Com `attempts: 3`, cada job recusado gasta três autenticações — metade do
 * limite que bloqueia o usuário. Para job de agenda isso continua igual (a DLQ,
 * o heartbeat e o vigia dependem dessa contagem). Para job de detector, a recusa
 * vira `UnrecoverableError`: falha uma vez, a trava sobe, e quem tenta de novo é
 * o próprio detector, quando a trava cair. Nada se perde — a mudança continua na
 * origem, e a varredura agendada também a leva.
 */
export function comTravaDoRm<T>(processar: (job: Job) => Promise<T>): (job: Job) => Promise<T> {
  return async (job: Job) => {
    try {
      const r = await processar(job);
      // Terminou lendo o RM: a senha está boa, e a trava (se houver) cai. O lote
      // de alunos não lê o RM, e `{ desligado: true }` saiu antes de ler —
      // nenhum dos dois prova nada.
      const desligado = Boolean(r && typeof r === 'object' && (r as { desligado?: unknown }).desligado === true);
      if (job.name !== STUDENT_JOB.UPSERT_BATCH && !desligado) void credencialDoRmAceita();
      return r;
    } catch (err) {
      if (recusouCredencialDoRm(err)) {
        const trava = await registrarRecusaDeCredencialDoRm(
          env.CONTINUO_PAUSA_CREDENCIAL_MIN * 60_000,
          (err as Error).message ?? String(err),
        ).catch(() => null);
        logger.error(
          { jobId: job.id, jobName: job.name, travaAte: trava?.ate, recusas: trava?.recusas },
          'O RM recusou a credencial num job — detectores travados para não bloquear o usuário',
        );
        if ((job.data as { trigger?: string } | undefined)?.trigger === 'continuo') {
          const e = new UnrecoverableError(
            `${(err as Error).message} — job de detector: sem retentativa, para não somar recusas no RM`,
          );
          Object.assign(e, { recusouCredencial: true });
          throw e;
        }
      }
      throw err;
    }
  };
}
