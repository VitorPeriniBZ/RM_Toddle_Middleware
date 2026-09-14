import { Job, Worker } from 'bullmq';
import { redisConnection } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { wireDeadLetterQueue } from '@rm-toddle/queues';
import { closeAllQueues } from '@rm-toddle/queues';
import { manterAgendamento } from '../../agenda/reconciliar';
import { ligarVigia } from '../../agenda/vigia';
import { pgPool } from '@rm-toddle/db';
import { closeRmSqlPool } from '@rm-toddle/integrations';
import {
  processStudentExtract,
  processStudentUpsertBatch,
} from './studentSync.processor';
import { processStaffSync } from './staffSync.processor';
import { processTermGradesSync } from '../toddle-to-rm/termGrades.processor';
import { processAttendanceSync } from '../toddle-to-rm/attendance.processor';
import { processCourseSync } from './courseSync.processor';
import { ATTENDANCE_JOB, COURSE_JOB, STAFF_JOB, TERM_GRADE_JOB } from '@rm-toddle/queues';
import { env, heartbeat, logger } from '@rm-toddle/config';

/**
 * O job esgotou as tentativas? Só então a falha é definitiva.
 *
 * O evento `failed` do BullMQ dispara em CADA tentativa. Pingar `/fail` na
 * primeira faria o monitor externo alertar por um erro de rede que a segunda
 * tentativa resolveria sozinha — e alerta que grita por nada é alerta que passa a
 * ser ignorado. Mesma condição que a DLQ usa para decidir se copia o job.
 */
function esgotouTentativas(job: Job | undefined): boolean {
  if (!job) return false; // falha sem job associado (ex.: erro de conexão)
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Worker da fila `rm-to-toddle.students`.
 * Rodar com: npm run worker:students
 *
 * - concurrency 1 + limiter 2 req/s: medido em 2026-07-31 — com concurrency 3
 *   e 5 req/s o Toddle devolveu HTTP 429 em massa e 3 lotes foram para a DLQ.
 *   Os limites do Toddle não são documentados; estes valores sincronizaram 510
 *   alunos sem rate limit. O cliente ainda retenta 429/5xx por conta própria
 *   (ToddleClient.withRetry), então isto é a primeira linha de defesa, não a
 *   única.
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
    concurrency: 1,
    limiter: { max: 2, duration: 1_000 },
  },
);

/**
 * Worker da fila `rm-to-toddle.staff` — MESMO PROCESSO, fila separada.
 *
 * Um `Worker` do BullMQ é por fila, então professor precisa do seu. Fica aqui em
 * vez de num container próprio porque o volume é ínfimo (35 professores, ~200
 * turma-disciplina) e um segundo serviço traria supervisão, deploy e log
 * duplicados para nada.
 *
 * `concurrency: 1` e sem limiter: o job já serializa suas chamadas internamente
 * (`comPaciencia` + intervalo de 250ms), e os dois syncs são escalonados com 30
 * min de folga justamente para não competirem pela janela de rate limit do
 * Toddle — ver `cronDoProfessor` em packages/queues/src/schedulers.ts.
 */
const staffWorker = new Worker(
  QUEUE.RM_TO_TODDLE_STAFF,
  async (job: Job) => {
    switch (job.name) {
      case STAFF_JOB.SYNC:
        return processStaffSync(job);
      default:
        throw new Error(`Job desconhecido na fila de professores: ${job.name}`);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

/**
 * Worker da fila `toddle-to-rm.term-grades` — a VIA DE VOLTA da nota.
 *
 * Mesmo processo, terceira fila. Fica aqui pelo mesmo motivo que o de professor:
 * o volume é pequeno (uma passada por meia hora, lendo ~250 alunos) e um
 * container próprio traria supervisão, deploy e log duplicados para nada.
 *
 * `concurrency: 1` e sem limiter, e aqui isso NÃO é economia: duas passadas
 * simultâneas leriam o mesmo estado do RM, decidiriam em cima dele e escreveriam
 * as mesmas chaves — o guarda de proveniência veria "não é nosso" nas duas e o
 * resultado dependeria da ordem. A serialização é parte da correção, não do
 * desempenho.
 */
const termGradesWorker = new Worker(
  QUEUE.TODDLE_TO_RM_TERM_GRADES,
  async (job: Job) => {
    switch (job.name) {
      case TERM_GRADE_JOB.SYNC:
        return processTermGradesSync(job);
      default:
        throw new Error(`Job desconhecido na fila de notas: ${job.name}`);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

/**
 * Worker da fila `rm-to-toddle.courses` — TURMA E DISCIPLINA, somente leitura.
 *
 * Quarta fila no mesmo processo, pelo mesmo motivo das outras: o volume é ínfimo
 * (uma passada por dia, ~670 turma-disciplina lidas de uma vez) e um container
 * próprio traria supervisão, deploy e log duplicados para nada.
 *
 * `concurrency: 1`: duas reconciliações simultâneas leriam o mesmo RM e
 * chegariam ao mesmo relatório, gastando duas vezes a janela de 300s do Toddle
 * para nada.
 */
const coursesWorker = new Worker(
  QUEUE.RM_TO_TODDLE_COURSES,
  async (job: Job) => {
    switch (job.name) {
      case COURSE_JOB.SYNC:
        return processCourseSync(job);
      default:
        throw new Error(`Job desconhecido na fila de turmas: ${job.name}`);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

/**
 * Worker da fila `toddle-to-rm.attendance` — a VIA DE VOLTA da frequência.
 *
 * `concurrency: 1`, e aqui isso NÃO é economia, é correção: duas passadas
 * simultâneas leriam o mesmo estado do RM, decidiriam em cima dele e escreveriam
 * as mesmas chaves — o guarda de proveniência veria "não é nosso" nas duas e o
 * resultado dependeria da ordem. Pior que na nota, porque `PRESENCA='P'` REMOVE
 * a falta em vez de sobrescrever um valor.
 */
const attendanceWorker = new Worker(
  QUEUE.TODDLE_TO_RM_ATTENDANCE,
  async (job: Job) => {
    switch (job.name) {
      case ATTENDANCE_JOB.SYNC:
        return processAttendanceSync(job);
      default:
        throw new Error(`Job desconhecido na fila de frequência: ${job.name}`);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

// Jobs que esgotarem as 3 tentativas vão para a fila 'dead-letter'.
wireDeadLetterQueue(worker, QUEUE.RM_TO_TODDLE_STUDENTS);
wireDeadLetterQueue(staffWorker, QUEUE.RM_TO_TODDLE_STAFF);
wireDeadLetterQueue(termGradesWorker, QUEUE.TODDLE_TO_RM_TERM_GRADES);
wireDeadLetterQueue(coursesWorker, QUEUE.RM_TO_TODDLE_COURSES);
wireDeadLetterQueue(attendanceWorker, QUEUE.TODDLE_TO_RM_ATTENDANCE);

coursesWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job de turma concluído');
});
coursesWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job de turma falhou',
  );
});
coursesWorker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker de turmas');
});

attendanceWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job de frequência concluído');
  void heartbeat.frequencia('sucesso', { jobName: job.name });
});
attendanceWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job de frequência falhou',
  );
  // Só depois de esgotar as tentativas: pingar `/fail` na primeira faria o
  // monitor alertar por erro de rede que a segunda resolveria — e alerta que
  // grita por nada é alerta que passa a ser ignorado.
  //
  // Divergência de integridade NÃO chega aqui: o processador não lança, para não
  // reenviar escrita que pode ter sido aplicada. Ela aparece no run `failed`.
  if (esgotouTentativas(job)) void heartbeat.frequencia('falha', { jobName: job?.name });
});
attendanceWorker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker de frequência');
});

termGradesWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job de nota concluído');
});
termGradesWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job de nota falhou',
  );
  // Só exceção chega aqui: divergência de integridade NÃO lança, para não
  // reenviar escrita que pode ter sido aplicada — ver termGrades.processor.ts.
  if (esgotouTentativas(job)) void heartbeat.notas('falha', { jobName: job?.name });
});
termGradesWorker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker de notas');
});

staffWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job de professor concluído');
});
staffWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job de professor falhou',
  );
  if (esgotouTentativas(job)) void heartbeat.professores('falha', { jobName: job?.name });
});
staffWorker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker de professores');
});

// O agendamento vive só no Redis. Se o Redis reiniciar sem persistir, o
// scheduler desaparece e NADA dá erro — o worker fica de pé consumindo uma fila
// que nunca mais recebe nada. A reconciliação re-registra no boot, em cada
// reconexão ao Redis, a cada aviso da tela e num poll de piso, então ele não pode
// estar ausente enquanto o worker estiver vivo. A fonte é a tabela
// `flow_schedule`, não o ambiente — ver apps/worker/src/agenda/reconciliar.ts.
const pararAgendamento = manterAgendamento();

// O vigia grita pelo que o heartbeat não pega: job morrendo com o worker VIVO.
// Foi esse o modo de falha dos 62 registros na DLQ, sete dias sem ninguém saber.
const pararVigia = ligarVigia();

worker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Job concluído');
});

worker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Job falhou',
  );
  // Cobre as duas fases: extract que não conseguiu ler o RM (foi o que ficou 8
  // dias quebrado, calado) e lote que esgotou as tentativas na escrita. Por isso
  // o ping vive aqui e não dentro de cada processador.
  if (esgotouTentativas(job)) void heartbeat.alunos('falha', { jobName: job?.name });
});

worker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker');
});

logger.info(
  {
    filas: [
      QUEUE.RM_TO_TODDLE_STUDENTS,
      QUEUE.RM_TO_TODDLE_STAFF,
      QUEUE.RM_TO_TODDLE_COURSES,
      QUEUE.TODDLE_TO_RM_TERM_GRADES,
      QUEUE.TODDLE_TO_RM_ATTENDANCE,
    ],
    notaSyncAtivo: env.NOTA_SYNC_ATIVO,
    // As duas escritas em registro acadêmico aparecem na PRIMEIRA linha do log
    // do worker, de propósito: "este processo escreve no RM?" é a pergunta que
    // se faz olhando um container que acabou de subir.
    freqSyncAtivo: env.FREQ_SYNC_ATIVO,
  },
  'Worker iniciado',
);

/** Encerramento gracioso: termina o job em andamento antes de sair. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando worker...');
  try {
    // Primeiro os temporizadores: sem parar o poll da agenda e o vigia, o
    // processo não SAI no SIGTERM (o event loop segue com timer vivo) e o
    // encerramento gracioso vira `kill -9` depois do stop_grace_period.
    pararVigia();
    await pararAgendamento();
    // TODOS os workers, e a lista precisa crescer junto com eles: um worker
    // esquecido aqui é um job morto no meio de uma escrita no Toddle ou no RM
    // quando o container reinicia — que é exatamente o estado ambíguo que o
    // `SaveRecord` sem resposta já produz sozinho.
    await Promise.all([
      worker.close(),
      staffWorker.close(),
      termGradesWorker.close(),
      coursesWorker.close(),
      attendanceWorker.close(),
    ]);
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
