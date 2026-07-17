import { Job } from 'bullmq';
import { deadLetterQueue, getQueue, closeAllQueues } from '../queues/queues';
import { DeadLetterPayload } from '../queues/deadLetter';
import { redisConnection } from '../queues/connection';
import { logger } from '../utils/logger';

/**
 * Reprocessamento MANUAL da Dead Letter Queue (requisito de resiliência).
 *
 * Uso:
 *   npm run dlq -- list                  # lista jobs mortos
 *   npm run dlq -- reprocess <dlqJobId>  # devolve um job à fila de origem
 *   npm run dlq -- reprocess --all       # devolve todos
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
  } else {
    logger.info('Uso: npm run dlq -- list | reprocess <dlqJobId> | reprocess --all');
  }

  await closeAllQueues();
  await redisConnection.quit();
}

main().catch((error) => {
  logger.error({ error }, 'Falha no comando de DLQ');
  process.exit(1);
});
