import { Job, Worker } from 'bullmq';
import { redisConnection } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { wireDeadLetterQueue } from '@rm-toddle/queues';
import { closeAllQueues } from '@rm-toddle/queues';
import { manterAgendamentoDeAlunos } from '@rm-toddle/queues';
import { pgPool } from '@rm-toddle/db';
import { closeRmSqlPool } from '@rm-toddle/integrations';
import {
  processStudentExtract,
  processStudentUpsertBatch,
} from './studentSync.processor';
import { processStaffSync } from './staffSync.processor';
import { STAFF_JOB } from '@rm-toddle/queues';
import { logger } from '@rm-toddle/config';

/**
 * Worker da fila `rm-to-toddle.students`.
 * Rodar com: npm run worker:students
 *
 * - concurrency 1 + limiter 2 req/s: medido em 2026-07-31 — com concurrency 3
 *   e 5 req/s o Toddle devolveu HTTP 429 em massa e 3 lotes foram para a DLQ.
 *   Os limites do Toddle não são documentados; estes valores sincronizaram 510
 *   alunos sem rate limit. O cliente ainda retenta 429/5xx por conta própria
 *   (ToddleClient.withRetry), então isto é a primeira linha de defesa, não a
 *   única.
 */
const worker = new Worker(
  QUEUE.RM_TO_TODDLE_STUDENTS,
  async (job: Job) => {
    switch (job.name) {
      case STUDENT_JOB.EXTRACT:
        return processStudentExtract(job);
      case STUDENT_JOB.UPSERT_BATCH:
        return processStudentUpsertBatch(job);
      default:
        throw new Error(`Job desconhecido na fila de alunos: ${job.name}`);
    }
  },
  {
    connection: redisConnection,
    concurrency: 1,
    limiter: { max: 2, duration: 1_000 },
  },
);

/**
 * Worker da fila `rm-to-toddle.staff` — MESMO PROCESSO, fila separada.
 *
 * Um `Worker` do BullMQ é por fila, então professor precisa do seu. Fica aqui em
 * vez de num container próprio porque o volume é ínfimo (35 professores, ~200
 * turma-disciplina) e um segundo serviço traria supervisão, deploy e log
 * duplicados para nada.
 *
 * `concurrency: 1` e sem limiter: o job já serializa suas chamadas internamente
 * (`comPaciencia` + intervalo de 250ms), e os dois syncs são escalonados com 30
 * min de folga justamente para não competirem pela janela de rate limit do
 * Toddle — ver `cronDoProfessor` em packages/queues/src/schedulers.ts.
 */
const staffWorker = new Worker(
  QUEUE.RM_TO_TODDLE_STAFF,
  async (job: Job) => {
    switch (job.name) {
      case STAFF_JOB.SYNC:
        return processStaffSync(job);
      default:
        throw new Error(`Job desconhecido na fila de professores: ${job.name}`);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

// Jobs que esgotarem as 3 tentativas vão para a fila 'dead-letter'.
wireDeadLetterQueue(worker, QUEUE.RM_TO_TODDLE_STUDENTS);
wireDeadLetterQueue(staffWorker, QUEUE.RM_TO_TODDLE_STAFF);

staffWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job de professor concluído');
});
staffWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job de professor falhou',
  );
});
staffWorker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker de professores');
});

// O agendamento noturno vive só no Redis. Se o Redis reiniciar sem persistir, o
// scheduler desaparece e NADA dá erro — o worker fica de pé consumindo uma fila
// que nunca mais recebe nada. Isto o re-registra no boot e em cada reconexão ao
// Redis, então ele não pode estar ausente enquanto o worker estiver vivo.
manterAgendamentoDeAlunos();

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job concluído');
});

worker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job falhou',
  );
});

worker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker');
});

logger.info({ queue: QUEUE.RM_TO_TODDLE_STUDENTS }, 'Worker de alunos iniciado');

/** Encerramento gracioso: termina o job em andamento antes de sair. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando worker...');
  try {
    // Os DOIS workers: sem fechar o de professor, o SIGTERM mataria um job em
    // andamento no meio de uma escrita no Toddle.
    await Promise.all([worker.close(), staffWorker.close()]);
    await closeAllQueues();
    await closeRmSqlPool();
    await pgPool.end();
    await redisConnection.quit();
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Erro no encerramento');
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
