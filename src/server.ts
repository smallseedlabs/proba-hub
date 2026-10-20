import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/client.js';
import type { User } from './types.js';
import { hashToken } from './auth/tokens.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: User;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<void>;
  }
  interface FastifyRequest {
    /** SHA-256 of the bearer token that authenticated this request. */
    sessionTokenHash?: string;
  }
}

/**
 * Create a new Fastify instance with CORS, JWT auth and health routes.
 * A factory (rather than a module-level singleton) so tests can build
 * independent instances with injected configuration.
 */
export async function createServer(): Promise<FastifyInstance> {
  const fastify: FastifyInstance = Fastify({
    logger: logger as FastifyBaseLogger,
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
      }

      if (!token) {
        return reply.code(401).send({ error: 'missing_token' });
      }

      const payload = fastify.jwt.verify<{ userId: string }>(token);
      const tokenHash = hashToken(token);

      // A valid signature is not enough: the session must still exist
      // (sign-out deletes it) and must not have expired.
      const result = await pool.query<User>(
        `SELECT u.id, u.email, u.name, u.created_at as "createdAt", u.updated_at as "updatedAt"
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.user_id = $2 AND s.expires_at > NOW()`,
        [tokenHash, payload.userId]
      );

      if (result.rows.length === 0) {
        return reply.code(401).send({ error: 'invalid_token' });
      }

      request.sessionTokenHash = tokenHash;
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

  return fastify;
}
