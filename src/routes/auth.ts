import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { User } from '../types.js';
import { verifyAgainstDummy, verifyPassword } from '../auth/password.js';
import { FixedWindowRateLimiter } from '../auth/rate-limit.js';
import { issueSession } from '../auth/sessions.js';
import { normalizeEmail } from '../auth/tokens.js';

export interface Workspace {
  id: string;
  name: string;
}

export interface LoginResponse {
  token: string;
  user: { id: string; email: string; name: string };
  workspaces: Workspace[];
  expiresAt: string;
}

interface LoginRequest {
  email: string;
  password: string;
}

interface DevLoginRequest {
  email: string;
  name?: string;
}

export interface AuthRoutesOptions {
  /** Failed attempts allowed per email per window; per-IP limit is 3x. */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

/**
 * The Hub does not model workspaces yet. Every user gets one default
 * workspace, matching the fallback proba-web uses.
 */
export const DEFAULT_WORKSPACES: Workspace[] = [{ id: 'default', name: 'My workspace' }];

const INVALID_CREDENTIALS = { error: 'invalid_credentials', message: 'Invalid email or password.' } as const;

function toPublicUser(user: Pick<User, 'id' | 'email' | 'name'>) {
  return { id: user.id, email: user.email, name: user.name };
}

function tooManyAttempts(reply: FastifyReply, retryAfter: number) {
  return reply
    .code(429)
    .header('retry-after', String(retryAfter))
    .send({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' });
}

/** Password sign-in: POST /v1/auth/login, POST /v1/auth/logout, GET /v1/auth/me. */
export async function authRoutes(fastify: FastifyInstance, opts: AuthRoutesOptions) {
  const max = opts.rateLimitMax ?? config.auth.loginRateLimitMax;
  const windowMs = opts.rateLimitWindowMs ?? config.auth.loginRateLimitWindowMs;
  const byEmail = new FixedWindowRateLimiter({ max, windowMs });
  const byIp = new FixedWindowRateLimiter({ max: max * 3, windowMs });

  fastify.post<{ Body: LoginRequest }>(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 255 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
      // Do not echo the body (password) in validation errors.
      attachValidation: true,
    },
    async (request, reply) => {
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid_request', message: 'Email and password are required.' });
      }

      const email = normalizeEmail(request.body.email);
      const emailKey = `email:${email}`;
      const ipKey = `ip:${request.ip}`;

      const retryAfter = Math.max(byEmail.retryAfter(emailKey), byIp.retryAfter(ipKey));
      if (retryAfter > 0) {
        logger.warn({ ip: request.ip }, 'Sign-in rate limited');
        return tooManyAttempts(reply, retryAfter);
      }
      byIp.hit(ipKey);

      const result = await pool.query<User & { passwordHash: string | null }>(
        `SELECT id, email, name, password_hash as "passwordHash"
         FROM users WHERE LOWER(email) = $1
         ORDER BY created_at ASC LIMIT 1`,
        [email]
      );
      const user = result.rows[0];

      const ok = user?.passwordHash
        ? await verifyPassword(request.body.password, user.passwordHash)
        : await verifyAgainstDummy(request.body.password);

      if (!ok || !user) {
        byEmail.hit(emailKey);
        logger.info({ ip: request.ip }, 'Sign-in failed');
        return reply.code(401).send(INVALID_CREDENTIALS);
      }

      byEmail.reset(emailKey);
      const session = await issueSession(fastify, user.id);
      logger.info({ userId: user.id }, 'Sign-in succeeded');

      const body: LoginResponse = {
        token: session.token,
        user: toPublicUser(user),
        workspaces: DEFAULT_WORKSPACES,
        expiresAt: session.expiresAt.toISOString(),
      };
      return reply.send(body);
    }
  );

  fastify.post('/auth/logout', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [request.sessionTokenHash]);
    logger.info({ userId: request.user?.id }, 'Signed out');
    return reply.code(204).send();
  });

  fastify.get('/auth/me', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    return reply.send({ user: toPublicUser(request.user!), workspaces: DEFAULT_WORKSPACES });
  });
}

/**
 * Password-less development login. Only registered when config.auth.devLoginEnabled
 * (never in production). Not used by proba-web.
 */
export async function devAuthRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: DevLoginRequest }>(
    '/dev/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email' },
            name: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, name = 'Dev User' } = request.body;

      let user: User;
      const existing = await pool.query<User>(
        'SELECT id, email, name, created_at as "createdAt", updated_at as "updatedAt" FROM users WHERE email = $1',
        [email]
      );

      if (existing.rows.length > 0) {
        user = existing.rows[0];
      } else {
        const created = await pool.query<User>(
          'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email, name, created_at as "createdAt", updated_at as "updatedAt"',
          [email, name]
        );
        user = created.rows[0];
      }

      const session = await issueSession(fastify, user.id);

      reply.send({
        token: session.token,
        user: toPublicUser(user),
      });
    }
  );
}
