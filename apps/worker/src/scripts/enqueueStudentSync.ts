import { getQueue, closeAllQueues } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { redisConnection } from '@rm-toddle/queues';
import { logger } from '@rm-toddle/config';

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
