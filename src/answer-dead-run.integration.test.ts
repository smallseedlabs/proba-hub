import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createTestUser, waitForCommandStatus, waitForEvents, type TestUser } from './test-helpers.js';
import type { BrainPort } from './types.js';
import { GatewayClientError } from './brain/gateway-client.js';

async function send(
  app: FastifyInstance,
  user: TestUser,
  type: string,
  payload: Record<string, unknown>,
  status: 'processed' | 'failed' = 'processed'
): Promise<string> {
  const clientMsgId = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: `Bearer ${user.token}` },
    payload: { kind: 'command', clientMsgId, type, threadId: user.threadId, payload, sentAt: new Date().toISOString() },
  });
  expect(JSON.parse(res.body).status).toBe('accepted');
  await waitForCommandStatus(user.userId, clientMsgId, status, { timeout: 10000 });
  return clientMsgId;
}

let failure: () => Error = () => new Error('unset');
const brain: BrainPort = {
  process: async (command) => {
    if (command.type === 'answer_ask' || command.type === 'approve_plan') throw failure();
    const text = String((command.payload as { text?: unknown }).text ?? '');
    if (text === 'plan') {
      return [
        {
          type: 'plan',
          title: 'Plan',
          description: 'd',
          steps: [{ id: 's1', title: 'a', description: 'a', estimatedCost: 1 }],
          totalCost: 1,
        },
      ];
    }
    return [
      { type: 'tool_call', tool: 'page.attach_user_page', parameters: { url: 'https://example.com/' }, needsApproval: true, risk: 'medium' },
    ];
  },
} as BrainPort;

async function openAsk(app: FastifyInstance, user: TestUser, askType: string, text = 'use my page') {
  await send(app, user, 'send_message', { text });
  const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === askType));
  return events.find((e) => e.type === 'ask' && e.payload.askType === askType).payload.askId as string;
}

async function askStatus(askId: string) {
  return (await pool.query<{ status: string }>('SELECT status FROM asks WHERE id = $1', [askId])).rows[0]?.status;
}

describe('an answer whose gateway run has ended closes the card instead of reopening it', () => {
  const appPromise = buildApp({ startBackgroundJobs: true, brain });
  afterAll(async () => {
    await (await appPromise).close();
  });

  it('policy_denied that failed the run: ask expired, error not retryable, command failed', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'dead-run-policy');
    const askId = await openAsk(app, user, 'action_approval');
    failure = () =>
      new GatewayClientError(
        'policy_denied',
        'ads.create_campaign needs operator-approved post copy. Save the Reddit post copy for this goal in Campaigns, then approve again',
        undefined,
        false,
        'failed'
      );
    const clientMsgId = await send(app, user, 'answer_ask', { askId, choice: 'approve' }, 'failed');
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'error'));
    const resolved = events.find((e) => e.type === 'ask_resolved' && e.payload.askId === askId);
    expect(resolved?.payload).toMatchObject({ askId, resolution: 'expired' });
    const error = events.find((e) => e.type === 'error');
    expect(error.payload).toMatchObject({ code: 'brain_error', askId, retryable: false });
    expect(error.payload.message).toMatch(/Save the Reddit post copy for this goal in Campaigns, then approve again/);
    expect(error.payload.message).toMatch(/This request is closed/);
    expect(resolved.seq).toBeLessThan(error.seq);
    expect(await askStatus(askId)).toBe('expired');
    const command = await pool.query<{ status: string; processed_at: Date | null }>(
      'SELECT status, processed_at FROM commands WHERE user_id = $1 AND client_msg_id = $2',
      [user.userId, clientMsgId]
    );
    expect(command.rows[0]).toMatchObject({ status: 'failed' });
    expect(command.rows[0]?.processed_at).not.toBeNull();
  });

  it('approval_expired (gateway no longer holds the approval) also closes the card', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'dead-run-expired');
    const askId = await openAsk(app, user, 'action_approval');
    failure = () => new GatewayClientError('approval_expired', 'no awaiting approval bound to this ask');
    await send(app, user, 'answer_ask', { askId, choice: 'approve' }, 'failed');
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'error'));
    expect(events.some((e) => e.type === 'ask_resolved' && e.payload.resolution === 'expired')).toBe(true);
    expect(events.find((e) => e.type === 'error').payload).toMatchObject({ askId, retryable: false });
    expect(await askStatus(askId)).toBe('expired');
  });

  it('a retryable failure keeps the ask pending, marks the command failed, and is retryable', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'live-run-retry');
    const askId = await openAsk(app, user, 'action_approval');
    failure = () => new GatewayClientError('timeout', 'gateway timed out', undefined, true);
    await send(app, user, 'answer_ask', { askId, choice: 'approve' }, 'failed');
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'error'));
    expect(events.some((e) => e.type === 'ask_resolved')).toBe(false);
    expect(events.find((e) => e.type === 'error').payload).toMatchObject({ askId, retryable: true });
    expect(await askStatus(askId)).toBe('pending');
  });

  it('approve_plan: a brain failure is handled (no rollback of the command), and a dead run expires the plan ask', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'plan-dead-run');
    const planId = await openAsk(app, user, 'plan_approval', 'plan');
    failure = () => new GatewayClientError('outcome_ambiguous', 'prior work did not finish cleanly', undefined, false, 'ambiguous');
    await send(app, user, 'approve_plan', { planId, approved: true }, 'failed');
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'error'));
    expect(events.find((e) => e.type === 'ask_resolved' && e.payload.askId === planId)?.payload).toMatchObject({
      resolution: 'expired',
    });
    expect(events.some((e) => e.type === 'ask_resolved' && e.payload.resolution === 'answered')).toBe(false);
    expect(events.find((e) => e.type === 'error').payload).toMatchObject({ askId: planId, retryable: false });
    expect(await askStatus(planId)).toBe('expired');
  });

  it('approve_plan: a retryable failure rolls back the decision and leaves the plan ask open', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'plan-retry');
    const planId = await openAsk(app, user, 'plan_approval', 'plan');
    failure = () => new GatewayClientError('unreachable', 'gateway is unreachable');
    await send(app, user, 'approve_plan', { planId, approved: true }, 'failed');
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'error'));
    expect(events.some((e) => e.type === 'ask_resolved')).toBe(false);
    expect(events.find((e) => e.type === 'error').payload).toMatchObject({ askId: planId, retryable: true });
    expect(await askStatus(planId)).toBe('pending');
  });
});
