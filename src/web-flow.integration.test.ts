import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createUserWithPassword } from './auth/users.js';
import { waitForEvents } from './test-helpers.js';

/**
 * The flow exactly as proba-web drives it: password sign-in, create_goal
 * without a threadId, answer_ask without askType, approve_plan via the plan
 * card action, then the action approval. Goals/campaigns are fed by
 * goal_updated events.
 */
const app: FastifyInstance = await buildApp({ startBackgroundJobs: true, brainScenario: 'happy_path' });

function command(type: string, payload: Record<string, unknown>, threadId?: string) {
  return {
    kind: 'command',
    clientMsgId: randomUUID(),
    type,
    ...(threadId ? { threadId } : {}),
    payload,
    sentAt: new Date().toISOString(),
  };
}

describe('Web client flow (happy_path)', () => {
  let token: string;

  beforeAll(async () => {
    const email = `web-${randomUUID()}@example.com`;
    const { password } = await createUserWithPassword({ email, name: 'Web Flow' });
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
    expect(res.statusCode).toBe(200);
    token = JSON.parse(res.body).token;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = async (body: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).status).toBe('accepted');
  };

  it('runs goal → clarify → plan → approval → live campaign metrics', async () => {
    await post(command('create_goal', { title: 'Test demand for trail shoes', budget: { daily: 150, currency: 'GBP' } }));

    let events = await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'ask') && evs.some((e) => e.type === 'goal_updated'));
    const clarify = events.find((e) => e.type === 'ask');
    expect(clarify.payload.askType).toBe('clarify');
    expect(clarify.threadId).toBeTruthy();
    const threadId: string = clarify.threadId;

    const created = events.find((e) => e.type === 'goal_updated');
    expect(created.threadId).toBe(threadId);
    expect(created.payload).toMatchObject({ status: 'active', progress: { completed: 0, total: 4 } });
    expect(created.ui).toMatchObject({
      component: 'goal_summary',
      props: { title: 'Test demand for trail shoes', metrics: { budget: 150, currency: 'GBP' } },
    });
    const thread = await pool.query('SELECT title FROM threads WHERE id = $1', [threadId]);
    expect(thread.rows[0].title).toBe('Test demand for trail shoes');

    // proba-web answers with { askId, choice, values } and no askType.
    await post(command('answer_ask', { askId: clarify.payload.askId, choice: 'approve', values: { answer: 'active' } }, threadId));
    events = await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'plan_approval'));
    const resolved = events.find((e) => e.type === 'ask_resolved' && e.payload.askId === clarify.payload.askId);
    expect(resolved.payload.answer).toEqual({ choice: 'approve', values: { answer: 'active' } });
    const plan = events.find((e) => e.type === 'ask' && e.payload.askType === 'plan_approval');
    const approve = plan.ui.actions.find((a: { id: string }) => a.id === 'approve');

    // The plan card action carries the approve_plan command.
    await post(command(approve.command.type, approve.command.payload, threadId));
    events = await waitForEvents(app, token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'action_approval'));
    expect(events.some((e) => e.type === 'ask_resolved' && e.payload.askId === plan.payload.askId)).toBe(true);
    const asks = await pool.query('SELECT status FROM asks WHERE id = $1', [plan.payload.askId]);
    expect(asks.rows[0].status).toBe('answered');
    const action = events.find((e) => e.type === 'ask' && e.payload.askType === 'action_approval');

    await post(command('answer_ask', { askId: action.payload.askId, choice: 'approve' }, threadId));
    events = await waitForEvents(app, token, (evs) =>
      evs.some((e) => e.type === 'goal_updated' && e.payload.metrics?.impressions > 0)
    );
    const live = events.filter((e) => e.type === 'goal_updated').pop();
    expect(live.payload).toMatchObject({
      status: 'active',
      progress: { completed: 4, total: 4 },
      metrics: { spend: 84.5, impressions: 12840, clicks: 412, conversions: 23 },
    });
    expect(events.some((e) => e.type === 'message' && /Launching campaign/.test(e.payload.text))).toBe(true);

    const goals = await app.inject({ method: 'GET', url: '/v1/goals', headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(goals.body).goals[0]).toMatchObject({ status: 'active' });
  });

  it('starts a new thread for a message sent without one', async () => {
    await post(command('send_message', { text: 'Hello Proba' }));
    const events = await waitForEvents(app, token, (evs) =>
      evs.some((e) => e.type === 'message' && e.payload.text === 'Understood. Processing your request.')
    );
    const reply = events.find((e) => e.type === 'message' && e.payload.text === 'Understood. Processing your request.');
    expect(reply.threadId).toBeTruthy();
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
