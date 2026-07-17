import { getQueue, closeAllQueues } from '../queues/queues';
import { QUEUE, STUDENT_JOB } from '../queues/names';
import { redisConnection } from '../queues/connection';
import { logger } from '../utils/logger';

/**
 * Dispara manualmente a sincronização de alunos (Fluxo 1).
 * Uso: npm run enqueue:students
 */
async function main(): Promise<void> {
  const queue = getQueue(QUEUE.RM_TO_TODDLE_STUDENTS);
  const job = await queue.add(STUDENT_JOB.EXTRACT, { trigger: 'manual' });
  logger.info({ jobId: job.id }, 'Job students.extract enfileirado — inicie o worker para processar');

  await closeAllQueues();
  await redisConnection.quit();
}

main().catch((error) => {
  logger.error({ error }, 'Falha ao enfileirar');
  process.exit(1);
});
