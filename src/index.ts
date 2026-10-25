import { config } from './config.js';
import { logger } from './logger.js';
import { shutdown as shutdownDb } from './db/client.js';
import { shutdown as shutdownRedis } from './services/redis.js';
import { buildApp } from './app.js';
import { getAudit } from './audit/service.js';
import { runAsJob } from './audit/trace.js';

const fastify = await buildApp({ startBackgroundJobs: true });

const signals = ['SIGINT', 'SIGTERM'];

signals.forEach((signal) => {
  process.on(signal, async () => {
    logger.info({ signal }, 'Received shutdown signal');
    
    try {
      // Before closing, so the relay can still publish it.
      await runAsJob(() =>
        getAudit().emit(
          {
            action: 'system.stopped',
            outcome: 'success',
            root: true,
            actor: { type: 'service', id: 'hub' },
            details: { signal },
          },
          { bestEffort: true }
        )
      );
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
  await runAsJob(() =>
    getAudit().emit(
      {
        action: 'system.started',
        outcome: 'success',
        root: true,
        actor: { type: 'service', id: 'hub' },
        details: {
          env: config.env,
          auditRelayEnabled: config.audit.relayEnabled,
          auditStream: config.audit.stream,
          brainScenario: config.brain.scenario,
        },
      },
      { bestEffort: true }
    )
  );
} catch (err) {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
}
