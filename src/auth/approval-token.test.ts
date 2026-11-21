import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_TOKEN_TTL_MS,
  isSpendAsk,
  mintApprovalToken,
  verifyAndConsumeApprovalToken,
  type Queryable,
} from './approval-token.js';

interface TokenRecord {
  id: string;
  ask_id: string;
  user_id: string;
  gesture_at: string;
  nonce: string;
  expires_at: string;
  consumed_at: string | null;
}

function createInMemoryApprovalDb(asks: Array<{ id: string; user_id: string; ask_type: string; risk: string | null; cost_effect: unknown }>) {
  const tokens: TokenRecord[] = [];
  let seq = 1;

  const db: Queryable = {
    query: (async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM asks a') && sql.includes('JOIN threads t')) {
        const [askId, userId] = params as [string, string];
        const found = asks.filter((a) => a.id === askId && a.user_id === userId);
        return { rows: found, rowCount: found.length };
      }
      if (sql.includes('INSERT INTO approval_tokens')) {
        const [ask_id, user_id, gesture_at, nonce, expires_at] = params as [
          string,
          string,
          string,
          string,
          string,
        ];
        tokens.push({
          id: `tok-${seq++}`,
          ask_id,
          user_id,
          gesture_at,
          nonce,
          expires_at,
          consumed_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE approval_tokens')) {
        const [nowIso, nonce, askId, userId] = params as [string, string, string, string];
        const row = tokens.find(
          (t) =>
            t.nonce === nonce &&
            t.ask_id === askId &&
            t.user_id === userId &&
            t.consumed_at === null &&
            new Date(t.expires_at).getTime() > new Date(nowIso).getTime()
        );
        if (!row) {
          return { rows: [], rowCount: 0 };
        }
        row.consumed_at = nowIso;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (sql.includes('FROM approval_tokens') && sql.includes('WHERE nonce = $1')) {
        const [nonce] = params as [string];
        const row = tokens.find((t) => t.nonce === nonce);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('SELECT id FROM threads')) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    }) as Queryable['query'],
  };

  return { db, tokens };
}

describe('isSpendAsk', () => {
  it('marks plan_approval and cost-bearing/high-risk action_approval as spend asks', () => {
    expect(isSpendAsk({ ask_type: 'plan_approval', risk: 'low', cost_effect: null })).toBe(true);
    expect(
      isSpendAsk({ ask_type: 'action_approval', risk: 'medium', cost_effect: { dailyUsd: 25 } })
    ).toBe(true);
    expect(isSpendAsk({ ask_type: 'action_approval', risk: 'high', cost_effect: null })).toBe(true);
    expect(isSpendAsk({ ask_type: 'clarify', risk: 'low', cost_effect: null })).toBe(false);
    expect(isSpendAsk({ ask_type: 'research_review', risk: 'low', cost_effect: null })).toBe(false);
    expect(isSpendAsk({ ask_type: 'action_approval', risk: 'low', cost_effect: null })).toBe(false);
  });
});

describe('approval-token lifecycle', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const ask1 = '22222222-2222-4222-8222-222222222222';
  const ask2 = '33333333-3333-4333-8333-333333333333';

  it('rejects missing token, accepts valid token once, and rejects reuse, wrong ask, and stale (>10m) token', async () => {
    const { db } = createInMemoryApprovalDb([
      { id: ask1, user_id: userId, ask_type: 'plan_approval', risk: 'high', cost_effect: { usd: 50 } },
      { id: ask2, user_id: userId, ask_type: 'plan_approval', risk: 'high', cost_effect: { usd: 50 } },
    ]);

    const t0 = new Date('2026-11-21T12:00:00.000Z');
    const minted = await mintApprovalToken(db, { askId: ask1, userId, now: t0 });
    expect(minted).not.toBeNull();
    expect(minted!.token.length).toBeGreaterThanOrEqual(16);

    // Missing token
    expect(
      await verifyAndConsumeApprovalToken(db, { token: undefined, askId: ask1, userId, now: t0 })
    ).toEqual({ ok: false, reason: 'missing_token' });

    // Token minted for ask1 used on ask2
    expect(
      await verifyAndConsumeApprovalToken(db, { token: minted!.token, askId: ask2, userId, now: t0 })
    ).toEqual({ ok: false, reason: 'ask_mismatch' });

    // Valid token accepted once
    expect(
      await verifyAndConsumeApprovalToken(db, { token: minted!.token, askId: ask1, userId, now: t0 })
    ).toEqual({ ok: true });

    // Reused token rejected
    expect(
      await verifyAndConsumeApprovalToken(db, { token: minted!.token, askId: ask1, userId, now: t0 })
    ).toEqual({ ok: false, reason: 'reused_token' });

    // Stale (>10 min) token rejected
    const minted2 = await mintApprovalToken(db, { askId: ask1, userId, now: t0 });
    const expiredAt = new Date(t0.getTime() + APPROVAL_TOKEN_TTL_MS + 1000);
    expect(
      await verifyAndConsumeApprovalToken(db, {
        token: minted2!.token,
        askId: ask1,
        userId,
        now: expiredAt,
      })
    ).toEqual({ ok: false, reason: 'expired_token' });
  });
});

describe('H0-02 commandRoutes enforcement', () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const threadId = '44444444-4444-4444-8444-444444444444';
  const askId = '22222222-2222-4222-8222-222222222222';
  const otherAskId = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.resetModules();
  });

  it('enforces single-use approval tokens on POST /v1/commands and emits approval.rejected on failure', async () => {
    const { db } = createInMemoryApprovalDb([
      { id: askId, user_id: userId, ask_type: 'plan_approval', risk: 'high', cost_effect: { usd: 50 } },
      { id: otherAskId, user_id: userId, ask_type: 'plan_approval', risk: 'high', cost_effect: { usd: 50 } },
    ]);
    const emittedActions: string[] = [];

    vi.doMock('../db/client.js', () => ({
      pool: { query: db.query },
      transaction: async (fn: (client: unknown) => Promise<unknown>) =>
        fn({ query: db.query }),
    }));
    vi.doMock('../audit/service.js', () => ({
      getAudit: () => ({
        emit: async (event: { action: string }) => {
          emittedActions.push(event.action);
          return { spanId: 'span-1' };
        },
      }),
    }));

    const { commandRoutes } = await import('../routes/commands.js');
    const app = Fastify();
    app.decorate('authenticate', async (request: { user?: { id: string; email: string } }) => {
      request.user = { id: userId, email: 'founder@smallseed.dev' };
    });
    const processCommand = vi.fn(async () => {});
    await app.register(commandRoutes, {
      prefix: '/v1',
      processor: {
        processCommand,
        auditProcessingFailure: vi.fn(async () => {}),
      } as never,
    });

    const sendApprove = (targetAskId: string, approvalToken?: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/commands',
        payload: {
          kind: 'command',
          type: 'answer_ask',
          clientMsgId: '55555555-5555-4555-8555-555555555555',
          threadId,
          sentAt: new Date().toISOString(),
          payload: {
            askId: targetAskId,
            choice: 'approve',
            ...(approvalToken ? { approvalToken } : {}),
          },
        },
      });

    // 1. Missing token -> 403 + approval.rejected
    emittedActions.length = 0;
    const resMissing = await sendApprove(askId);
    expect(resMissing.statusCode).toBe(403);
    expect(emittedActions).toContain('approval.rejected');

    // Mint a valid token via HTTP endpoint
    const mintRes = await app.inject({
      method: 'POST',
      url: `/v1/asks/${askId}/approval-token`,
    });
    expect(mintRes.statusCode).toBe(200);
    const { token } = mintRes.json() as { token: string };

    // 2. Token for another ask -> 403 + approval.rejected
    emittedActions.length = 0;
    const resWrongAsk = await sendApprove(otherAskId, token);
    expect(resWrongAsk.statusCode).toBe(403);
    expect(emittedActions).toContain('approval.rejected');

    // 3. Valid token -> 202 accepted once
    emittedActions.length = 0;
    const resValid = await sendApprove(askId, token);
    expect(resValid.statusCode).toBe(202);
    expect(emittedActions).not.toContain('approval.rejected');

    // 4. Reused token -> 403 + approval.rejected
    emittedActions.length = 0;
    const resReused = await sendApprove(askId, token);
    expect(resReused.statusCode).toBe(403);
    expect(emittedActions).toContain('approval.rejected');

    await app.close();
  });
});
