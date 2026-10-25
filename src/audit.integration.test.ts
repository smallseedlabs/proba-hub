import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool, transaction } from './db/client.js';
import { config } from './config.js';
import { redisClient } from './services/redis.js';
import { createFakeFirebaseIssuer } from './auth/firebase-testing.js';
import { createFirebaseTokenVerifier } from './auth/firebase.js';
import { processExpiredAsks } from './services/ask-expiry.js';
import { currentTrace, runAsJob } from './audit/trace.js';
import { getAudit } from './audit/service.js';
import { createAuditRelay } from './audit/relay.js';
import {
  AUDIT_ACTIONS,
  PostgresOutboxStore,
  buildAuditEvent,
  validateAuditEvent,
  type AuditEvent,
} from './audit/vendor/proba-audit/index.js';
import { createTestUser, controlCommand, createGoalCommand, openSSE, waitForEvents, waitUntil } from './test-helpers.js';
import type { BrainPort } from './types.js';

const KNOWN_ACTIONS = new Set<string>(Object.values(AUDIT_ACTIONS).flat());

const firebase = await createFakeFirebaseIssuer('audit-test');
const app: FastifyInstance = await buildApp({
  startBackgroundJobs: true,
  brainScenario: 'happy_path',
  firebaseVerifier: createFirebaseTokenVerifier({ projectId: firebase.projectId, keys: firebase.keys }),
});

async function eventsForTrace(traceId: string): Promise<AuditEvent[]> {
  const result = await pool.query<{ payload: AuditEvent }>(
    "SELECT payload FROM audit_outbox WHERE payload->>'traceId' = $1 ORDER BY id",
    [traceId]
  );
  return result.rows.map((r) => r.payload);
}

async function waitForAction(traceId: string, action: string, count = 1): Promise<AuditEvent[]> {
  let events: AuditEvent[] = [];
  await waitUntil(
    async () => {
      events = await eventsForTrace(traceId);
      return events.filter((e) => e.action === action).length >= count;
    },
    { timeout: 10000, message: `${action} in trace ${traceId}` }
  );
  return events;
}

/** Every event of one request: same trace, valid, known actions, one root, a connected span tree. */
function expectOneConsistentTrace(events: AuditEvent[], traceId: string) {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    expect(event.traceId).toBe(traceId);
    expect(validateAuditEvent(event).success).toBe(true);
    expect(KNOWN_ACTIONS.has(event.action)).toBe(true);
    expect(event.service).toBe('hub');
    expect(event.workspaceId).toBe('seedbed');
    expect(event.action.startsWith(`${event.category}.`)).toBe(true);
  }
  const spanIds = new Set(events.map((e) => e.spanId));
  expect(spanIds.size).toBe(events.length); // unique span per event
  expect(events.filter((e) => !e.parentSpanId)).toHaveLength(1); // exactly one root
  for (const event of events) {
    if (event.parentSpanId) expect(spanIds.has(event.parentSpanId)).toBe(true);
  }
}

function expectNoSecrets(events: AuditEvent[], ...forbidden: string[]) {
  const text = JSON.stringify(events);
  for (const value of forbidden) expect(text).not.toContain(value);
  expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\./);
  expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
}

afterAll(async () => {
  await app.close();
});

describe('audit outbox: written in the action’s own transaction', () => {
  const draft = () => buildAuditEvent({
    eventId: randomUUID(),
    traceId: randomUUID(),
    workspaceId: 'seedbed',
    actor: { type: 'system', id: 'hub' },
    service: 'hub',
    action: 'system.job_run',
    category: 'system',
    outcome: 'success',
  });

  it('a rolled-back transaction leaves no audit event; a committed one leaves exactly one', async () => {
    const outbox = new PostgresOutboxStore({ pool });
    const rolledBack = draft();
    await expect(
      transaction(async (client) => {
        await outbox.enqueue([rolledBack], client);
        throw new Error('business failure');
      })
    ).rejects.toThrow('business failure');
    expect(await eventsForTrace(rolledBack.traceId)).toHaveLength(0);

    const committed = draft();
    await transaction((client) => outbox.enqueue([committed], client));
    expect(await eventsForTrace(committed.traceId)).toHaveLength(1);
    // Dedupe by eventId.
    expect(await outbox.enqueue([committed])).toBe(0);
    expect(await eventsForTrace(committed.traceId)).toHaveLength(1);
  });

  it('the Hub emitter honours the caller’s transaction (rollback => nothing, commit => event)', async () => {
    const audit = getAudit();
    let rolledBackTrace = '';
    await expect(
      runAsJob(() =>
        transaction(async (client) => {
          rolledBackTrace = currentTrace()!.traceId;
          await audit.emit({ action: 'system.job_run', outcome: 'success' }, { tx: client });
          expect(await eventsForTrace(rolledBackTrace)).toHaveLength(0); // not visible to other connections yet
          throw new Error('rollback');
        })
      )
    ).rejects.toThrow('rollback');
    expect(rolledBackTrace).toMatch(/^[0-9a-f-]{36}$/);
    expect(await eventsForTrace(rolledBackTrace)).toHaveLength(0);

    let committedTrace = '';
    await runAsJob(() =>
      transaction(async (client) => {
        committedTrace = currentTrace()!.traceId;
        await audit.emit({ action: 'system.job_run', outcome: 'success' }, { tx: client });
      })
    );
    expect(await eventsForTrace(committedTrace)).toHaveLength(1);
  });

  it('a command whose processing transaction rolls back loses its in-transaction events but records the failure', async () => {
    const throwingBrain: BrainPort = { process: async () => { throw new Error('model unavailable'); } };
    const failing = await buildApp({ startBackgroundJobs: false, brain: throwingBrain });
    try {
      const user = await createTestUser(failing, 'rollback');
      const clientMsgId = randomUUID();
      // answer_ask has no error-event fallback: a brain failure aborts and rolls back the transaction.
      const res = await failing.inject({
        method: 'POST',
        url: '/v1/commands',
        headers: { authorization: `Bearer ${user.token}` },
        payload: {
          kind: 'command',
          clientMsgId,
          type: 'answer_ask',
          threadId: user.threadId,
          payload: { askId: randomUUID(), choice: 'approve' },
          sentAt: new Date().toISOString(),
        },
      });
      expect(JSON.parse(res.body).status).toBe('accepted');
      const events = await waitForAction(clientMsgId, 'system.error');

      const actions = events.map((e) => e.action);
      // Committed before processing: the accepted command.
      expect(actions).toContain('command.received');
      expect(actions).toContain('command.accepted');
      // Written inside the rolled-back transaction: must not exist.
      expect(actions).not.toContain('data_access.write');
      expect(actions).not.toContain('brain.llm_call');
      expect(actions).not.toContain('command.processed.success');
      const processed = events.filter((e) => e.action === 'command.processed');
      expect(processed).toHaveLength(1);
      expect(processed[0]).toMatchObject({ outcome: 'failure', errorCode: 'command_processing_failed' });
      expect(events.find((e) => e.action === 'brain.error')).toMatchObject({ outcome: 'failure', errorCode: 'brain_failed' });
      const stored = await pool.query('SELECT 1 FROM commands WHERE user_id = $1 AND client_msg_id = $2', [user.userId, clientMsgId]);
      expect(stored.rows).toHaveLength(0);
      expectOneConsistentTrace(events, clientMsgId);
    } finally {
      await failing.close();
    }
  });
});

describe('one traceId per /v1/commands request (happy_path through the web flow)', () => {
  const emailMarker = `audit-${randomUUID()}`;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    const idToken = await firebase.mint({ email: `${emailMarker}@example.com`, name: 'Audit Flow' });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { idToken } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    token = body.token;
    userId = body.user.id;
    expect(body.workspaces).toEqual([{ id: 'seedbed', name: 'Seedbed' }]);
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  const post = async (type: string, payload: Record<string, unknown>, threadId?: string, clientMsgId = randomUUID()) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: 'command', clientMsgId, type, ...(threadId ? { threadId } : {}), payload, sentAt: new Date().toISOString() },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('accepted');
    // The traceId is the web's clientMsgId, in the response header too.
    expect(res.headers['x-trace-id']).toBe(clientMsgId);
    return clientMsgId;
  };

  it('audits every step of goal -> clarify -> plan -> approval -> tool -> decision with the command’s clientMsgId as traceId', async () => {
    // 1. create_goal
    const t1 = await post('create_goal', { title: 'Test demand for trail shoes', budget: { daily: 150, currency: 'GBP' } });
    let events = await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'ask') && evs.some((e) => e.type === 'goal_updated'));
    const clarify = events.find((e) => e.type === 'ask');
    const threadId: string = clarify.threadId;
    const a1 = await waitForAction(t1, 'command.processed');
    expectOneConsistentTrace(a1, t1);
    expect(a1.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'command.received', 'command.accepted', 'brain.llm_call', 'brain.clarify_requested',
        'data_access.write', 'policy.evaluated', 'command.processed',
      ])
    );
    const received = a1.find((e) => e.action === 'command.received')!;
    expect(received.parentSpanId).toBeUndefined();
    expect(received.userId).toBe(userId);
    const llm = a1.find((e) => e.action === 'brain.llm_call')!;
    expect(llm.parentSpanId).toBe(received.spanId);
    expect(llm.details).toMatchObject({ trigger: 'create_goal', outputCount: 1 });
    // The clarify output is a child of the brain span.
    expect(a1.find((e) => e.action === 'brain.clarify_requested')!.parentSpanId).toBe(llm.spanId);
    const goalWrite = a1.find((e) => e.action === 'data_access.write')!;
    expect(goalWrite).toMatchObject({ target: { type: 'goal' }, details: { change: 'created', status: 'active' } });
    expect(goalWrite.goalId).toBeTruthy();
    expect(a1.find((e) => e.action === 'policy.evaluated')!.details).toMatchObject({
      policy: 'budget', decision: 'recorded', enforced: false, dailyBudget: 150, currency: 'GBP',
    });
    expectNoSecrets(a1, emailMarker, token);

    // 2. answer the clarification -> plan
    const t2 = await post('answer_ask', { askId: clarify.payload.askId, choice: 'approve', values: { answer: 'active' } }, threadId);
    events = await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'plan_approval'));
    const a2 = await waitForAction(t2, 'command.processed');
    expectOneConsistentTrace(a2, t2);
    expect(a2.map((e) => e.action)).toEqual(
      expect.arrayContaining(['data_access.write', 'brain.llm_call', 'brain.plan_created', 'approval.requested'])
    );
    expect(a2.find((e) => e.action === 'data_access.write' && e.details.change === 'ask_answered')!.details).toMatchObject({
      askType: 'clarify',
    });
    const plan = events.find((e) => e.type === 'ask' && e.payload.askType === 'plan_approval');
    const planEvent = a2.find((e) => e.action === 'brain.plan_created')!;
    expect(a2.find((e) => e.action === 'approval.requested')!.parentSpanId).toBe(planEvent.spanId); // nested span
    expect(planEvent.target).toEqual({ type: 'ask', id: plan.payload.askId });

    // 3. approve the plan -> tool call needing approval
    const approve = plan.ui.actions.find((a: { id: string }) => a.id === 'approve');
    const t3 = await post(approve.command.type, approve.command.payload, threadId);
    events = await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'action_approval'));
    const a3 = await waitForAction(t3, 'command.processed');
    expectOneConsistentTrace(a3, t3);
    expect(a3.map((e) => e.action)).toEqual(
      expect.arrayContaining(['approval.granted', 'brain.llm_call', 'tool.called', 'policy.evaluated', 'approval.requested'])
    );
    const tool = a3.find((e) => e.action === 'tool.called')!;
    expect(tool).toMatchObject({ outcome: 'partial', riskLevel: 'medium', target: { type: 'tool', id: 'adjust_budget' } });
    expect(tool.details).toMatchObject({ needsApproval: true, executed: false, parameterKeys: ['dailyBudget'] });
    expect(JSON.stringify(tool.details)).not.toContain('120'); // parameter values are not recorded
    const toolBudget = a3.find((e) => e.action === 'policy.evaluated')!;
    expect(toolBudget.parentSpanId).toBe(tool.spanId);
    expect(toolBudget.details).toMatchObject({ policy: 'budget', decision: 'requires_approval', enforced: false, proposedCost: 120 });
    expect(a3.find((e) => e.action === 'approval.granted')!.target).toEqual({ type: 'plan', id: plan.payload.askId });

    // 4. approve the action -> reply + decision
    const action = events.find((e) => e.type === 'ask' && e.payload.askType === 'action_approval');
    const t4 = await post('answer_ask', { askId: action.payload.askId, choice: 'approve' }, threadId);
    await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'goal_updated' && e.payload.metrics?.impressions > 0));
    const a4 = await waitForAction(t4, 'command.processed');
    expectOneConsistentTrace(a4, t4);
    expect(a4.map((e) => e.action)).toEqual(
      expect.arrayContaining(['approval.granted', 'brain.llm_call', 'brain.decision_made', 'data_access.write'])
    );
    expect(a4.find((e) => e.action === 'brain.decision_made')).toMatchObject({ riskLevel: 'low', details: { decision: 'keep' } });
    expect(a4.find((e) => e.action === 'brain.llm_call')!.details).toMatchObject({
      outputs: [{ type: 'reply', textLength: 'Launching campaign with adjusted budget'.length }, { type: 'decision', decision: 'keep' }],
    });
    // Brain output text is never stored.
    expectNoSecrets([...a1, ...a2, ...a3, ...a4], 'Launching campaign');

    // The four requests are four distinct traces.
    expect(new Set([t1, t2, t3, t4]).size).toBe(4);
  });

  it('keeps one traceId when the same command is retried and audits the duplicate', async () => {
    const clientMsgId = randomUUID();
    await post('send_message', { text: 'Hello again' }, undefined, clientMsgId);
    await waitForAction(clientMsgId, 'command.processed');
    await post('send_message', { text: 'Hello again' }, undefined, clientMsgId);
    // The duplicate is detected when the (new thread's) command is replayed.
    const events = await waitForAction(clientMsgId, 'command.received', 2);
    expect(events.every((e) => e.traceId === clientMsgId)).toBe(true);
    expect(events.filter((e) => e.action === 'command.received')).toHaveLength(2);
  });
});

describe('rejected commands, denials and control', () => {
  let user: Awaited<ReturnType<typeof createTestUser>>;

  beforeAll(async () => {
    user = await createTestUser(app, 'reject');
  });

  const send = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/v1/commands', headers: { authorization: `Bearer ${user.token}` }, payload: payload as Record<string, unknown> });

  it('audits an invalid envelope with a non-UUID clientMsgId under a generated traceId and records the raw id', async () => {
    const res = await send({ kind: 'command', clientMsgId: 'legacy-not-a-uuid', type: 'send_message', payload: { text: 'x' }, sentAt: new Date().toISOString() });
    expect(JSON.parse(res.body)).toMatchObject({ status: 'rejected', reason: 'validation_error', clientMsgId: 'legacy-not-a-uuid' });
    const traceId = res.headers['x-trace-id'] as string;
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(traceId).not.toBe('legacy-not-a-uuid');
    const events = await waitForAction(traceId, 'command.rejected');
    expectOneConsistentTrace(events, traceId);
    expect(events.map((e) => e.action)).toEqual(['command.received', 'command.rejected']);
    const rejected = events.find((e) => e.action === 'command.rejected')!;
    expect(rejected).toMatchObject({ outcome: 'failure', errorCode: 'validation_error' });
    expect(rejected.details).toMatchObject({ clientMsgId: 'legacy-not-a-uuid', stage: 'envelope' });
    expect((rejected.details.issues as unknown[]).length).toBeGreaterThan(0);
  });

  it('audits an invalid payload as command.rejected (validation)', async () => {
    const clientMsgId = randomUUID();
    const res = await send({ kind: 'command', clientMsgId, type: 'send_message', payload: { notText: 1 }, sentAt: new Date().toISOString() });
    expect(JSON.parse(res.body)).toMatchObject({ status: 'rejected', reason: 'validation_error' });
    const events = await waitForAction(clientMsgId, 'command.rejected');
    expectOneConsistentTrace(events, clientMsgId);
    expect(events.find((e) => e.action === 'command.rejected')!.details).toMatchObject({ stage: 'payload', commandType: 'send_message' });
  });

  it('audits a thread the user does not own as policy.denied + command.rejected', async () => {
    const clientMsgId = randomUUID();
    const foreignThread = randomUUID();
    const res = await send({
      kind: 'command', clientMsgId, type: 'send_message', threadId: foreignThread, payload: { text: 'hi' }, sentAt: new Date().toISOString(),
    });
    expect(JSON.parse(res.body)).toMatchObject({ status: 'rejected', reason: 'thread_not_found' });
    const events = await waitForAction(clientMsgId, 'command.rejected');
    expectOneConsistentTrace(events, clientMsgId);
    expect(events.map((e) => e.action).sort()).toEqual(['command.received', 'command.rejected', 'policy.denied']);
    expect(events.find((e) => e.action === 'policy.denied')).toMatchObject({
      outcome: 'denied', errorCode: 'thread_not_found', target: { type: 'thread', id: foreignThread }, riskLevel: 'medium',
    });
  });

  it('audits pause/resume/emergency stop as config.changed with risk and an emergency_stop tag', async () => {
    const results: Record<string, AuditEvent[]> = {};
    for (const action of ['pause', 'resume', 'kill'] as const) {
      const command = controlCommand(user.threadId, action);
      const res = await send(command);
      expect(JSON.parse(res.body).status).toBe('accepted');
      results[action] = await waitForAction(command.clientMsgId, 'command.processed');
      expectOneConsistentTrace(results[action], command.clientMsgId);
    }
    const change = (a: string) => results[a].find((e) => e.action === 'config.changed')!;
    expect(change('pause')).toMatchObject({ riskLevel: 'medium', details: { control: 'pause' } });
    expect(change('resume')).toMatchObject({ riskLevel: 'low', details: { control: 'resume' } });
    expect(change('kill')).toMatchObject({ riskLevel: 'high', tags: ['emergency_stop'], details: { control: 'kill' } });
    expect(change('kill').target).toEqual({ type: 'execution_state', id: user.threadId });
  });

  it('audits a failing brain and an invalid brain output, with secrets redacted', async () => {
    const brain: BrainPort = {
      process: async (envelope) => {
        const text = (envelope.payload as { text?: string }).text;
        if (text === 'boom') throw new Error('upstream failed for bob@example.com using Bearer abc123');
        if (text === 'bad') return [{ type: 'nonsense' } as never];
        return [{ type: 'reply', text: 'ok' }];
      },
    };
    const local = await buildApp({ startBackgroundJobs: false, brain });
    try {
      const u = await createTestUser(local, 'brainfail');
      const sendLocal = async (text: string) => {
        const clientMsgId = randomUUID();
        const res = await local.inject({
          method: 'POST', url: '/v1/commands', headers: { authorization: `Bearer ${u.token}` },
          payload: { kind: 'command', clientMsgId, type: 'send_message', threadId: u.threadId, payload: { text }, sentAt: new Date().toISOString() },
        });
        expect(JSON.parse(res.body).status).toBe('accepted');
        return clientMsgId;
      };

      const boom = await sendLocal('boom');
      const boomEvents = await waitForAction(boom, 'command.processed');
      expectOneConsistentTrace(boomEvents, boom);
      expect(boomEvents.find((e) => e.action === 'brain.error')).toMatchObject({ outcome: 'failure', errorCode: 'brain_failed', riskLevel: 'medium' });
      expect(boomEvents.find((e) => e.action === 'command.processed')).toMatchObject({ outcome: 'failure', errorCode: 'brain_error' });
      expectNoSecrets(boomEvents, 'bob@example.com', 'abc123');

      const bad = await sendLocal('bad');
      const badEvents = await waitForAction(bad, 'command.processed');
      expectOneConsistentTrace(badEvents, bad);
      expect(badEvents.find((e) => e.action === 'brain.error')).toMatchObject({ errorCode: 'invalid_brain_output', details: { output: { type: 'nonsense' } } });
      expect(badEvents.find((e) => e.action === 'command.processed')!.outcome).toBe('success');
    } finally {
      await local.close();
    }
  });

  it('audits ask expiry (approval.expired) under a job-run traceId', async () => {
    const u = await createTestUser(app, 'expiry');
    const goal = createGoalCommand(u.threadId, 'Expiry goal');
    const res = await app.inject({ method: 'POST', url: '/v1/commands', headers: { authorization: `Bearer ${u.token}` }, payload: goal });
    expect(JSON.parse(res.body).status).toBe('accepted');
    const evs = await waitForEvents(app, u.token, (all) => all.some((e) => e.type === 'ask'));
    const askId = evs.find((e) => e.type === 'ask').payload.askId;
    await pool.query("UPDATE asks SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1", [askId]);

    await runAsJob(() => processExpiredAsks());
    const found = await pool.query<{ payload: AuditEvent }>(
      "SELECT payload FROM audit_outbox WHERE payload->>'action' = 'approval.expired' AND payload->'target'->>'id' = $1",
      [askId]
    );
    expect(found.rows).toHaveLength(1);
    const expired = found.rows[0].payload;
    expect(expired).toMatchObject({ outcome: 'success', actor: { type: 'system', id: 'ask-expiry' }, details: { resolution: expect.any(String) } });
    expect(expired.traceId).not.toBe(goal.clientMsgId); // a job run is its own root
    const jobTrace = await eventsForTrace(expired.traceId);
    expect(jobTrace.map((e) => e.action).sort()).toEqual(['approval.expired', 'system.job_run']);
    expectOneConsistentTrace(jobTrace, expired.traceId);
  });
});

describe('auth audit', () => {
  it('audits sign-in (sign_in + session_issued), denied sign-in, sign-out and rejected bearer tokens', async () => {
    const email = `signin-${randomUUID()}@example.com`;
    const idToken = await firebase.mint({ email });
    const ok = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { idToken } });
    expect(ok.statusCode).toBe(200);
    const { token, user } = JSON.parse(ok.body);
    const signInTrace = ok.headers['x-trace-id'] as string;
    const signIn = await waitForAction(signInTrace, 'auth.session_issued');
    expectOneConsistentTrace(signIn, signInTrace);
    expect(signIn.map((e) => e.action)).toEqual(['auth.sign_in', 'auth.session_issued']);
    expect(signIn[0]).toMatchObject({ outcome: 'success', userId: user.id, details: { method: 'firebase' } });
    expectNoSecrets(signIn, email, token, idToken);

    const bad = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { idToken: 'not-a-token' } });
    expect(bad.statusCode).toBe(401);
    const denied = await waitForAction(bad.headers['x-trace-id'] as string, 'auth.denied');
    expect(denied[0]).toMatchObject({ outcome: 'failure', riskLevel: 'medium', details: { method: 'firebase' } });
    expect(denied[0].errorCode).toBeTruthy();
    expectNoSecrets(denied, 'not-a-token');

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(out.statusCode).toBe(204);
    const signOut = await waitForAction(out.headers['x-trace-id'] as string, 'auth.session_revoked');
    expectOneConsistentTrace(signOut, out.headers['x-trace-id'] as string);
    expect(signOut.map((e) => e.action)).toEqual(['auth.sign_out', 'auth.session_revoked']);
    expect(signOut[0].userId).toBe(user.id);

    // The revoked token is now rejected and audited (throttled per client).
    const rejected = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(rejected.statusCode).toBe(401);
    const bearerDenied = await waitForAction(rejected.headers['x-trace-id'] as string, 'auth.denied');
    expect(bearerDenied[0]).toMatchObject({ outcome: 'denied', errorCode: 'invalid_token', target: { type: 'route', id: 'GET /v1/auth/me' } });
    expectNoSecrets(bearerDenied, token);
    const missing = await app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(missing.statusCode).toBe(401);
    await waitForAction(missing.headers['x-trace-id'] as string, 'auth.denied');
  });
});

describe('trace headers', () => {
  it('returns X-Trace-Id on every response and exposes it to browsers (CORS)', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.headers['x-trace-id']).toMatch(/^[0-9a-f-]{36}$/);
    const other = await app.inject({ method: 'GET', url: '/health' });
    expect(other.headers['x-trace-id']).not.toBe(health.headers['x-trace-id']);

    const cors = await app.inject({
      method: 'GET', url: '/health', headers: { origin: config.cors.origin[0] },
    });
    expect(String(cors.headers['access-control-expose-headers']).toLowerCase()).toContain('x-trace-id');
  });
});

describe('SSE connect/disconnect audit', () => {
  it('audits connect and disconnect under the stream request’s traceId', async () => {
    const server = await buildApp({ startBackgroundJobs: false });
    await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = server.server.address() as { port: number };
      const u = await createTestUser(server, 'sse-audit');
      const sse = await openSSE(`http://127.0.0.1:${address.port}`, { token: u.token });
      expect(sse.status).toBe(200);
      const traceId = sse.headers.get('x-trace-id')!;
      expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
      await waitForAction(traceId, 'data_access.read', 1);
      sse.close();
      await sse.closed;
      const events = await waitForAction(traceId, 'data_access.read', 2);
      expect(events.map((e) => e.details.phase)).toEqual(['connect', 'disconnect']);
      expect(events.every((e) => e.target?.type === 'event_stream' && e.riskLevel === 'low')).toBe(true);
      expect(events[1].parentSpanId).toBe(events[0].spanId);
      expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
      expectOneConsistentTrace(events, traceId);
    } finally {
      await server.close();
    }
  });
});

describe('audit relay publishes to the Redis Stream', () => {
  it('publishes unpublished rows in order, marks them published, and leaves proba:events untouched', async () => {
    const topic = `proba.audit.test.${randomUUID()}`;
    // Isolate from rows written by the other tests in this file.
    await pool.query('UPDATE audit_outbox SET published_at = now() WHERE published_at IS NULL');

    const audit = getAudit();
    await runAsJob(async () => {
      await transaction(async (client) => {
        for (const action of ['system.started', 'system.job_run', 'system.stopped'] as const) {
          await audit.emit({ action, outcome: 'success' }, { tx: client });
        }
      });
    });
    expect(await new PostgresOutboxStore({ pool }).pendingCount()).toBe(3);

    const watcher = redisClient.duplicate();
    await watcher.connect();
    const seen: string[] = [];
    await watcher.subscribe('proba:events', (message) => seen.push(message));

    const relay = createAuditRelay({ topic });
    expect(await relay.runOnce()).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(await new PostgresOutboxStore({ pool }).pendingCount()).toBe(0);

    const entries = await redisClient.xRange(topic, '-', '+');
    expect(entries).toHaveLength(3);
    const published = entries.map((e) => JSON.parse(e.message.data) as AuditEvent);
    expect(published.map((e) => e.action)).toEqual(['system.started', 'system.job_run', 'system.stopped']);
    expect(published.every((e) => validateAuditEvent(e).success)).toBe(true);
    expect(entries.every((e) => typeof e.message.publishedAt === 'string')).toBe(true);
    const rows = await pool.query<{ event_id: string; published: boolean }>(
      "SELECT payload->>'eventId' AS event_id, published_at IS NOT NULL AS published FROM audit_outbox WHERE payload->>'eventId' = ANY($1::text[]) ORDER BY audit_outbox.id",
      [published.map((e) => e.eventId)]
    );
    expect(rows.rows.map((r) => r.event_id)).toEqual(published.map((e) => e.eventId)); // stream order == outbox (id) order
    expect(rows.rows.every((r) => r.published)).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]); // the SSE pub/sub channel got nothing from the audit relay
    await watcher.unsubscribe('proba:events');
    await watcher.quit();
    await redisClient.del(topic);
  });

  it('AUDIT_RELAY_ENABLED is off under test so suites control the relay; the stream name matches proba-audit', () => {
    expect(config.audit.relayEnabled).toBe(false);
    expect(config.audit.stream).toBe('proba.audit.events');
    expect(config.audit.workspaceId).toBe('seedbed');
  });
});
