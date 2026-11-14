import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createTestUser, waitForCommandStatus, waitForEvents, type TestUser } from './test-helpers.js';
import type { BrainPort } from './types.js';

async function send(app: FastifyInstance, user: TestUser, type: string, payload: Record<string, unknown>): Promise<void> {
  const clientMsgId = randomUUID();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: `Bearer ${user.token}` },
    payload: { kind: 'command', clientMsgId, type, threadId: user.threadId, payload, sentAt: new Date().toISOString() },
  });
  expect(JSON.parse(res.body).status).toBe('accepted');
  await waitForCommandStatus(user.userId, clientMsgId, 'processed', { timeout: 10000 });
}

const draft = {
  type: 'TEXT',
  headline: 'Waterproof boots for muddy UK trails',
  body: 'Light, grippy and dry on wet ground.',
  landingPageUrl: 'https://example.com/offer',
  rationale: 'Practical angle for hikers',
  claims: [],
};

let withPlan = false;
const seen: Array<{ type: string; creative?: unknown }> = [];
const brain: BrainPort = {
  process: async (command, context) => {
    seen.push({ type: command.type, creative: (context as { userSuppliedInput?: { creative?: unknown } }).userSuppliedInput?.creative });
    if (command.type === 'answer_ask') return [{ type: 'reply', text: 'saved' }];
    const parameters = withPlan
      ? { ...draft, targeting: { communities: ['UKhiking'], geolocations: ['GB'] }, plan: { platform: 'reddit', successMetric: 'clicks', successTarget: 200, durationDays: 14, reasons: { successMetric: 'chose clicks because no signup form' } } }
      : draft;
    return [{ type: 'tool_call', tool: 'creative.draft_post', parameters, needsApproval: true, risk: 'medium' }];
  },
} as BrainPort;

async function goalFor(user: TestUser): Promise<string> {
  const goal = await pool.query<{ id: string }>(
    `INSERT INTO goals (user_id, thread_id, title, description, user_supplied_input)
     VALUES ($1, $2, 'Boots', 'Validate demand', $3) RETURNING id`,
    [user.userId, user.threadId, JSON.stringify({ landingPageUrl: 'https://example.com/offer' })]
  );
  return goal.rows[0].id;
}

async function openDraftAsk(app: FastifyInstance, user: TestUser) {
  await send(app, user, 'send_message', { text: 'launch it' });
  const events = await waitForEvents(app, user.token, (evs) => evs.some((e) => e.type === 'ask'));
  return events.find((e) => e.type === 'ask');
}

describe('brain-drafted post copy (creative.draft_post)', () => {
  const appPromise = buildApp({ startBackgroundJobs: true, brain });
  afterAll(async () => {
    await (await appPromise).close();
  });

  it('shows an editable draft card; approve with edits saves the operator copy on the goal and the next brain step sees it', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'creative-draft-edit');
    const goalId = await goalFor(user);
    const ask = await openDraftAsk(app, user);
    expect(ask.payload.title).toBe('Review the Reddit post Proba drafted');
    const ui = await pool.query<{ props: Record<string, unknown> }>(
      `SELECT u.props FROM events e JOIN ui_payloads u ON u.id = e.ui_payload_id WHERE e.payload->>'askId' = $1`,
      [ask.payload.askId]
    );
    expect(ui.rows[0].props.creativeDraft).toMatchObject({ headline: draft.headline, body: draft.body, landingPageUrl: draft.landingPageUrl });
    const before = await pool.query('SELECT approved_creative FROM goals WHERE id = $1', [goalId]);
    expect(before.rows[0].approved_creative).toBeNull();

    await send(app, user, 'answer_ask', { askId: ask.payload.askId, choice: 'approve', values: { body: 'My own words about the boots.' } });
    const after = await pool.query('SELECT approved_creative, creative_approved_at FROM goals WHERE id = $1', [goalId]);
    expect(after.rows[0].approved_creative).toEqual({ type: 'TEXT', headline: draft.headline, body: 'My own words about the boots.' });
    expect(after.rows[0].creative_approved_at).not.toBeNull();
    expect(seen.at(-1)).toEqual({ type: 'answer_ask', creative: { type: 'TEXT', headline: draft.headline, body: 'My own words about the boots.' } });
  });

  it('reject saves nothing', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'creative-draft-reject');
    const goalId = await goalFor(user);
    const ask = await openDraftAsk(app, user);
    await send(app, user, 'answer_ask', { askId: ask.payload.askId, choice: 'reject' });
    const after = await pool.query('SELECT approved_creative FROM goals WHERE id = $1', [goalId]);
    expect(after.rows[0].approved_creative).toBeNull();
  });

  it('invalid edited copy is refused and the card stays pending', async () => {
    const app = await appPromise;
    const user = await createTestUser(app, 'creative-draft-invalid');
    const goalId = await goalFor(user);
    const ask = await openDraftAsk(app, user);
    await send(app, user, 'answer_ask', { askId: ask.payload.askId, choice: 'approve', values: { headline: 'x'.repeat(301) } });
    const status = await pool.query<{ status: string }>('SELECT status FROM asks WHERE id = $1', [ask.payload.askId]);
    expect(status.rows[0].status).toBe('pending');
    const after = await pool.query('SELECT approved_creative FROM goals WHERE id = $1', [goalId]);
    expect(after.rows[0].approved_creative).toBeNull();
  });

  it('plan card: one approval saves copy, targeting (with operator override) and the plan', async () => {
    withPlan = true;
    try {
      const app = await appPromise;
      const user = await createTestUser(app, 'creative-draft-plan');
      const goalId = await goalFor(user);
      const ask = await openDraftAsk(app, user);
      expect(ask.payload.title).toBe('Review the campaign plan Proba drafted');
      await send(app, user, 'answer_ask', { askId: ask.payload.askId, choice: 'approve', values: { communities: 'r/hiking' } });
      const row = await pool.query('SELECT approved_creative, approved_targeting, approved_plan FROM goals WHERE id = $1', [goalId]);
      expect(row.rows[0].approved_creative).toEqual({ type: 'TEXT', headline: draft.headline, body: draft.body });
      expect(row.rows[0].approved_targeting).toEqual({ communities: ['hiking'], geolocations: ['GB'] });
      expect(row.rows[0].approved_plan).toMatchObject({ platform: 'reddit', successMetric: 'clicks', successTarget: 200, durationDays: 14 });
    } finally {
      withPlan = false;
    }
  });
});
