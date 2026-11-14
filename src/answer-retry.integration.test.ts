import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createTestUser, waitForCommandStatus, waitForEvents, type TestUser } from './test-helpers.js';
import type { BrainPort } from './types.js';
import { GatewayClientError } from './brain/gateway-client.js';

async function run(
  app: FastifyInstance,
  user: TestUser,
  type: string,
  payload: Record<string, unknown>,
  waitProcessed = true
): Promise<string> {
  const clientMsgId = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: `Bearer ${user.token}` },
    payload: { kind: 'command', clientMsgId, type, threadId: user.threadId, payload, sentAt: new Date().toISOString() },
  });
  expect(JSON.parse(res.body).status).toBe('accepted');
  if (waitProcessed) await waitForCommandStatus(user.userId, clientMsgId, 'processed', { timeout: 10000 });
  return clientMsgId;
}

describe('a failed brain step after answer_ask leaves the ask open for retry', () => {
  let failNextAnswer = true;
  const brain: BrainPort = {
    process: async (command) => {
      if (command.type === 'answer_ask') {
        if (failNextAnswer) {
          failNextAnswer = false;
          throw new GatewayClientError('idempotency_conflict', 'idempotency key reused with a different request', 409);
        }
        return [{ type: 'reply', text: 'Change applied.' }];
      }
      return [
        { type: 'tool_call', tool: 'page.attach_user_page', parameters: { url: 'https://example.com/' }, needsApproval: true, risk: 'low' },
      ];
    },
  };
  const appPromise = buildApp({ startBackgroundJobs: true, brain });
  afterAll(async () => {
    await (await appPromise).close();
  });

  it('posts a clear failure, keeps the ask pending, and accepts a second answer', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'answer-retry');
    await run(app, user, 'send_message', { text: 'use my page' });
    let events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask'));
    const ask = events.find((e) => e.type === 'ask');
    const askId = ask.payload.askId as string;

    const failedMsgId = await run(app, user, 'answer_ask', { askId, choice: 'approve' }, false);
    // A failed brain step finishes the command as failed; it never stays accepted.
    await waitForCommandStatus(user.userId, failedMsgId, 'failed', { timeout: 10000 });
    events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'error'));
    const error = events.find((e) => e.type === 'error');
    expect(error.payload).toMatchObject({ code: 'brain_error', askId, retryable: true });
    expect(error.payload.message).toMatch(/did not match the original run \(nothing was spent\)/);
    expect(error.payload.message).toMatch(/Your answer was not recorded; the card is still open/);
    expect(events.some((e) => e.type === 'ask_resolved')).toBe(false);
    const pending = await pool.query<{ status: string }>('SELECT status FROM asks WHERE id = $1', [askId]);
    expect(pending.rows[0]?.status).toBe('pending');

    await run(app, user, 'answer_ask', { askId, choice: 'approve' });
    events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask_resolved'));
    expect(events.some((e) => e.type === 'ask_resolved' && e.payload.askId === askId)).toBe(true);
    const answered = await pool.query<{ status: string }>('SELECT status FROM asks WHERE id = $1', [askId]);
    expect(answered.rows[0]?.status).toBe('answered');
  });
});
