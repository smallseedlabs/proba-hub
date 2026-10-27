import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { getExecutionState } from './services/execution-state.js';
import { createTestUser, waitForCommandStatus, waitForEvents, waitUntil, type TestUser } from './test-helpers.js';
import type { BrainContext, BrainPort } from './types.js';
import type { BrainOutput, CommandEnvelope } from '@smallseedlabs/proba-protocol';

/** A brain that records what reached it. */
function recordingBrain(outputs: (command: CommandEnvelope) => BrainOutput[] = () => [{ type: 'reply', text: 'Noted.' }]) {
  const calls: Array<{ type: string; messages: string[] }> = [];
  const brain: BrainPort = {
    process: async (command: CommandEnvelope, context: BrainContext) => {
      calls.push({ type: command.type, messages: (context.messages ?? []).map((m) => `${m.source}:${m.text}`) });
      return outputs(command);
    },
  };
  return { brain, calls };
}

async function send(
  app: FastifyInstance,
  user: TestUser,
  type: string,
  payload: Record<string, unknown>,
  options: { threadId?: string | null; clientMsgId?: string } = {}
): Promise<string> {
  const clientMsgId = options.clientMsgId ?? randomUUID();
  const threadId = options.threadId === undefined ? user.threadId : options.threadId;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: `Bearer ${user.token}` },
    payload: { kind: 'command', clientMsgId, type, ...(threadId ? { threadId } : {}), payload, sentAt: new Date().toISOString() },
  });
  expect(JSON.parse(res.body).status).toBe('accepted');
  return clientMsgId;
}

/** Send and wait until the command is processed (or rejected by the gate). */
async function run(
  app: FastifyInstance,
  user: TestUser,
  type: string,
  payload: Record<string, unknown>,
  options: { threadId?: string | null; expect?: 'processed' | 'rejected' } = {}
): Promise<string> {
  const clientMsgId = await send(app, user, type, payload, options);
  await waitForCommandStatus(user.userId, clientMsgId, options.expect ?? 'processed', { timeout: 10000 });
  return clientMsgId;
}

const control = (app: FastifyInstance, user: TestUser, action: 'pause' | 'resume' | 'kill') =>
  run(app, user, 'control', { action });

async function messagesOf(threadId: string): Promise<Array<{ text: string; source: string }>> {
  const result = await pool.query<{ text: string; source: string }>(
    'SELECT text, source FROM messages WHERE thread_id = $1 ORDER BY created_at, source DESC',
    [threadId]
  );
  return result.rows;
}

async function errorCodes(userId: string): Promise<string[]> {
  const result = await pool.query<{ code: string }>(
    "SELECT payload->>'code' AS code FROM events WHERE user_id = $1 AND type = 'error' ORDER BY seq",
    [userId]
  );
  return result.rows.map((r) => r.code);
}

async function auditFor(traceId: string): Promise<Array<{ action: string; outcome: string; errorCode?: string; details: Record<string, any> }>> {
  const result = await pool.query("SELECT payload FROM audit_outbox WHERE payload->>'traceId' = $1 ORDER BY id", [traceId]);
  return result.rows.map((r) => r.payload);
}

describe('pause and emergency stop halt the workspace', () => {
  const { brain, calls } = recordingBrain();
  const appPromise = buildApp({ startBackgroundJobs: true, brain });

  afterAll(async () => {
    await (await appPromise).close();
  });

  it('pause persists the state and refuses later commands before the brain until resume', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'pause');
    calls.length = 0;

    await control(app, user, 'pause');
    expect(await getExecutionState(user.userId)).toBe('paused');

    const blocked = await run(app, user, 'send_message', { text: 'hello while paused' }, { expect: 'rejected' });
    expect(calls).toHaveLength(0); // the brain was never called
    expect(await messagesOf(user.threadId)).toEqual([]); // and the message was not recorded
    expect(await errorCodes(user.userId)).toEqual(['execution_paused']);
    const audit = await auditFor(blocked);
    expect(audit.find((e) => e.action === 'command.rejected')).toMatchObject({
      outcome: 'denied',
      errorCode: 'execution_paused',
      details: { commandType: 'send_message', executionState: 'paused' },
    });
    expect(audit.map((e) => e.action)).not.toContain('brain.llm_call');

    // Every non-control command type is refused, not just messages.
    await run(app, user, 'create_goal', { title: 'Blocked goal', constraints: [] }, { expect: 'rejected' });
    const goals = await pool.query('SELECT 1 FROM goals WHERE user_id = $1', [user.userId]);
    expect(goals.rowCount).toBe(0);
    expect(calls).toHaveLength(0);

    await control(app, user, 'resume');
    expect(await getExecutionState(user.userId)).toBe('running');
    await run(app, user, 'send_message', { text: 'hello after resume' });
    expect(calls.map((c) => c.type)).toEqual(['send_message']);
    expect(await messagesOf(user.threadId)).toEqual([
      { text: 'hello after resume', source: 'user' },
      { text: 'Noted.', source: 'brain' },
    ]);
  });

  it('kill stops until resume, and a pause does not lift a stop', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'kill');
    calls.length = 0;

    await control(app, user, 'kill');
    expect(await getExecutionState(user.userId)).toBe('stopped');
    await run(app, user, 'send_message', { text: 'still there?' }, { expect: 'rejected' });
    expect(await errorCodes(user.userId)).toEqual(['execution_stopped']);

    // Control still goes through while stopped; pause must not downgrade the stop.
    await control(app, user, 'pause');
    expect(await getExecutionState(user.userId)).toBe('stopped');
    await run(app, user, 'send_message', { text: 'now?' }, { expect: 'rejected' });
    expect(calls).toHaveLength(0);

    await control(app, user, 'resume');
    expect(await getExecutionState(user.userId)).toBe('running');
    await run(app, user, 'send_message', { text: 'back' });
    expect(calls.map((c) => c.type)).toEqual(['send_message']);
  });

  it('reports the resulting state on the status event and in the audit trail', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'status');
    const id = await control(app, user, 'kill');
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'status'));
    expect(events.find((e) => e.type === 'status')!.payload).toMatchObject({ state: 'kill', executionState: 'stopped' });
    expect((await auditFor(id)).find((e) => e.action === 'control.emergency_stopped')!.details).toMatchObject({
      scope: 'workspace',
      previousState: 'running',
      executionState: 'stopped',
    });
  });

  it('is per workspace: pausing one user leaves another running', async () => {
    const app = await appPromise;
    const paused = await createTestUser(app, 'paused');
    const other = await createTestUser(app, 'other');
    calls.length = 0;
    await control(app, paused, 'pause');
    await run(app, other, 'send_message', { text: 'unaffected' });
    expect(calls).toHaveLength(1);
    expect(await getExecutionState(other.userId)).toBe('running');
  });

  it('survives a restart: a new app instance reads the persisted state', async () => {
    const first = await appPromise;
    const user = await createTestUser(first, 'restart');
    await control(first, user, 'pause');

    const second = recordingBrain();
    const restarted = await buildApp({ startBackgroundJobs: false, brain: second.brain });
    try {
      await run(restarted, user, 'send_message', { text: 'after restart' }, { expect: 'rejected' });
      expect(second.calls).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  });

  it('refuses a burst of commands sent while paused', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'race');
    calls.length = 0;
    await control(app, user, 'pause');
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => send(app, user, 'send_message', { text: `burst ${i}` }))
    );
    await Promise.all(ids.map((id) => waitForCommandStatus(user.userId, id, 'rejected', { timeout: 10000 })));
    expect(calls).toHaveLength(0);
  });
});

describe('control racing other commands', () => {
  it('settles every command, gap-free, whatever the interleaving of pause, resume and messages', async () => {
    const { brain } = recordingBrain();
    const app = await buildApp({ startBackgroundJobs: true, brain });
    try {
      const user = await createTestUser(app, 'interleave');
      const actions = ['pause', 'resume', 'kill', 'resume'] as const;
      const ids = await Promise.all(
        Array.from({ length: 24 }, (_, i) =>
          i % 3 === 0
            ? send(app, user, 'control', { action: actions[(i / 3) % actions.length] })
            : send(app, user, 'send_message', { text: `message ${i}` })
        )
      );
      await waitUntil(
        async () => {
          const r = await pool.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM commands WHERE user_id = $1 AND status IN ('processed', 'rejected')",
            [user.userId]
          );
          return r.rows[0].n === ids.length;
        },
        { timeout: 20000, message: 'every command to settle' }
      );
      // Each command ended in exactly one outcome and the event sequence has no gaps (no lost or doubled event).
      const seqs = await pool.query<{ seq: string }>('SELECT seq FROM events WHERE user_id = $1 ORDER BY seq', [user.userId]);
      expect(seqs.rows.map((r) => Number(r.seq))).toEqual(seqs.rows.map((_, i) => i + 1));
      const stored = (await messagesOf(user.threadId)).filter((m) => m.source === 'user').length;
      const processed = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM commands WHERE user_id = $1 AND type = 'send_message' AND status = 'processed'",
        [user.userId]
      );
      // A message is stored if and only if it was let through.
      expect(stored).toBe(processed.rows[0].n);
    } finally {
      await app.close();
    }
  });
});

describe('typed user messages are stored', () => {
  const { brain, calls } = recordingBrain();
  const appPromise = buildApp({ startBackgroundJobs: true, brain });

  afterAll(async () => {
    await (await appPromise).close();
  });

  it('stores send_message text as source user, before the brain reads the thread, and keeps the brain reply and events', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'typed');
    calls.length = 0;
    await run(app, user, 'send_message', { text: 'Launch a spring campaign' });

    expect(await messagesOf(user.threadId)).toEqual([
      { text: 'Launch a spring campaign', source: 'user' },
      { text: 'Noted.', source: 'brain' },
    ]);
    // The brain saw the typed message in its context.
    expect(calls[0].messages).toContain('user:Launch a spring campaign');
    // Thread events are unchanged: the brain reply is still an event on the thread.
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'message'));
    expect(events.filter((e) => e.type === 'message').map((e) => e.payload.text)).toEqual(['Noted.']);
    // The audit event for the typed message (thread.message_received) is still written on accept.
    const received = await pool.query(
      "SELECT 1 FROM audit_outbox WHERE payload->>'action' = 'thread.message_received' AND payload->>'userId' = $1",
      [user.userId]
    );
    expect(received.rowCount).toBe(1);
  });

  it('stores the message of a conversation that starts without a thread, on the thread created for it', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'newthread');
    const id = await run(app, user, 'send_message', { text: 'A brand new conversation' }, { threadId: null });
    const row = await pool.query<{ thread_id: string }>(
      'SELECT thread_id FROM commands WHERE user_id = $1 AND client_msg_id = $2',
      [user.userId, id]
    );
    const messages = await messagesOf(row.rows[0].thread_id);
    expect(messages[0]).toEqual({ text: 'A brand new conversation', source: 'user' });
  });

  it('stores a retried message once', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'retry');
    const clientMsgId = await send(app, user, 'send_message', { text: 'only once' });
    await waitForCommandStatus(user.userId, clientMsgId, 'processed', { timeout: 10000 });
    // Same clientMsgId again: the duplicate is detected and nothing more is stored.
    await send(app, user, 'send_message', { text: 'only once' }, { clientMsgId });
    await waitUntil(async () => (await auditCount(user.userId, 'command.duplicate')) === 1, { message: 'duplicate audit' });
    expect((await messagesOf(user.threadId)).filter((m) => m.source === 'user')).toHaveLength(1);
  });

  async function auditCount(userId: string, action: string): Promise<number> {
    const r = await pool.query("SELECT count(*)::int AS n FROM audit_outbox WHERE payload->>'action' = $1 AND payload->>'userId' = $2", [action, userId]);
    return r.rows[0].n;
  }
});
