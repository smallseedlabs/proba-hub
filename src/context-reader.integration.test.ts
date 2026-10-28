import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createAssertionRuntime } from './auth/assertions/runtime.js';
import { createContextBridgeSigners } from './auth/assertions/testing.js';
import { createTestUser } from './test-helpers.js';
import { setAuditForTests, createHubAudit, type HubAudit } from './audit/service.js';
import { PostgresOutboxStore } from './audit/vendor/proba-audit/index.js';

const signers = await createContextBridgeSigners();
const hubPem = await signers.hub.writePrivatePem();
const hubJwks = await signers.hub.writeJwks();
const serviceJwks = await signers.service.writeJwks();

const assertionAuth = await createAssertionRuntime({
  env: 'test',
  contextReaderEnabled: true,
  contextBridgeUrl: '',
  assertionPrivateKeyFile: hubPem,
  assertionKeyId: signers.hub.kid,
  assertionPublicKeyFile: hubJwks,
  contextServicePublicKeyFile: serviceJwks,
});

const app: FastifyInstance = await buildApp({
  startBackgroundJobs: false,
  assertionAuth,
});

const emitted: Array<{ action: string; details?: Record<string, unknown>; actor?: { id: string } }> = [];
const real = createHubAudit({ outbox: new PostgresOutboxStore({ pool }) });
const auditSpy: HubAudit = {
  enabled: true,
  async emit(draft, options) {
    const event = await real.emit(draft, options);
    if (event) {
      emitted.push({
        action: event.action,
        details: event.details as Record<string, unknown>,
        actor: event.actor as { id: string },
      });
    }
    return event;
  },
};
setAuditForTests(auditSpy);

afterAll(async () => {
  setAuditForTests(undefined);
  await app.close();
});

async function bridgeCall(
  method: 'GET' | 'POST',
  url: string,
  opts: {
    actorId: string;
    workspaceId: string;
    goalId: string;
    threadId?: string;
    assertion?: string | null;
    token?: string | null;
    body?: Record<string, unknown>;
    queryExtra?: Record<string, string>;
  }
) {
  const token =
    opts.token === null
      ? undefined
      : opts.token ??
        (await signers.mintServiceToken({ jti: `svc-${randomUUID()}` }));
  const assertion =
    opts.assertion === null
      ? undefined
      : opts.assertion ??
        (await signers.mintAssertion({
          sub: opts.actorId,
          workspaceId: opts.workspaceId,
          goalId: opts.goalId,
          threadId: opts.threadId ?? randomUUID(),
          jti: `assert-${randomUUID()}`,
        }));
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (assertion) headers['x-act-as'] = assertion;

  let path = url;
  if (method === 'GET') {
    const q = new URLSearchParams({
      actorId: opts.actorId,
      workspaceId: opts.workspaceId,
      goalId: opts.goalId,
      ...opts.queryExtra,
    });
    path = `${url}?${q.toString()}`;
  }

  return app.inject({
    method,
    url: path,
    headers,
    payload: opts.body,
  });
}

describe('context-reader internal routes', () => {
  let owner: { token: string; userId: string; threadId: string };
  let other: { token: string; userId: string; threadId: string };
  let goalId: string;

  beforeAll(async () => {
    owner = await createTestUser(app, 'ctx-owner');
    other = await createTestUser(app, 'ctx-other');

    const ownerGoal = await pool.query<{ id: string }>(
      `INSERT INTO goals (user_id, thread_id, title, budget, status)
       VALUES ($1, $2, 'Owner goal', $3::jsonb, 'active')
       RETURNING id`,
      [owner.userId, owner.threadId, JSON.stringify({ daily: 100, total: 1000, currency: 'USD' })]
    );
    goalId = ownerGoal.rows[0].id;

    await pool.query(`INSERT INTO messages (thread_id, text, source) VALUES ($1, $2, 'user')`, [
      owner.threadId,
      'Secret token=sk-live-abcdefghijklmnopqrstuv and email me at owner@example.com',
    ]);
    await pool.query(`INSERT INTO messages (thread_id, text, source) VALUES ($1, $2, 'brain')`, [
      owner.threadId,
      'Understood.',
    ]);

    await pool.query(
      `INSERT INTO goals (user_id, thread_id, title, budget, status)
       VALUES ($1, $2, 'Other goal', $3::jsonb, 'active')`,
      [other.userId, other.threadId, JSON.stringify({ daily: 50, currency: 'USD' })]
    );
  }, 60_000);

  it('serves public JWKS without secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/.well-known/assertion-keys' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/public/);
    const body = JSON.parse(res.body);
    expect(body.keys[0].kid).toBe(signers.hub.kid);
    expect(JSON.stringify(body)).not.toContain('"d"');
  });

  it('returns goal state for the acting user', async () => {
    const res = await bridgeCall('GET', `/v1/internal/goals/${goalId}/state`, {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: owner.threadId,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      goalId,
      userId: owner.userId,
      workspaceId: 'seedbed',
      threadId: owner.threadId,
      title: 'Owner goal',
    });
    expect(Array.isArray(body.campaignIds)).toBe(true);
    expect(body.budget).toBeDefined();
  });

  it('returns masked thread messages newest first', async () => {
    const res = await bridgeCall('GET', `/v1/internal/threads/${owner.threadId}/messages`, {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: owner.threadId,
      queryExtra: { limit: '10' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages.length).toBeGreaterThan(0);
    if (body.messages.length > 1) {
      expect(body.messages[0].createdAt >= body.messages[1].createdAt).toBe(true);
    }
    const texts = body.messages.map((m: { text: string }) => m.text).join('\n');
    expect(texts).not.toMatch(/sk-live-abcdefghijklmnopqrstuv/);
    expect(texts).not.toMatch(/owner@example\.com/);
  });

  it('authorizes the owner and refuses another user for the same goal', async () => {
    const ok = await bridgeCall('POST', '/v1/internal/authorize', {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: owner.threadId,
      body: { userId: owner.userId, workspaceId: 'seedbed', goalId },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ allowed: true, reason: 'ok' });

    const denied = await bridgeCall('POST', '/v1/internal/authorize', {
      actorId: other.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: other.threadId,
      body: { userId: other.userId, workspaceId: 'seedbed', goalId },
    });
    // Body matches assertion (other user) but the goal is not owned by other.
    expect(denied.statusCode).toBe(200);
    expect(JSON.parse(denied.body)).toMatchObject({ allowed: false, reason: 'goal_not_owned' });
  });

  it('never returns another user\'s goal or thread', async () => {
    const goal = await bridgeCall('GET', `/v1/internal/goals/${goalId}/state`, {
      actorId: other.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: other.threadId,
    });
    expect(goal.statusCode).toBe(404);

    const messages = await bridgeCall('GET', `/v1/internal/threads/${owner.threadId}/messages`, {
      actorId: other.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: other.threadId,
    });
    expect(messages.statusCode).toBe(404);
  });

  it('requires X-Act-As and matching actorId/workspaceId/goalId', async () => {
    const noAssertion = await bridgeCall('GET', `/v1/internal/goals/${goalId}/state`, {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      assertion: null,
    });
    expect(noAssertion.statusCode).toBe(400);
    expect(JSON.parse(noAssertion.body).error).toBe('act_as_required');

    const mismatch = await bridgeCall('GET', `/v1/internal/goals/${goalId}/state`, {
      actorId: other.userId,
      workspaceId: 'seedbed',
      goalId,
      assertion: await signers.mintAssertion({
        sub: owner.userId,
        workspaceId: 'seedbed',
        goalId,
        threadId: owner.threadId,
      }),
    });
    expect(mismatch.statusCode).toBe(403);
    expect(JSON.parse(mismatch.body).error).toBe('act_as_mismatch');
  });

  it('refuses expired and wrong-audience assertions', async () => {
    const expired = await bridgeCall('GET', `/v1/internal/goals/${goalId}/state`, {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      assertion: await signers.mintAssertion({
        sub: owner.userId,
        workspaceId: 'seedbed',
        goalId,
        threadId: owner.threadId,
        ttl: -5,
      }),
    });
    expect(expired.statusCode).toBe(403);
    expect(JSON.parse(expired.body).error).toMatch(/act_as_/);

    const wrongAud = await bridgeCall('GET', `/v1/internal/goals/${goalId}/state`, {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      assertion: await signers.mintAssertion({
        sub: owner.userId,
        workspaceId: 'seedbed',
        goalId,
        threadId: owner.threadId,
        aud: ['proba-audit'],
      }),
    });
    expect(wrongAud.statusCode).toBe(403);
  });

  it('does not accept a user session on internal routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/internal/goals/${goalId}/state?actorId=${owner.userId}&workspaceId=seedbed&goalId=${goalId}`,
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not accept a context-reader token on public routes', async () => {
    const token = await signers.mintServiceToken();
    const assertion = await signers.mintAssertion({
      sub: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: owner.threadId,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/goals',
      headers: { authorization: `Bearer ${token}`, 'x-act-as': assertion },
    });
    expect(res.statusCode).toBe(401);
  });

  it('audits reads with caller context-reader and jti, never message text', async () => {
    emitted.length = 0;
    const jti = `assert-audit-${randomUUID()}`;
    await bridgeCall('GET', `/v1/internal/threads/${owner.threadId}/messages`, {
      actorId: owner.userId,
      workspaceId: 'seedbed',
      goalId,
      threadId: owner.threadId,
      assertion: await signers.mintAssertion({
        sub: owner.userId,
        workspaceId: 'seedbed',
        goalId,
        threadId: owner.threadId,
        jti,
      }),
    });
    const reads = emitted.filter((e) => e.action === 'context.source_fetched');
    expect(reads.length).toBeGreaterThan(0);
    for (const e of reads) {
      expect(e.actor?.id).toBe('context-reader');
      expect(e.details).toMatchObject({ caller: 'context-reader', assertionJti: jti });
      expect(JSON.stringify(e.details)).not.toMatch(/sk-live|owner@example/);
    }
  });
});

describe('public API regression (internal routes absent without context-reader)', () => {
  it('keeps existing public read behaviour for session users', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/goals',
      headers: { authorization: `Bearer ${(await createTestUser(app, 'pub')).token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).goals).toBeDefined();
  });

  it('does not register /v1/internal when the context-reader role is off', async () => {
    const offAuth = await createAssertionRuntime({
      env: 'test',
      contextReaderEnabled: false,
      contextBridgeUrl: '',
      assertionPrivateKeyFile: hubPem,
      assertionKeyId: signers.hub.kid,
      assertionPublicKeyFile: hubJwks,
      contextServicePublicKeyFile: '',
    });
    const offApp = await buildApp({ startBackgroundJobs: false, assertionAuth: offAuth });
    try {
      const userId = randomUUID();
      const goal = randomUUID();
      const token = await signers.mintServiceToken();
      const assertion = await signers.mintAssertion({
        sub: userId,
        workspaceId: 'seedbed',
        goalId: goal,
        threadId: randomUUID(),
      });
      const res = await offApp.inject({
        method: 'GET',
        url: `/v1/internal/goals/${goal}/state?actorId=${userId}&workspaceId=seedbed&goalId=${goal}`,
        headers: { authorization: `Bearer ${token}`, 'x-act-as': assertion },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await offApp.close();
    }
  });
});

