import { Job } from 'bullmq';
import { deadLetterQueue, getQueue, closeAllQueues } from '@rm-toddle/queues';
import { DeadLetterPayload } from '@rm-toddle/queues';
import { redisConnection } from '@rm-toddle/queues';
import { logger } from '@rm-toddle/config';

/**
 * Reprocessamento MANUAL da Dead Letter Queue (requisito de resiliência).
 *
 * Uso:
 *   npm run dlq -- list                  # lista jobs mortos
 *   npm run dlq -- reprocess <dlqJobId>  # devolve um job à fila de origem
 *   npm run dlq -- reprocess --all       # devolve todos
 *   npm run dlq -- remove <dlqJobId>     # DESCARTA um job, sem reprocessar
 *
 * `remove` existe para o caso "a causa já foi corrigida e reprocessar seria
 * redundante" — sem ele, entrada obsoleta fica na DLQ para sempre e treina o
 * time a ignorar a lista, que é justamente onde os erros de verdade aparecem.
 * Ele DESCARTA dado: registra o payload no log antes de apagar, para o motivo
 * não se perder junto. Não tem `--all` de propósito — descarte em massa é como
 * se perde uma falha real no meio.
 */
async function listDlq(): Promise<Job<DeadLetterPayload>[]> {
  return deadLetterQueue.getJobs(['waiting', 'delayed', 'paused'], 0, 200) as Promise<
    Job<DeadLetterPayload>[]
  >;
}

async function reprocess(job: Job<DeadLetterPayload>): Promise<void> {
  const p = job.data;
  await getQueue(p.sourceQueue).add(p.jobName, p.data);
  await job.remove();
  logger.info(
    { dlqJobId: job.id, sourceQueue: p.sourceQueue, jobName: p.jobName },
    'Job devolvido à fila de origem',
  );
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (command === 'list') {
    const jobs = await listDlq();
    if (jobs.length === 0) {
      logger.info('DLQ vazia 🎉');
    }
    for (const job of jobs) {
      const p = job.data;
      logger.info(
        {
          dlqJobId: job.id,
          sourceQueue: p.sourceQueue,
          jobName: p.jobName,
          failedAt: p.failedAt,
          attemptsMade: p.attemptsMade,
          failedReason: p.failedReason,
        },
        'Job na DLQ',
      );
    }
  } else if (command === 'reprocess' && arg === '--all') {
    const jobs = await listDlq();
    for (const job of jobs) await reprocess(job);
    logger.info({ total: jobs.length }, 'Reprocessamento em massa concluído');
  } else if (command === 'reprocess' && arg) {
    const job = (await deadLetterQueue.getJob(arg)) as Job<DeadLetterPayload> | undefined;
    if (!job) {
      logger.error({ dlqJobId: arg }, 'Job não encontrado na DLQ');
      process.exitCode = 1;
    } else {
      await reprocess(job);
    }
  } else if (command === 'remove' && arg) {
    const job = (await deadLetterQueue.getJob(arg)) as Job<DeadLetterPayload> | undefined;
    if (!job) {
      logger.error({ dlqJobId: arg }, 'Job não encontrado na DLQ');
      process.exitCode = 1;
    } else {
      const p = job.data;
      // Log ANTES de apagar: o descarte não pode levar o motivo com ele.
      logger.warn(
        {
          dlqJobId: job.id,
          sourceQueue: p.sourceQueue,
          jobName: p.jobName,
          failedAt: p.failedAt,
          attemptsMade: p.attemptsMade,
          failedReason: p.failedReason,
          data: p.data,
        },
        'Job DESCARTADO da DLQ sem reprocessar',
      );
      await job.remove();
    }
  } else {
    logger.info(
      'Uso: npm run dlq -- list | reprocess <dlqJobId> | reprocess --all | remove <dlqJobId>',
    );
  }

  await closeAllQueues();
  await redisConnection.quit();
}

main().catch((error) => {
  logger.error({ error }, 'Falha no comando de DLQ');
  process.exit(1);
});
