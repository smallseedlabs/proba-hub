import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/client.js';
import type { User } from './types.js';
import { hashToken } from './auth/tokens.js';
import { TRACE_HEADER, currentTrace, newTraceContext, runWithTrace, setTraceUser } from './audit/trace.js';
import { auditAuthDenied } from './audit/auth-denied.js';
import { getAudit } from './audit/service.js';

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
    /** Context bridge HTTP client (POST /v1/context/build). */
    contextClient: import('./brain/context-client.js').ContextClient;
    /** Act-as minting and context-reader verification. */
    assertionAuth: import('./auth/assertions/index.js').ContextBridgeHubAuth;
    /** Command processor (brain + bridge wiring). */
    commandProcessor: import('./services/command-processor.js').CommandProcessor;
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
    // Fastify's own request lines are logged before any hook runs, so they could not
    // carry the traceId. The onResponse hook below logs one line per request instead.
    disableRequestLogging: true,
    trustProxy: true,
  });

  // First hook: open the request's trace context. Everything that runs for this
  // request (handlers, the command processor, the brain, DB writes, logs) sees it
  // through AsyncLocalStorage. `done` must be called inside run() so the context
  // flows into the next hooks and the handler.
  fastify.addHook('onRequest', (_request, reply, done) => {
    const ctx = newTraceContext();
    reply.header(TRACE_HEADER, ctx.traceId);
    runWithTrace(ctx, done);
  });

  // The command route may re-root the trace in clientMsgId after parsing the body,
  // so the header is set again from the final value.
  fastify.addHook('onSend', async (_request, reply, payload) => {
    const trace = currentTrace();
    if (trace) reply.header(TRACE_HEADER, trace.traceId);
    return payload;
  });

  fastify.addHook('onResponse', async (request, reply) => {
    request.log.info(
      { req: request, res: reply, responseTime: reply.elapsedTime },
      'request completed'
    );
  });

  // Unhandled errors (5xx) are audited as system.error. Best effort: if the
  // database is the problem, this must not make it worse.
  fastify.addHook('onError', async (request, _reply, error) => {
    if ((error.statusCode ?? 500) < 500) return;
    await getAudit().emit(
      {
        action: 'system.error',
        outcome: 'failure',
        root: true,
        actor: { type: 'service', id: 'hub' },
        target: { type: 'route', id: `${request.method} ${request.routeOptions?.url ?? 'unknown'}` },
        errorCode: error.code ?? 'unhandled_error',
        errorMessage: error.message,
        details: { component: 'http', statusCode: error.statusCode ?? 500 },
      },
      { bestEffort: true }
    );
  });

  await fastify.register(cors, {
    origin: config.cors.origin,
    credentials: true,
    exposedHeaders: [TRACE_HEADER],
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
        await auditAuthDenied(request, 'missing_token');
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
        await auditAuthDenied(request, 'invalid_token');
        return reply.code(401).send({ error: 'invalid_token' });
      }

      request.sessionTokenHash = tokenHash;
      request.user = result.rows[0];
      setTraceUser(request.user.id);
    } catch (err) {
      await auditAuthDenied(request, 'invalid_token');
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
