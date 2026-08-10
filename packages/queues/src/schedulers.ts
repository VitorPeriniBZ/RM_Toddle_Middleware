import { env, logger } from '@rm-toddle/config';
import { getQueue } from './queues';
import { QUEUE, STAFF_JOB, STUDENT_JOB } from './names';
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
} as const;

/**
 * Cron do sync de professor. Derivado do de aluno somando 30 minutos, para os
 * dois NÃO caírem no mesmo instante.
 *
 * A razão é medida, não estética: a janela de rate limit do Toddle é de 300s
 * (ver DECISOES.md), e os dois syncs falam com a mesma organização. O de aluno
 * leva ~4 min e faz ~260 chamadas; sobrepor os dois é a receita para os dois
 * falharem. 30 min de folga cobre o pior caso do de aluno com margem larga.
 *
 * Só entende `m h * * *`, que é o formato de `STUDENTS_SYNC_CRON`. Qualquer
 * outra coisa cai no default — melhor um horário previsível que um cron
 * calculado errado em silêncio.
 */
function cronDoProfessor(cronDoAluno: string): string {
  const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(cronDoAluno.trim());
  if (!m) return '30 3 * * *';
  const minuto = Number(m[1]);
  const hora = Number(m[2]);
  const total = (hora * 60 + minuto + 30) % (24 * 60);
  return `${total % 60} ${Math.floor(total / 60)} * * *`;
}

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

/** Registra (upsert) o agendamento noturno de professores. Ver `cronDoProfessor`. */
export async function upsertStaffNightly(): Promise<void> {
  const queue = getQueue(QUEUE.RM_TO_TODDLE_STAFF);
  await queue.upsertJobScheduler(
    SCHEDULER.STAFF_NIGHTLY,
    { pattern: cronDoProfessor(env.STUDENTS_SYNC_CRON), tz: 'America/Sao_Paulo' },
    { name: STAFF_JOB.SYNC, data: { trigger: 'cron' } },
  );
}

/** O cron efetivo do professor, para log e diagnóstico. */
export function cronDoProfessorEfetivo(): string {
  return cronDoProfessor(env.STUDENTS_SYNC_CRON);
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
      logger.info(
        {
          scheduler: [SCHEDULER.STUDENTS_NIGHTLY, SCHEDULER.STAFF_NIGHTLY],
          cronAlunos: env.STUDENTS_SYNC_CRON,
          cronProfessores: cronDoProfessorEfetivo(),
          tz: 'America/Sao_Paulo',
          motivo,
        },
        'Agendamentos noturnos garantidos',
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
