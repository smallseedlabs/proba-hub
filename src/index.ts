import { config } from './config.js';
import { logger } from './logger.js';
import { shutdown as shutdownDb } from './db/client.js';
import { shutdown as shutdownRedis } from './services/redis.js';
import { buildApp } from './app.js';

const fastify = await buildApp({ startBackgroundJobs: true });

const signals = ['SIGINT', 'SIGTERM'];

signals.forEach((signal) => {
  process.on(signal, async () => {
    logger.info({ signal }, 'Received shutdown signal');
    
    try {
      await fastify.close();
      await shutdownDb();
      await shutdownRedis();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  });
});

try {
  await fastify.listen({
    port: config.server.port,
    host: config.server.host,
  });
  
  logger.info(
    {
      port: config.server.port,
      host: config.server.host,
      env: config.env,
    },
    'Server started'
  );
} catch (err) {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
}
