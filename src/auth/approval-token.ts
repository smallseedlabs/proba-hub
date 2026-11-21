import crypto from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export const APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;

export type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export interface SpendAskRow {
  id: string;
  ask_type: string;
  risk: string | null;
  cost_effect: unknown;
}

export interface MintedApprovalToken {
  token: string;
  askId: string;
  expiresAt: string;
}

export type ApprovalTokenVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'missing_token'
        | 'invalid_token'
        | 'reused_token'
        | 'expired_token'
        | 'ask_mismatch'
        | 'user_mismatch';
    };

/**
 * Returns true if approving this ask can authorize or modify ad spend.
 * plan_approval always gates the campaign launch plan; action_approval gates
 * spend when it carries a cost_effect or is marked high risk.
 */
export function isSpendAsk(ask: Pick<SpendAskRow, 'ask_type' | 'risk' | 'cost_effect'>): boolean {
  if (ask.ask_type === 'plan_approval') {
    return true;
  }
  if (ask.ask_type === 'action_approval') {
    return ask.cost_effect != null || ask.risk === 'high';
  }
  return false;
}

/**
 * Mints a single-use, 10-minute approval token bound to (askId, userId).
 * Returns null if the ask does not exist or is not owned by userId.
 */
export async function mintApprovalToken(
  db: Queryable,
  params: { askId: string; userId: string; now?: Date }
): Promise<MintedApprovalToken | null> {
  const { askId, userId, now = new Date() } = params;
  const ownership = await db.query<{ id: string }>(
    `SELECT a.id
     FROM asks a
     JOIN threads t ON t.id = a.thread_id
     WHERE a.id = $1 AND t.user_id = $2`,
    [askId, userId]
  );

  if (ownership.rows.length === 0) {
    return null;
  }

  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(now.getTime() + APPROVAL_TOKEN_TTL_MS);

  await db.query(
    `INSERT INTO approval_tokens (ask_id, user_id, gesture_at, nonce, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [askId, userId, now.toISOString(), nonce, expiresAt.toISOString()]
  );

  return {
    token: nonce,
    askId,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Atomically verifies and consumes a single-use approval token for (askId, userId).
 * Rejects missing, unknown, already-consumed, expired, or mismatched tokens.
 */
export async function verifyAndConsumeApprovalToken(
  db: Queryable,
  params: { token: unknown; askId: string; userId: string; now?: Date }
): Promise<ApprovalTokenVerifyResult> {
  const { token, askId, userId, now = new Date() } = params;
  if (typeof token !== 'string' || token.trim().length < 16) {
    return { ok: false, reason: 'missing_token' };
  }

  const trimmed = token.trim();
  const nowIso = now.toISOString();

  const consumed = await db.query<{ id: string }>(
    `UPDATE approval_tokens
     SET consumed_at = $1
     WHERE nonce = $2
       AND ask_id = $3
       AND user_id = $4
       AND consumed_at IS NULL
       AND expires_at > $1
     RETURNING id`,
    [nowIso, trimmed, askId, userId]
  );

  if (consumed.rows.length === 1) {
    return { ok: true };
  }

  const existing = await db.query<{
    ask_id: string;
    user_id: string;
    consumed_at: Date | string | null;
    expires_at: Date | string;
  }>(
    `SELECT ask_id, user_id, consumed_at, expires_at
     FROM approval_tokens
     WHERE nonce = $1`,
    [trimmed]
  );

  if (existing.rows.length === 0) {
    return { ok: false, reason: 'invalid_token' };
  }

  const row = existing.rows[0];
  if (row.user_id !== userId) {
    return { ok: false, reason: 'user_mismatch' };
  }
  if (row.ask_id !== askId) {
    return { ok: false, reason: 'ask_mismatch' };
  }
  if (row.consumed_at !== null) {
    return { ok: false, reason: 'reused_token' };
  }
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired_token' };
  }

  return { ok: false, reason: 'invalid_token' };
}
