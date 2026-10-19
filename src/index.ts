import { fastify } from './server.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { shutdown as shutdownDb } from './db/client.js';
import { shutdown as shutdownRedis } from './services/redis.js';
import { authRoutes } from './routes/auth.js';
import { commandRoutes } from './routes/commands.js';
import { eventRoutes } from './routes/events.js';
import { readRoutes } from './routes/reads.js';
import { startOutboxRelay } from './services/outbox-relay.js';
import { startAskExpiryJob } from './services/ask-expiry.js';

await fastify.register(authRoutes);
await fastify.register(commandRoutes, { prefix: '/v1' });
await fastify.register(eventRoutes, { prefix: '/v1' });
await fastify.register(readRoutes, { prefix: '/v1' });

startOutboxRelay();
startAskExpiryJob();

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
