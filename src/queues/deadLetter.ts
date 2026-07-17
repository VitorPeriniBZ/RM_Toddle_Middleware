import { Job, Worker } from 'bullmq';
import { deadLetterQueue } from './queues';
import { logger } from '../utils/logger';

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
  });
}
