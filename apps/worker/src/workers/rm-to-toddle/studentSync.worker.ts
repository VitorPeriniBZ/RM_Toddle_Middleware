import { Job, Worker } from 'bullmq';
import { redisConnection } from '@rm-toddle/queues';
import { QUEUE, STUDENT_JOB } from '@rm-toddle/queues';
import { wireDeadLetterQueue } from '@rm-toddle/queues';
import { closeAllQueues } from '@rm-toddle/queues';
import { manterAgendamento } from '../../agenda/reconciliar';
import { ligarCanario } from '../../agenda/canarioDeSentencas';
import { ligarVigia } from '../../agenda/vigia';
import { ligarDetectores } from '../../continuo/detectores';
import { comTravaDoRm } from '../../continuo/travaNosJobs';
import { pgPool, registrarEvento } from '@rm-toddle/db';
import { closeRmSqlPool, observarRestauroAutomatico } from '@rm-toddle/integrations';
import {
  processStudentExtract,
  processStudentUpsertBatch,
} from './studentSync.processor';
import { processStaffSync } from './staffSync.processor';
import { processTermGradesSync } from '../toddle-to-rm/termGrades.processor';
import { processAttendanceSync } from '../toddle-to-rm/attendance.processor';
import { processCourseSync } from './courseSync.processor';
import { ATTENDANCE_JOB, COURSE_JOB, STAFF_JOB, TERM_GRADE_JOB } from '@rm-toddle/queues';
import { conferirCanalDeAviso, env, heartbeat, logger } from '@rm-toddle/config';

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
  comTravaDoRm(async (job: Job) => {
    switch (job.name) {
      case STUDENT_JOB.EXTRACT:
        return processStudentExtract(job);
      case STUDENT_JOB.UPSERT_BATCH:
        return processStudentUpsertBatch(job);
      default:
        throw new Error(`Job desconhecido na fila de alunos: ${job.name}`);
    }
  }),
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
  comTravaDoRm(async (job: Job) => {
    switch (job.name) {
      case STAFF_JOB.SYNC:
        return processStaffSync(job);
      default:
        throw new Error(`Job desconhecido na fila de professores: ${job.name}`);
    }
  }),
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
  comTravaDoRm(async (job: Job) => {
    switch (job.name) {
      case TERM_GRADE_JOB.SYNC:
        return processTermGradesSync(job);
      default:
        throw new Error(`Job desconhecido na fila de notas: ${job.name}`);
    }
  }),
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
  comTravaDoRm(async (job: Job) => {
    switch (job.name) {
      case COURSE_JOB.SYNC:
        return processCourseSync(job);
      default:
        throw new Error(`Job desconhecido na fila de turmas: ${job.name}`);
    }
  }),
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
  comTravaDoRm(async (job: Job) => {
    switch (job.name) {
      case ATTENDANCE_JOB.SYNC:
        return processAttendanceSync(job);
      default:
        throw new Error(`Job desconhecido na fila de frequência: ${job.name}`);
    }
  }),
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

/*
 * ─── O VIGIA GRITA PARA ONDE? ────────────────────────────────────────────────
 *
 * A pergunta que faltava fazer. O vigia acima roda, encontra o problema e chama
 * `alertar()` — e `alertar()` devolvia `false` calado quando não havia webhook,
 * que era o caso em todo lugar. Três mecanismos de aviso bem desenhados, todos
 * mudos, e ninguém tinha como perceber porque a mudez era o comportamento
 * documentado de cada um.
 *
 * Esta linha é o que torna essa situação visível no segundo em que o worker
 * sobe, em vez de no dia em que alguém for procurar por que não foi avisado.
 */
conferirCanalDeAviso('worker');

/*
 * O canário das Sentenças. Ver apps/worker/src/agenda/canarioDeSentencas.ts.
 *
 * O vigia acima pergunta se os JOBS estão rodando. Esta é a pergunta anterior:
 * as Sentenças que os jobs leem ainda são as que o repositório conhece? Elas
 * moram no RM, somem a cada cópia de base, e o restauro automático pode
 * recolocar uma versão ATRÁS — sem um commit, sem um erro.
 */
const pararCanario = ligarCanario();

/*
 * TEMPO QUASE REAL. Ver apps/worker/src/continuo/detectores.ts.
 *
 * Os detectores perguntam "mudou algo?" a cada minuto e, quando sim, enfileiram
 * o MESMO job que o cron enfileiraria. Cada um obedece a própria linha em
 * `fluxo_continuo`, e todas nascem desligadas: subir este processo não liga
 * nada que alguém não tenha ligado pela tela.
 */
const pararDetectores = ligarDetectores();

/*
 * A TRILHA DO QUE O MIDDLEWARE ESCREVEU NO RM SOZINHO.
 *
 * O restauro automático de Sentença acontece lá embaixo, dentro do cliente do
 * `wsConsultaSQL`, que não conhece banco — de propósito, senão o adaptador do RM
 * passaria a exigir Postgres para ser importado. O gancho é registrado AQUI, no
 * processo que já tem pool e tenant.
 *
 * Vale para todo desfecho, inclusive os que não escrevem nada: "a Sentença
 * sumiu e foi recolocada às 3h" e "a Sentença estava lá e o RM recusou assim
 * mesmo" são as duas respostas que alguém vai querer da manhã seguinte, e
 * nenhuma das duas sobrevive só no log de container.
 *
 * `ator` é `worker:...` (o formato que a migration 006 define) e não uma pessoa:
 * quem olhar a auditoria precisa distinguir na hora o que um humano decidiu do
 * que a máquina fez sozinha.
 */
observarRestauroAutomatico(async ({ codigo, desfecho, detalhe }) => {
  await registrarEvento(pgPool, {
    ator: 'worker:restauro-automatico',
    acao: 'sentenca.restauro.automatico',
    entidade: 'GCONSSQL',
    entidadeId: codigo,
    depois: { desfecho, detalhe },
    resultado: desfecho,
    motivo: 'Sentença recusada pelo RM durante um job agendado',
  }).catch((err) => logger.warn({ err, codigo }, 'não consegui auditar o restauro automático'));
});

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
    pararCanario();
    // O sinal de parada dos detectores sai AGORA (é síncrono), mas a espera pela
    // volta em curso corre em PARALELO com o fechamento dos workers: esperá-la
    // antes comeria o prazo de parada do container, e um job de nota de 40–58 s
    // no meio de uma escrita no RM levaria `kill -9`. Um detector que ainda
    // enfileire no meio do encerramento deixa o job no Redis para a próxima
    // subida — o que é inofensivo.
    const detectoresParados = pararDetectores();
    await pararAgendamento();
    // TODOS os workers, e a lista precisa crescer junto com eles: um worker
    // esquecido aqui é um job morto no meio de uma escrita no Toddle ou no RM
    // quando o container reinicia — que é exatamente o estado ambíguo que o
    // `SaveRecord` sem resposta já produz sozinho.
    await Promise.all([
      detectoresParados,
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
