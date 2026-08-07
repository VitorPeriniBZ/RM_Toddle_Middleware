import { env, logger } from '@rm-toddle/config';
import { getQueue } from './queues';
import { QUEUE, STUDENT_JOB } from './names';
import { redisConnection } from './connection';

/**
 * DEFINIÇÃO ÚNICA dos agendamentos recorrentes.
 *
 * Mora aqui, e não no script `scheduleJobs.ts`, porque DOIS lugares registram o
 * mesmo scheduler: o script (`npm run schedule`) e o startup do worker. Com a
 * definição duplicada, mudar o cron num lado deixaria dois schedulers vivos com
 * horários diferentes — e o sync rodaria duas vezes por noite.
 */
export const SCHEDULER = {
  STUDENTS_NIGHTLY: 'students-sync-nightly',
} as const;

/**
 * Registra (upsert) o agendamento noturno de alunos.
 *
 * Idempotente: o BullMQ faz upsert pelo id do scheduler, então chamar N vezes
 * não duplica nem reinicia a contagem.
 */
export async function upsertStudentsNightly(): Promise<void> {
  const queue = getQueue(QUEUE.RM_TO_TODDLE_STUDENTS);
  await queue.upsertJobScheduler(
    SCHEDULER.STUDENTS_NIGHTLY,
    { pattern: env.STUDENTS_SYNC_CRON, tz: 'America/Sao_Paulo' },
    { name: STUDENT_JOB.EXTRACT, data: { trigger: 'cron' } },
  );
}

/**
 * Mantém o agendamento vivo enquanto o worker estiver de pé.
 *
 * O PROBLEMA que isto resolve: o registro do scheduler vive SÓ no Redis. Se o
 * Redis reiniciar sem persistência, o `students-sync-nightly` desaparece e
 * **nada dá erro** — o worker segue de pé, saudável, consumindo uma fila que
 * nunca mais recebe nada. Você descobre quando notar que o Toddle parou de
 * atualizar, dias depois.
 *
 * Por que no evento `ready` e não só no boot: quando o Redis reinicia, o worker
 * NÃO reinicia — ele reconecta. Registrar apenas no startup não cobriria
 * justamente o caso que motivou esta função. O ioredis emite `ready` na conexão
 * inicial E em cada reconexão, então um único listener cobre os dois.
 *
 * Falha aqui NÃO derruba o worker: consumir a fila é mais importante que manter
 * o agendamento, e o próximo `ready` tenta de novo. Mas o erro é logado alto,
 * porque um agendamento ausente é invisível por natureza.
 */
export function manterAgendamentoDeAlunos(): void {
  let emAndamento = false;

  const registrar = async (motivo: string): Promise<void> => {
    // O 'ready' pode disparar em rajada numa reconexão instável; sem esta guarda
    // as chamadas se sobreporiam.
    if (emAndamento) return;
    emAndamento = true;
    try {
      await upsertStudentsNightly();
      logger.info(
        { scheduler: SCHEDULER.STUDENTS_NIGHTLY, cron: env.STUDENTS_SYNC_CRON, tz: 'America/Sao_Paulo', motivo },
        'Agendamento noturno garantido',
      );
    } catch (error) {
      logger.error(
        { error, scheduler: SCHEDULER.STUDENTS_NIGHTLY, motivo },
        'FALHA ao garantir o agendamento noturno — o sync das 3h pode não disparar. ' +
          'Rode `npm run schedule` e confira com `redis-cli zrange bull:rm-to-toddle.students:repeat 0 -1`.',
      );
    } finally {
      emAndamento = false;
    }
  };

  // Se a conexão já estava pronta antes deste listener existir, o 'ready' dela
  // já passou e não voltaria — daí a chamada imediata.
  if (redisConnection.status === 'ready') {
    void registrar('boot');
  }

  redisConnection.on('ready', () => {
    void registrar('redis-ready');
  });
}
