import { createClient } from 'redis';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { assertRedisUrl } from './redis-url.js';

// Throws at startup (before any connection) when the URL is invalid or, with NODE_ENV=production, has no password.
// Checked here rather than in config.ts so one-shot jobs that never touch Redis (migrate) do not need it.
assertRedisUrl(config.redis.url, config.isProduction);

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
