import { Job, Worker } from 'bullmq';
import { deadLetterQueue } from './queues';
import { alertar, logger } from '@rm-toddle/config';

/** Formato dos registros na DLQ — carrega tudo que o reprocessamento precisa. */
export interface DeadLetterPayload {
  sourceQueue: string;
  jobName: string;
  jobId?: string;
  data: unknown;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
  stacktrace?: string;
}

/**
 * O BullMQ não tem DLQ nativa: o padrão é escutar o evento 'failed' do worker
 * e, quando o job esgotar as tentativas (attemptsMade >= attempts), copiar o
 * payload para a fila 'dead-letter'. O reprocessamento manual fica em
 * src/scripts/dlq.ts (list / reprocess).
 */
export function wireDeadLetterQueue(worker: Worker, sourceQueue: string): void {
  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!job) return; // falha sem job associado (ex.: erro de conexão)

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // ainda há retentativas pela frente

    const payload: DeadLetterPayload = {
      sourceQueue,
      jobName: job.name,
      jobId: job.id,
      data: job.data,
      failedReason: err.message,
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
      stacktrace: job.stacktrace?.[0],
    };

    deadLetterQueue
      .add('dead-letter', payload, { removeOnComplete: false, removeOnFail: false })
      .then(() => logger.warn({ sourceQueue, jobId: job.id, jobName: job.name }, 'Job movido para a DLQ'))
      .catch((dlqErr) => logger.error({ dlqErr, jobId: job.id }, 'Falha ao gravar job na DLQ'));

    // ALERTA ATIVO, e o lugar é aqui de propósito: este `if` acima é a única
    // definição de "o job morreu DE VEZ" no sistema inteiro — as três tentativas
    // acabaram. Alertar aqui cobre os três workers com uma linha, e cobre
    // qualquer worker que vier depois sem ninguém ter de lembrar.
    //
    // É o modo de falha que o heartbeat não pega: o worker segue VIVO e
    // saudável, os jobs morrem um a um. Foi assim que 62 registros ficaram na
    // DLQ por sete dias sem um único aviso.
    void alertar({
      assunto: `Job na DLQ: ${job.name} (${sourceQueue})`,
      contexto: {
        jobId: job.id,
        tentativas: job.attemptsMade,
        motivo: err.message.slice(0, 300),
        comoVer: 'npm run dlq',
      },
    });
  });
}

export interface ResumoDaDlq {
  /** Quantos registros estão na DLQ agora. É o número que a tela mostra em destaque. */
  total: number;
  /** Os mais recentes, para dizer O QUE quebrou sem abrir o Redis. */
  recentes: Array<{
    jobId?: string;
    sourceQueue: string;
    jobName: string;
    failedReason: string;
    failedAt: string;
  }>;
}

/**
 * O que está na DLQ, para a tela e para o alerta.
 *
 * ─── POR QUE ISTO NÃO EXISTIA, E POR QUE PASSOU A IMPORTAR ──────────────────
 *
 * A DLQ tinha 62 registros, nenhum consumidor e nenhum canal de alerta — e foi
 * por isso que sete dias mortos passaram batido. O `npm run dlq` já listava, mas
 * ler exige alguém lembrar de olhar, e "alguém lembra" é a suposição que falhou.
 *
 * Devolver o total junto dos mais recentes é deliberado: o total sozinho diz que
 * algo está errado, e os recentes dizem o quê — sem o segundo, a tela obriga a
 * abrir o terminal de novo, e a informação continua a um passo de distância.
 */
export async function resumoDaDlq(quantosRecentes = 5): Promise<ResumoDaDlq> {
  // `waiting` é onde os registros ficam: nada consome a DLQ, então eles nunca
  // saem desse estado. Somar os outros contadores cobriria o dia em que um
  // consumidor existir, sem depender de lembrar de mudar isto aqui.
  const contagens = await deadLetterQueue.getJobCounts('waiting', 'delayed', 'failed', 'active');
  const total = Object.values(contagens).reduce((soma, n) => soma + (n ?? 0), 0);

  const jobs = await deadLetterQueue.getJobs(['waiting', 'delayed', 'failed', 'active'], 0, quantosRecentes - 1);
  return {
    total,
    recentes: jobs.map((j) => {
      const d = (j.data ?? {}) as Partial<DeadLetterPayload>;
      return {
        jobId: d.jobId,
        sourceQueue: d.sourceQueue ?? '(desconhecida)',
        jobName: d.jobName ?? j.name,
        failedReason: (d.failedReason ?? '').slice(0, 300),
        failedAt: d.failedAt ?? new Date(j.timestamp).toISOString(),
      };
    }),
  };
}
