import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/client.js';
import type { User } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
  }
  
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
}

export const fastify = Fastify({
  logger,
  requestIdLogLabel: 'reqId',
  disableRequestLogging: false,
  trustProxy: true,
});

await fastify.register(cors, {
  origin: config.cors.origin,
  credentials: true,
});

await fastify.register(jwt, {
  secret: config.auth.jwtSecret,
});

fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
  try {
    let token: string | undefined;
    
    if (request.headers.authorization?.startsWith('Bearer ')) {
      token = request.headers.authorization.substring(7);
    } else if (request.query && typeof request.query === 'object' && 'token' in request.query) {
      token = request.query.token as string;
    } else if (request.cookies?.token) {
      token = request.cookies.token;
    }
    
    if (!token) {
      return reply.code(401).send({ error: 'missing_token' });
    }
    
    const decoded = fastify.jwt.verify(token) as { userId: string };
    
    const result = await pool.query<User>(
      'SELECT id, email, name, created_at as "createdAt", updated_at as "updatedAt" FROM users WHERE id = $1',
      [decoded.userId]
    );
    
    if (result.rows.length === 0) {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    
    request.user = result.rows[0];
  } catch (err) {
    return reply.code(401).send({ error: 'invalid_token' });
  }
});

fastify.get('/health', async (_request, reply) => {
  reply.send({ status: 'ok' });
});

fastify.get('/ready', async (_request, reply) => {
  try {
    await pool.query('SELECT 1');
    reply.send({ status: 'ready', database: 'ok' });
  } catch (error) {
    reply.code(503).send({ status: 'not_ready', database: 'error' });
  }
});
