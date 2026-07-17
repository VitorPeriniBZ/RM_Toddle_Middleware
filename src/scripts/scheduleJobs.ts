import { getQueue, closeAllQueues } from '../queues/queues';
import { QUEUE, STUDENT_JOB } from '../queues/names';
import { redisConnection } from '../queues/connection';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Registra o agendamento recorrente (Job Scheduler nativo do BullMQ).
 * Rodar UMA vez por ambiente (idempotente — upsert por id do scheduler).
 * Uso: npm run schedule
 */
async function main(): Promise<void> {
  const queue = getQueue(QUEUE.RM_TO_TODDLE_STUDENTS);

  await queue.upsertJobScheduler(
    'students-sync-nightly',
    { pattern: env.STUDENTS_SYNC_CRON, tz: 'America/Sao_Paulo' },
    { name: STUDENT_JOB.EXTRACT, data: { trigger: 'cron' } },
  );

  logger.info(
    { cron: env.STUDENTS_SYNC_CRON, tz: 'America/Sao_Paulo' },
    'Agendamento de sincronização de alunos registrado',
  );

  await closeAllQueues();
  await redisConnection.quit();
}

main().catch((error) => {
  logger.error({ error }, 'Falha ao registrar agendamento');
  process.exit(1);
});
