import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createTestUser, waitForCommandStatus, waitForEvents, type TestUser } from './test-helpers.js';
import type { BrainPort } from './types.js';

async function run(
  app: FastifyInstance,
  user: TestUser,
  threadId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<string> {
  const clientMsgId = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: `Bearer ${user.token}` },
    payload: { kind: 'command', clientMsgId, type, threadId, payload, sentAt: new Date().toISOString() },
  });
  expect(JSON.parse(res.body).status).toBe('accepted');
  await waitForCommandStatus(user.userId, clientMsgId, 'processed', { timeout: 10000 });
  return clientMsgId;
}

async function audit(traceId: string): Promise<Array<{ action: string; outcome: string; details: Record<string, any> }>> {
  const result = await pool.query("SELECT payload FROM audit_outbox WHERE payload->>'traceId' = $1 ORDER BY id", [traceId]);
  return result.rows.map((r) => r.payload);
}

const goalStatus = async (threadId: string) =>
  (await pool.query<{ status: string; progress: { completed: number } | null }>(
    'SELECT status, progress FROM goals WHERE thread_id = $1',
    [threadId]
  )).rows[0];

/** Walk a scenario to its costed action ask (clarify -> plan -> approve plan -> action approval). */
async function reachBudgetAsk(app: FastifyInstance, user: TestUser, withClarify: boolean) {
  await run(app, user, user.threadId, 'create_goal', {
    title: 'Spring campaign',
    constraints: [],
    budget: { daily: 100, total: 1000, currency: 'USD' },
  });
  let events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask'));
  if (withClarify) {
    const clarify = events.find((e) => e.type === 'ask' && e.payload.askType === 'clarify');
    await run(app, user, user.threadId, 'answer_ask', { askId: clarify.payload.askId, choice: 'approve', values: { audience: 'active' } });
    events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'plan_approval'));
  }
  const plan = events.find((e) => e.type === 'ask' && e.payload.askType === 'plan_approval');
  await run(app, user, user.threadId, 'approve_plan', { planId: plan.payload.askId, approved: true });
  events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'action_approval'));
  return events.find((e) => e.type === 'ask' && e.payload.askType === 'action_approval');
}

describe('a declined budget does not launch (scenario brain)', () => {
  const appPromise = buildApp({ startBackgroundJobs: true, brainScenario: 'happy_path' });
  afterAll(async () => {
    await (await appPromise).close();
  });

  it('acknowledges the decline, keeps the goal from going live and audits enforced: true', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'decline');
    const ask = await reachBudgetAsk(app, user, true);

    const declined = await run(app, user, user.threadId, 'answer_ask', { askId: ask.payload.askId, choice: 'reject' });
    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.type === 'message' && /will not launch/.test(e.payload.text))
    );

    // Nothing launched: no launch message or decision, no live metrics, goal paused and short of "campaign live".
    const texts = events.filter((e) => e.type === 'message').map((e) => String(e.payload.text));
    expect(texts.some((t) => /Launching campaign/.test(t))).toBe(false);
    expect(events.some((e) => e.type === 'goal_updated' && e.payload.metrics?.impressions > 0)).toBe(false);
    const goal = await goalStatus(user.threadId);
    expect(goal.status).toBe('paused');
    expect(goal.progress?.completed ?? 0).toBeLessThan(4);

    const trail = await audit(declined);
    expect(trail.find((e) => e.action === 'goal.budget_declined')!.details).toMatchObject({ enforced: true, proposedCost: 120 });
    expect(trail.find((e) => e.action === 'budget.evaluated')).toMatchObject({
      outcome: 'denied',
      details: { decision: 'declined', enforced: true },
    });
  });

  it('still launches when the budget is approved', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'approve');
    const ask = await reachBudgetAsk(app, user, true);
    const approved = await run(app, user, user.threadId, 'answer_ask', { askId: ask.payload.askId, choice: 'approve' });
    await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'goal_updated' && e.payload.metrics?.impressions > 0));
    expect((await goalStatus(user.threadId)).status).toBe('active');
    const trail = await audit(approved);
    expect(trail.find((e) => e.action === 'goal.budget_approved')!.details).toMatchObject({ enforced: false });
    expect(trail.map((e) => e.action)).not.toContain('budget.evaluated');
  });
});

describe('editing an approval is not a decline', () => {
  const appPromise = buildApp({ startBackgroundJobs: true, brainScenario: 'approval_edit' });
  afterAll(async () => {
    await (await appPromise).close();
  });

  it('keeps the goal going and audits the budget as approved with edited: true', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'edit');
    const ask = await reachBudgetAsk(app, user, false);
    const edited = await run(app, user, user.threadId, 'answer_ask', { askId: ask.payload.askId, choice: 'edit', edit: '110' });
    await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'message' && /adjusted budget/.test(e.payload.text)));
    expect((await goalStatus(user.threadId)).status).toBe('active');
    const trail = await audit(edited);
    expect(trail.map((e) => e.action)).not.toContain('goal.budget_declined');
    expect(trail.find((e) => e.action === 'goal.budget_approved')!.details).toMatchObject({ edited: true, enforced: false });
  });
});

describe('a declined budget is enforced whatever the brain does', () => {
  // A brain that ignores the decline: it proposes the same tool again and reports the campaign as live.
  let lastCommand = '';
  const stubborn: BrainPort & { takeGoalUpdate: () => unknown } = {
    process: async (command) => {
      lastCommand = command.type;
      return command.type === 'create_goal'
        ? [{ type: 'reply', text: 'Goal noted.' }]
        : command.type === 'answer_ask'
        ? [
            { type: 'reply', text: 'Launching anyway.' },
            {
              type: 'tool_call', tool: 'adjust_budget', parameters: { dailyBudget: 120 }, needsApproval: false, risk: 'medium',
              costImpact: { current: 100, proposed: 120 },
            },
          ]
        : [{
            type: 'tool_call', tool: 'adjust_budget', parameters: { dailyBudget: 120 }, needsApproval: true, risk: 'medium',
            costImpact: { current: 100, proposed: 120 },
          }];
    },
    // Only the answer to the budget ask claims the campaign is live.
    takeGoalUpdate: () =>
      lastCommand === 'answer_ask'
        ? { status: 'active', progress: { completed: 4, total: 4 }, metrics: { spend: 50, impressions: 1000, clicks: 10, conversions: 1 } }
        : undefined,
  };
  const appPromise = buildApp({ startBackgroundJobs: true, brain: stubborn });
  afterAll(async () => {
    await (await appPromise).close();
  });

  it('drops the brain tool calls and ignores the progress it reports', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'stubborn');
    await run(app, user, user.threadId, 'create_goal', { title: 'Costed goal', constraints: [], budget: { daily: 100, currency: 'USD' } });
    await run(app, user, user.threadId, 'send_message', { text: 'raise the budget' });
    const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask' && e.payload.askType === 'action_approval'));
    const ask = events.find((e) => e.type === 'ask' && e.payload.askType === 'action_approval');

    const declined = await run(app, user, user.threadId, 'answer_ask', { askId: ask.payload.askId, choice: 'reject' });

    // The proposal is not applied: no second ask, no tool event, and the goal waits.
    const asks = await pool.query('SELECT 1 FROM asks WHERE thread_id = $1', [user.threadId]);
    expect(asks.rowCount).toBe(1);
    const goal = await goalStatus(user.threadId);
    expect(goal.status).toBe('paused');
    const last = (await pool.query<{ payload: { metrics?: { impressions: number } } }>(
      "SELECT payload FROM events WHERE user_id = $1 AND type = 'goal_updated' ORDER BY seq DESC LIMIT 1",
      [user.userId]
    )).rows[0];
    expect(last.payload.metrics?.impressions ?? 0).toBe(0);

    const trail = await audit(declined);
    expect(trail.find((e) => e.action === 'budget.evaluated')!.details).toMatchObject({ enforced: true, droppedToolCalls: 1 });
    expect(trail.map((e) => e.action)).not.toContain('tool.proposed');
  });
});
