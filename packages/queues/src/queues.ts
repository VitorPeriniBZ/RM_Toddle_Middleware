import { Queue, DefaultJobOptions } from 'bullmq';
import { redisConnection } from './connection';
import { QUEUE } from './names';

/**
 * Resiliência exigida pelo projeto: 3 tentativas com backoff exponencial
 * (5s -> 10s -> 20s). Esgotadas as tentativas, o listener em deadLetter.ts
 * copia o payload para a DLQ para reprocessamento manual.
 */
export const defaultJobOptions: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 }, // o payload também é preservado na DLQ
};

const registry = new Map<string, Queue>();

/** A DLQ não usa as opções default (retentar um job morto não faz sentido). */
export const deadLetterQueue = new Queue(QUEUE.DEAD_LETTER, {
  connection: redisConnection,
});

/** Factory com cache: uma instância de Queue por nome, com as opções padrão. */
export function getQueue(name: string): Queue {
  if (name === QUEUE.DEAD_LETTER) return deadLetterQueue;
  let queue = registry.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: redisConnection, defaultJobOptions });
    registry.set(name, queue);
  }
  return queue;
}

export async function closeAllQueues(): Promise<void> {
  for (const queue of registry.values()) await queue.close();
  await deadLetterQueue.close();
}
