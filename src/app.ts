import { fastify } from './server.js';
import { authRoutes } from './routes/auth.js';
import { commandRoutes } from './routes/commands.js';
import { eventRoutes } from './routes/events.js';
import { readRoutes } from './routes/reads.js';

let initialized = false;

export async function initializeApp() {
  if (initialized) return fastify;
  
  await fastify.register(authRoutes);
  await fastify.register(commandRoutes, { prefix: '/v1' });
  await fastify.register(eventRoutes, { prefix: '/v1' });
  await fastify.register(readRoutes, { prefix: '/v1' });
  
  initialized = true;
  return fastify;
}

export { fastify };
