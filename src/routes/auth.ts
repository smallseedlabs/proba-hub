import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool, transaction } from '../db/client.js';
import { config, DEFAULT_WORKSPACE_ID } from '../config.js';
import { logger } from '../logger.js';
import type { User } from '../types.js';
import { FirebaseTokenError, type FirebaseTokenVerifier } from '../auth/firebase.js';
import { resolveFirebaseUser, UserResolutionError } from '../auth/firebase-users.js';
import { FixedWindowRateLimiter } from '../auth/rate-limit.js';
import { issueSession } from '../auth/sessions.js';
import { getAudit } from '../audit/service.js';
import { auditAuthDenied } from '../audit/auth-denied.js';
import { setTraceUser } from '../audit/trace.js';
import type { PgQueryable } from '../audit/vendor/proba-audit/index.js';

/** auth.sign_in (the request's root event) + auth.session_issued, in the session's own transaction. */
async function issueAuditedSession(
  fastify: FastifyInstance,
  userId: string,
  method: 'firebase' | 'dev_login',
  details: Record<string, unknown> = {}
) {
  setTraceUser(userId);
  const audit = getAudit();
  return transaction(async (client) => {
    const session = await issueSession(fastify, userId, client as PgQueryable);
    const target = { type: 'user', id: userId };
    const signIn = await audit.emit(
      { action: 'auth.sign_in', outcome: 'success', root: true, userId, target, details: { method, ...details } },
      { tx: client }
    );
    await audit.emit(
      {
        action: 'auth.session_issued',
        outcome: 'success',
        userId,
        target,
        ...(signIn ? { parentSpanId: signIn.spanId } : {}),
        details: { method, expiresAt: session.expiresAt.toISOString() },
      },
      { tx: client }
    );
    return session;
  });
}


export interface Workspace {
  id: string;
  name: string;
}

/** Response of POST /v1/auth/session (the contract proba-web expects). */
export interface SessionResponse {
  token: string;
  user: { id: string; email: string; name: string };
  workspaces: Workspace[];
  expiresAt: string;
}

interface SessionRequest {
  idToken: string;
}

interface DevLoginRequest {
  email: string;
  name?: string;
}

export interface AuthRoutesOptions {
  /**
   * Verifies Firebase ID tokens. null when FIREBASE_PROJECT_ID is not set:
   * POST /v1/auth/session then answers 503.
   */
  firebaseVerifier: FirebaseTokenVerifier | null;
  /** Lower-case email domains allowed to sign in. Empty = any Firebase user. */
  allowedEmailDomains?: readonly string[];
  /** Failed session exchanges allowed per IP per window. */
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

/**
 * The Hub does not model workspaces yet (there is no workspace table or column,
 * so nothing to migrate). Every user gets one default workspace, matching the
 * fallback proba-web uses and the default `workspaceId` of audit events
 * (AUDIT_WORKSPACE_ID). It was `default` / "My workspace" before it became Seedbed.
 */
export const DEFAULT_WORKSPACE: Workspace = { id: DEFAULT_WORKSPACE_ID, name: 'Seedbed' };
export const DEFAULT_WORKSPACES: Workspace[] = [DEFAULT_WORKSPACE];

function toPublicUser(user: Pick<User, 'id' | 'email' | 'name'>) {
  return { id: user.id, email: user.email, name: user.name };
}

function tooManyAttempts(reply: FastifyReply, retryAfter: number) {
  return reply
    .code(429)
    .header('retry-after', String(retryAfter))
    .send({ error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' });
}

const RESOLUTION_STATUS: Record<UserResolutionError['code'], number> = {
  email_required: 403,
  email_not_verified: 403,
  not_allowed: 403,
  account_conflict: 409,
};

/**
 * Sign-in via Firebase Authentication:
 *   POST /v1/auth/session  exchange a Firebase ID token for a Hub session token
 *   POST /v1/auth/logout   revoke the Hub session
 *   GET  /v1/auth/me
 */
export async function authRoutes(fastify: FastifyInstance, opts: AuthRoutesOptions) {
  const max = opts.rateLimitMax ?? config.auth.sessionRateLimitMax;
  const windowMs = opts.rateLimitWindowMs ?? config.auth.sessionRateLimitWindowMs;
  const failuresByIp = new FixedWindowRateLimiter({ max, windowMs });
  const verify = opts.firebaseVerifier;

  fastify.post<{ Body: SessionRequest }>(
    '/auth/session',
    {
      schema: {
        body: {
          type: 'object',
          required: ['idToken'],
          properties: { idToken: { type: 'string', minLength: 1, maxLength: 8192 } },
        },
      },
      // Do not echo the body (ID token) in validation errors.
      attachValidation: true,
    },
    async (request, reply) => {
      if (!verify) {
        return reply
          .code(503)
          .send({ error: 'auth_not_configured', message: 'Sign-in is not configured on this server.' });
      }
      if (request.validationError) {
        return reply.code(400).send({ error: 'invalid_request', message: 'An ID token is required.' });
      }

      const ipKey = `ip:${request.ip}`;
      const retryAfter = failuresByIp.retryAfter(ipKey);
      if (retryAfter > 0) {
        logger.warn({ ip: request.ip }, 'Session exchange rate limited');
        await auditAuthDenied(request, 'rate_limited');
        return tooManyAttempts(reply, retryAfter);
      }

      try {
        const identity = await verify(request.body.idToken);
        const user = await resolveFirebaseUser(identity, { allowedEmailDomains: opts.allowedEmailDomains });
        const session = await issueAuditedSession(fastify, user.id, 'firebase', {
          provider: identity.signInProvider,
        });
        logger.info({ userId: user.id, provider: identity.signInProvider }, 'Sign-in succeeded');

        const body: SessionResponse = {
          token: session.token,
          user: toPublicUser(user),
          workspaces: DEFAULT_WORKSPACES,
          expiresAt: session.expiresAt.toISOString(),
        };
        return reply.send(body);
      } catch (error) {
        if (error instanceof FirebaseTokenError) {
          failuresByIp.hit(ipKey);
          logger.info({ ip: request.ip, reason: error.message }, 'Sign-in rejected');
          await getAudit().emit({
            action: 'auth.denied',
            outcome: 'failure',
            root: true,
            actor: { type: 'system', id: 'anonymous' },
            target: { type: 'route', id: 'POST /v1/auth/session' },
            errorCode: error.code,
            details: { method: 'firebase' },
          });
          return reply.code(401).send({
            error: error.code,
            message:
              error.code === 'token_expired'
                ? 'Your sign-in has expired. Sign in again.'
                : 'Sign-in could not be verified. Sign in again.',
          });
        }
        if (error instanceof UserResolutionError) {
          failuresByIp.hit(ipKey);
          logger.info({ ip: request.ip, reason: error.code }, 'Sign-in refused');
          await getAudit().emit({
            action: 'auth.denied',
            outcome: 'denied',
            root: true,
            actor: { type: 'system', id: 'anonymous' },
            target: { type: 'route', id: 'POST /v1/auth/session' },
            errorCode: error.code,
            details: { method: 'firebase' },
          });
          return reply.code(RESOLUTION_STATUS[error.code]).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    }
  );

  fastify.post('/auth/logout', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const userId = request.user!.id;
    await transaction(async (client) => {
      const audit = getAudit();
      await client.query('DELETE FROM sessions WHERE token_hash = $1', [request.sessionTokenHash]);
      const target = { type: 'user', id: userId };
      const signOut = await audit.emit(
        { action: 'auth.sign_out', outcome: 'success', root: true, userId, target },
        { tx: client }
      );
      await audit.emit(
        {
          action: 'auth.session_revoked',
          outcome: 'success',
          userId,
          target,
          ...(signOut ? { parentSpanId: signOut.spanId } : {}),
          details: { reason: 'sign_out' },
        },
        { tx: client }
      );
    });
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

      const session = await issueAuditedSession(fastify, user.id, 'dev_login');

      reply.send({
        token: session.token,
        user: toPublicUser(user),
      });
    }
  );
}
