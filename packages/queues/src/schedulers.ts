import { env, logger, cronDoProfessorEfetivo } from '@rm-toddle/config';
import { getQueue } from './queues';
import { QUEUE, STAFF_JOB, STUDENT_JOB, TERM_GRADE_JOB } from './names';
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
  STAFF_NIGHTLY: 'staff-sync-nightly',
  TERM_GRADES_POLL: 'term-grades-poll',
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

/** Registra (upsert) o agendamento noturno de professores. Cron derivado em packages/config/src/cronProfessor.ts. */
export async function upsertStaffNightly(): Promise<void> {
  const queue = getQueue(QUEUE.RM_TO_TODDLE_STAFF);
  await queue.upsertJobScheduler(
    SCHEDULER.STAFF_NIGHTLY,
    { pattern: cronDoProfessorEfetivo(), tz: 'America/Sao_Paulo' },
    { name: STAFF_JOB.SYNC, data: { trigger: 'cron' } },
  );
}

/**
 * Registra (ou REMOVE) o poll da via de nota, conforme `NOTA_SYNC_ATIVO`.
 *
 * ─── POR QUE REMOVER TAMBÉM ─────────────────────────────────────────────────
 *
 * O scheduler vive no Redis, não no código. Desligar `NOTA_SYNC_ATIVO` e só
 * "deixar de registrar" NÃO para nada: o registro anterior continua lá e o cron
 * segue disparando. O processador ainda recusaria por conta própria, mas a
 * escola veria job rodando de meia em meia hora depois de pedir para desligar —
 * e desconfiaria, com razão, de tudo o mais que dissemos estar desligado.
 *
 * Por isso o interruptor é de duas vias: liga registrando, desliga removendo.
 *
 * ─── POR QUE NÃO É "NOTURNO" ────────────────────────────────────────────────
 *
 * Aluno e professor rodam 4x ao dia porque cadastro muda devagar. Nota muda
 * quando o professor digita, e o pedido é que chegue ao RM perto disso. A API do
 * Toddle não tem webhook (verificado na referência inteira em 09/09/2026), então
 * o mais próximo possível é um poll curto na janela em que gente trabalha.
 */
export async function upsertTermGradesPoll(): Promise<void> {
  const queue = getQueue(QUEUE.TODDLE_TO_RM_TERM_GRADES);

  if (!env.NOTA_SYNC_ATIVO) {
    await queue.removeJobScheduler(SCHEDULER.TERM_GRADES_POLL).catch(() => undefined);
    return;
  }

  await queue.upsertJobScheduler(
    SCHEDULER.TERM_GRADES_POLL,
    { pattern: env.NOTA_SYNC_CRON, tz: 'America/Sao_Paulo' },
    { name: TERM_GRADE_JOB.SYNC, data: { trigger: 'cron' } },
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
      // Os DOIS agendamentos, na mesma função: professor vive na mesma janela de
      // perda que aluno (existe só no Redis) e teria o mesmo modo de falha
      // silenciosa se ficasse de fora daqui.
      await upsertStudentsNightly();
      await upsertStaffNightly();
      // A via de nota entra aqui pelo mesmo motivo que professor: o registro
      // dela vive só no Redis e teria o mesmo modo de falha silenciosa se
      // ficasse de fora. Esta chamada também REMOVE o scheduler quando
      // NOTA_SYNC_ATIVO estiver desligado — ver upsertTermGradesPoll.
      await upsertTermGradesPoll();
      logger.info(
        {
          scheduler: [SCHEDULER.STUDENTS_NIGHTLY, SCHEDULER.STAFF_NIGHTLY],
          cronAlunos: env.STUDENTS_SYNC_CRON,
          cronProfessores: cronDoProfessorEfetivo(),
          notaSyncAtivo: env.NOTA_SYNC_ATIVO,
          cronNotas: env.NOTA_SYNC_ATIVO ? env.NOTA_SYNC_CRON : null,
          tz: 'America/Sao_Paulo',
          motivo,
        },
        'Agendamentos garantidos',
      );
    } catch (error) {
      logger.error(
        { error, motivo },
        'FALHA ao garantir os agendamentos noturnos — o sync pode não disparar. ' +
          'Rode `npm run schedule` e confira com ' +
          '`redis-cli zrange bull:rm-to-toddle.students:repeat 0 -1` e ' +
          '`redis-cli zrange bull:rm-to-toddle.staff:repeat 0 -1`.',
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
