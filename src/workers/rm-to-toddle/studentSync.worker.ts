import { Job, Worker } from 'bullmq';
import { redisConnection } from '../../queues/connection';
import { QUEUE, STUDENT_JOB } from '../../queues/names';
import { wireDeadLetterQueue } from '../../queues/deadLetter';
import { closeAllQueues } from '../../queues/queues';
import { pgPool } from '../../db/pool';
import { closeRmSqlPool } from '../../clients/rm-database/rmSqlPool';
import {
  processStudentExtract,
  processStudentUpsertBatch,
} from './studentSync.processor';
import { logger } from '../../utils/logger';

/**
 * Worker da fila `rm-to-toddle.students`.
 * Rodar com: npm run worker:students
 *
 * - concurrency 3: lotes em paralelo sem afogar as APIs
 * - limiter 5 req/s: os rate limits do Toddle NÃO são documentados — comece
 *   conservador e ajuste com dados reais
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
    concurrency: 3,
    limiter: { max: 5, duration: 1_000 },
  },
);

// Jobs que esgotarem as 3 tentativas vão para a fila 'dead-letter'.
wireDeadLetterQueue(worker, QUEUE.RM_TO_TODDLE_STUDENTS);

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
    await worker.close();
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
