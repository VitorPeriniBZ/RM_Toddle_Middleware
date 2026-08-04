import { getQueue, closeAllQueues } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { redisConnection } from '@rm-toddle/queues';
import { env } from '@rm-toddle/config';
import { logger } from '@rm-toddle/config';

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
