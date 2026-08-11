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

/** Folga entre o sync de aluno e o de professor, em minutos. */
const FOLGA_MIN = 30;

/**
 * Cron do sync de professor. Derivado do de aluno somando 30 minutos, para os
 * dois NÃO caírem no mesmo instante.
 *
 * A razão é medida, não estética: a janela de rate limit do Toddle é de 300s
 * (ver DECISOES.md), e os dois syncs falam com a mesma organização. O de aluno
 * leva ~4 min e faz ~260 chamadas; sobrepor os dois é a receita para os dois
 * falharem. 30 min cobre o pior caso do de aluno com margem larga.
 *
 * Entende `m h * * *` E `m h1,h2,... * * *` — a segunda forma existe porque o
 * sync passou a rodar 4× ao dia (03:00, 09:00, 12:00, 16:00). Antes só a
 * primeira era aceita, e um cron com lista de horas cairia no default,
 * quebrando o escalonamento EM SILÊNCIO.
 *
 * Qualquer outro formato cai no default: melhor um horário previsível que um
 * cron calculado errado sem ninguém notar.
 */
function cronDoProfessor(cronDoAluno: string): string {
  const m = /^(\d{1,2})\s+(\d{1,2}(?:\s*,\s*\d{1,2})*)\s+\*\s+\*\s+\*$/.exec(cronDoAluno.trim());
  if (!m) return `${FOLGA_MIN} 3 * * *`;

  const minuto = Number(m[1]);
  const horas = m[2].split(',').map((h) => Number(h.trim()));
  if (minuto > 59 || horas.some((h) => h > 23)) return `${FOLGA_MIN} 3 * * *`;

  const somado = minuto + FOLGA_MIN;
  const novoMinuto = somado % 60;
  // Se a soma passou da hora, cada hora da lista anda uma casa (23 -> 0).
  const carrega = somado >= 60 ? 1 : 0;
  const novasHoras = horas.map((h) => (h + carrega) % 24);

  return `${novoMinuto} ${novasHoras.join(',')} * * *`;
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
