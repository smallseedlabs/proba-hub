import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';
import type { PgQueryable } from '../audit/vendor/proba-audit/index.js';
import { config } from '../config.js';
import { hashToken } from './tokens.js';

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

/**
 * Sign a JWT for the user and persist its session row (in `db`, default the pool). The JWT carries a
 * unique jti so two sign-ins in the same second never collide; the session
 * row is what makes the token revocable (sign-out deletes it).
 */
export async function issueSession(
  fastify: FastifyInstance,
  userId: string,
  /** Pass the caller's transaction so the session commits together with its audit event. */
  db: PgQueryable = pool
): Promise<IssuedSession> {
  const token = fastify.jwt.sign({ userId, jti: randomUUID() }, { expiresIn: config.auth.jwtExpiresIn });
  const decoded = fastify.jwt.decode<{ exp?: number }>(token);
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 24 * 3600 * 1000);

  await db.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    userId,
    hashToken(token),
    expiresAt,
  ]);

  return { token, expiresAt };
}
