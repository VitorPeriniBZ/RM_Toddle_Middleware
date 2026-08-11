import { closeAllQueues, redisConnection } from '@rm-toddle/queues';
import { upsertStudentsNightly, upsertStaffNightly, SCHEDULER } from '@rm-toddle/queues';
import { env, cronDoProfessorEfetivo } from '@rm-toddle/config';
import { logger } from '@rm-toddle/config';

/**
 * Registra o agendamento recorrente (Job Scheduler nativo do BullMQ).
 * Uso: npm run schedule
 *
 * Idempotente (upsert por id do scheduler), então rodar de novo é seguro — é por
 * isso que o serviço `init` do docker-compose.coolify.yml o chama a cada deploy.
 *
 * A definição do agendamento NÃO mora aqui: está em packages/queues/schedulers.ts,
 * compartilhada com o startup do worker, que também a registra. Duplicar a
 * definição deixaria dois schedulers vivos com horários diferentes se alguém
 * mudasse o cron num lado só.
 *
 * Este script continua útil para registrar SEM subir o worker (bootstrap de
 * ambiente, ou conferir a configuração antes do primeiro deploy).
 */
async function main(): Promise<void> {
  await upsertStudentsNightly();
  await upsertStaffNightly();

  logger.info(
    {
      alunos: { scheduler: SCHEDULER.STUDENTS_NIGHTLY, cron: env.STUDENTS_SYNC_CRON },
      professores: { scheduler: SCHEDULER.STAFF_NIGHTLY, cron: cronDoProfessorEfetivo() },
      tz: 'America/Sao_Paulo',
    },
    'Agendamentos de sincronização registrados',
  );

  await closeAllQueues();
  await redisConnection.quit();
}

main().catch((error) => {
  logger.error({ error }, 'Falha ao registrar agendamento');
  process.exit(1);
});
