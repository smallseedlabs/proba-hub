import { createClient } from 'redis';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const redisClient = createClient({
  url: config.redis.url,
});

export const redisPub = createClient({
  url: config.redis.url,
});

export const redisSub = createClient({
  url: config.redis.url,
});

redisClient.on('error', (err) => {
  logger.error({ err }, 'Redis client error');
});

redisPub.on('error', (err) => {
  logger.error({ err }, 'Redis pub error');
});

redisSub.on('error', (err) => {
  logger.error({ err }, 'Redis sub error');
});

await Promise.all([
  redisClient.connect(),
  redisPub.connect(),
  redisSub.connect(),
]);

logger.info('Redis clients connected');

export async function shutdown(): Promise<void> {
  await Promise.all([
    redisClient.quit(),
    redisPub.quit(),
    redisSub.quit(),
  ]);
}
