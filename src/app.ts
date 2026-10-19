import { fastify } from './server.js';
import { authRoutes } from './routes/auth.js';
import { commandRoutes } from './routes/commands.js';
import { eventRoutes } from './routes/events.js';
import { readRoutes } from './routes/reads.js';
import { startOutboxRelay } from './services/outbox-relay.js';
import { startAskExpiryJob } from './services/ask-expiry.js';

let initialized = false;

export async function initializeApp(options?: { startBackgroundJobs?: boolean }) {
  if (initialized) return fastify;
  
  await fastify.register(authRoutes);
  await fastify.register(commandRoutes, { prefix: '/v1' });
  await fastify.register(eventRoutes, { prefix: '/v1' });
  await fastify.register(readRoutes, { prefix: '/v1' });
  
  // Start background jobs (outbox relay, ask expiry) unless explicitly disabled
  if (options?.startBackgroundJobs !== false) {
    startOutboxRelay();
    startAskExpiryJob();
  }
  
  initialized = true;
  return fastify;
}

export { fastify };
