import { Job, Worker } from 'bullmq';
import { redisConnection } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { wireDeadLetterQueue } from '@rm-toddle/queues';
import { closeAllQueues } from '@rm-toddle/queues';
import { manterAgendamentoDeAlunos } from '@rm-toddle/queues';
import { pgPool } from '@rm-toddle/db';
import { closeRmSqlPool } from '@rm-toddle/integrations';
import {
  processStudentExtract,
  processStudentUpsertBatch,
} from './studentSync.processor';
import { processStaffSync } from './staffSync.processor';
import { processAttendanceWrite } from '../toddle-to-rm/attendanceWrite.processor';
import { ATTENDANCE_JOB, STAFF_JOB } from '@rm-toddle/queues';
import { heartbeat, logger } from '@rm-toddle/config';

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

// Jobs que esgotarem as 3 tentativas vão para a fila 'dead-letter'.
wireDeadLetterQueue(worker, QUEUE.RM_TO_TODDLE_STUDENTS);
wireDeadLetterQueue(staffWorker, QUEUE.RM_TO_TODDLE_STAFF);

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

/**
 * Worker da fila `toddle-to-rm.attendance` — a VIA DE VOLTA.
 *
 * Mesmo processo, terceira fila. Não ganha container próprio pelo mesmo motivo do
 * de professor: é um job por dia útil, e um segundo serviço traria supervisão,
 * deploy e log duplicados para nada.
 *
 * `concurrency: 1` e sem limiter, e aqui isso não é economia — é segurança. Dois
 * runs simultâneos leriam o RM antes de o outro escrever, e ambos veriam a mesma
 * linha como ausente. A decisão de escrita depende do estado ATUAL do RM;
 * paralelismo a transforma em leitura suja.
 */
const attendanceWorker = new Worker(
  QUEUE.TODDLE_TO_RM_ATTENDANCE,
  async (job: Job) => {
    switch (job.name) {
      case ATTENDANCE_JOB.WRITE:
        return processAttendanceWrite(job);
      default:
        throw new Error(`Job desconhecido na fila de frequência: ${job.name}`);
    }
  },
  { connection: redisConnection, concurrency: 1 },
);

attendanceWorker.on('completed', (job, result) => {
  logger.info({ jobId: job.id, jobName: job.name, result }, 'Escrita de frequência concluída');
});
attendanceWorker.on('failed', (job, err) => {
  logger.error(
    { jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message },
    'Escrita de frequência falhou',
  );
});
attendanceWorker.on('error', (err) => {
  logger.error({ err }, 'Erro no worker de frequência');
});

// O agendamento noturno vive só no Redis. Se o Redis reiniciar sem persistir, o
// scheduler desaparece e NADA dá erro — o worker fica de pé consumindo uma fila
// que nunca mais recebe nada. Isto o re-registra no boot e em cada reconexão ao
// Redis, então ele não pode estar ausente enquanto o worker estiver vivo.
manterAgendamentoDeAlunos();

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
      QUEUE.TODDLE_TO_RM_ATTENDANCE,
    ],
  },
  'Workers iniciados',
);

/** Encerramento gracioso: termina o job em andamento antes de sair. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Encerrando worker...');
  try {
    // Os TRÊS workers. Faltar um significa SIGTERM matando um job no meio de uma
    // escrita — e no caso da frequência isso é pior que perder o job: o
    // `SaveRecord` já saiu, a resposta não voltou, e a linha fica num estado que
    // só a releitura desempata (SENT_UNKNOWN, §9.4 do EduFrequenciaDiariaWSData).
    await Promise.all([worker.close(), staffWorker.close(), attendanceWorker.close()]);
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
