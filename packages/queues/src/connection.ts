import IORedis from 'ioredis';
import { env } from '@rm-toddle/config';

/**
 * Conexão Redis compartilhada por filas e workers.
 * maxRetriesPerRequest: null é REQUISITO do BullMQ (comandos bloqueantes).
 */
export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
