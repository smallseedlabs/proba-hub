import type { FastifyInstance } from 'fastify';
import { createServer } from './server.js';
import { config } from './config.js';
import { authRoutes, devAuthRoutes, type AuthRoutesOptions } from './routes/auth.js';
import { commandRoutes } from './routes/commands.js';
import { eventRoutes } from './routes/events.js';
import { readRoutes } from './routes/reads.js';
import { startOutboxRelay, stopOutboxRelay } from './services/outbox-relay.js';
import { startAskExpiryJob, stopAskExpiryJob } from './services/ask-expiry.js';
import { CommandProcessor } from './services/command-processor.js';
import { MockBrain } from './brain/mock-brain.js';
import type { BrainPort } from './types.js';

export interface AppOptions {
  /** Start outbox relay + ask expiry jobs (default true). */
  startBackgroundJobs?: boolean;
  /** Mock brain scenario name. Defaults to config.brain.scenario (MOCK_BRAIN_SCENARIO). */
  brainScenario?: string;
  /** Inject a brain implementation directly (takes precedence over brainScenario). */
  brain?: BrainPort;
  /** SSE heartbeat interval. Defaults to config.sse.heartbeatIntervalMs. */
  sseHeartbeatIntervalMs?: number;
  /** Sign-in rate limit overrides (tests). */
  authRateLimit?: AuthRoutesOptions;
  /** Register POST /dev/login. Defaults to config.auth.devLoginEnabled (never in production). */
  devLogin?: boolean;
}

/**
 * Build a fully wired Hub application. Every call returns a new, independent
 * Fastify instance; configuration is injected via options rather than by
 * mutating process.env.
 */
export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const fastify = await createServer();

  const brain = options.brain ?? new MockBrain(options.brainScenario ?? config.brain.scenario);
  const processor = new CommandProcessor(brain);

  if (!config.isProduction && (options.devLogin ?? config.auth.devLoginEnabled)) {
    await fastify.register(devAuthRoutes);
  }
  await fastify.register(authRoutes, { prefix: '/v1', ...options.authRateLimit });
  await fastify.register(commandRoutes, { prefix: '/v1', processor });
  await fastify.register(eventRoutes, {
    prefix: '/v1',
    heartbeatIntervalMs: options.sseHeartbeatIntervalMs ?? config.sse.heartbeatIntervalMs,
  });
  await fastify.register(readRoutes, { prefix: '/v1' });

  if (options.startBackgroundJobs !== false) {
    await startOutboxRelay();
    startAskExpiryJob();
    fastify.addHook('onClose', async () => {
      await stopOutboxRelay();
      stopAskExpiryJob();
    });
  }

  return fastify;
}
