/**
 * Brain campaign reviewer, Hub side (FAKE gateway, real Postgres). Hub starts system-initiated reviews when
 * the brain's chosen check time comes (or an event wakes one), clamps that time to the tighten-only bounds,
 * stores the note, records checkpoints, and turns any change into a pending owner proposal. Nothing executes.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { config } from './config.js';
import { AnalyticsService } from './analytics/service.js';
import { reviewBoundsFrom } from './analytics/reviewer.js';
import { getAudit } from './audit/service.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createTestUser, type TestUser } from './test-helpers.js';
import { FakeAnalyticsGatewayClient } from './testing/fake-analytics-gateway.js';

const tokens = { kid: 'hub-gw-1', mint: async () => 'svc.jwt.token' };
const H = 3_600_000;

describe('brain campaign reviewer (FAKE gateway, real Postgres)', () => {
  const fake = new FakeAnalyticsGatewayClient();
  let clock = new Date();
  let app: FastifyInstance;
  let service: AnalyticsService;
  let user: TestUser;

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${user.token}` }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  const campaignRow = async (id: string) =>
    (await pool.query(`SELECT * FROM analytics_campaigns WHERE proba_campaign_id = $1`, [id])).rows[0] as Record<string, any>;

  beforeAll(async () => {
    await runMigrations();
    fake.now = () => clock;
    service = new AnalyticsService({
      client: fake,
      serviceTokens: tokens,
      assertions: null,
      workspaceId: config.audit.workspaceId,
      tokenTtlSeconds: 120,
      cadenceMs: 6 * H,
      reviewer: 'brain',
      reviewBounds: reviewBoundsFrom({ minCheckHours: 6, maxCheckHours: 72, maxAutoChangePct: 20 }),
      audit: getAudit(),
      now: () => clock,
    });
    app = await buildApp({ analytics: service, startBackgroundJobs: false });
    user = await createTestUser(app, 'reviewer');
  });

  afterAll(async () => {
    await app.close();
  });

  it('defaults to the brain reviewer within the locked bounds', () => {
    expect(config.analytics.reviewer).toBe('brain');
    expect(config.analytics.reviewBounds.maxCheckHours).toBeLessThanOrEqual(168);
    expect(config.analytics.reviewBounds.maxAutoChangePct).toBeLessThanOrEqual(20);
  });

  it('reviews when the brain chose, clamps its time, wakes on events, records checkpoints and proposes only', async () => {
    const goal = await pool.query<{ id: string }>(
      `INSERT INTO goals (user_id, thread_id, title, status) VALUES ($1, $2, 'Reviewer goal', 'active') RETURNING id`,
      [user.userId, user.threadId]
    );
    const campaignId = `pc-${randomUUID()}`;
    const reg = await inject('POST', '/v1/analytics/campaigns', {
      goalId: goal.rows[0]!.id,
      probaCampaignId: campaignId,
      platform: 'reddit',
      accountId: 'acct-1',
      currentDailyBudget: 5,
      currency: 'usd',
    });
    expect(reg.statusCode).toBe(201);
    const created = new Date((await campaignRow(campaignId)).created_at);
    clock = new Date(created.getTime() + 60_000);

    // Not before the minimum interval after launch.
    const calls = () => fake.calls.filter((c) => (c.command.payload as Record<string, unknown>).probaCampaignId === campaignId);
    await service.scheduleTick();
    expect(calls()).toHaveLength(0);

    // First look: the brain waits and asks for 200h; Hub clamps to the 72h maximum.
    clock = new Date(created.getTime() + 7 * H);
    fake.brainNotes.set(campaignId, {
      kind: 'review',
      decision: 'wait',
      summary: 'Too few clicks to judge.',
      whyNowOrNotYet: 'Only 7 hours of data.',
      nextCheckInHours: 200,
      nextCheckReason: 'wait for a few days of clicks',
    });
    await service.scheduleTick();
    expect(calls()).toHaveLength(1);
    const payload = calls()[0]!.command.payload as Record<string, any>;
    expect(payload).toMatchObject({ reviewIntent: 'brain', reviewTrigger: 'schedule', currentDailyBudget: 5, reviewBounds: { minCheckHours: 6, maxCheckHours: 72 } });
    expect(payload.checkpoint).toBeUndefined();
    let row = await campaignRow(campaignId);
    expect(new Date(row.next_check_at).getTime()).toBe(clock.getTime() + 72 * H);
    expect(row.next_check_reason).toBe('wait for a few days of clicks');

    // Not due again on the next tick.
    await service.scheduleTick();
    expect(calls()).toHaveLength(1);

    // A non-urgent event waits for the minimum interval; an urgent one runs on the next tick.
    let woke = await inject('POST', `/v1/analytics/campaigns/${campaignId}/wake`, { event: 'metrics_anomaly' });
    expect(woke.statusCode).toBe(200);
    expect(new Date(JSON.parse(woke.body).campaign.nextCheckAt).getTime()).toBe(clock.getTime() + 6 * H);
    woke = await inject('POST', `/v1/analytics/campaigns/${campaignId}/wake`, { event: 'ad_disapproved' });
    expect(new Date(JSON.parse(woke.body).campaign.nextCheckAt).getTime()).toBe(clock.getTime());
    expect((await inject('POST', `/v1/analytics/campaigns/${campaignId}/wake`, { event: 'bogus' })).statusCode).toBe(400);

    fake.brainNotes.set(campaignId, {
      kind: 'review',
      decision: 'change',
      summary: 'CPC is twice the plan for a full day.',
      whyNowOrNotYet: 'Spend pace is high; a 20% trim is small and reversible.',
      change: { action: 'lower_budget', dailyBudget: 4 },
      proposal: { withinAutoLimit: true, changePct: 20 },
      nextCheckInHours: 24,
      nextCheckReason: 'see if CPC settles',
    });
    await service.scheduleTick();
    expect(calls()).toHaveLength(2);
    expect((calls()[1]!.command.payload as Record<string, unknown>).wakeEvent).toBe('ad_disapproved');
    row = await campaignRow(campaignId);
    expect(row.wake_event).toBeNull();
    const proposals = await pool.query(`SELECT * FROM analytics_proposals WHERE proba_campaign_id = $1`, [campaignId]);
    expect(proposals.rows).toHaveLength(1);
    expect(proposals.rows[0]).toMatchObject({ verb: 'ads.update_campaign', status: 'pending' });
    expect(proposals.rows[0].reason).toContain('Spend pace is high');
    expect(new Date(proposals.rows[0].review_window_until).getTime()).toBe(clock.getTime() + 24 * H);
    expect(fake.executed).toHaveLength(0);

    // Day 3: the review is a checkpoint and is recorded once.
    clock = new Date(created.getTime() + 3.5 * 24 * H);
    fake.brainNotes.set(campaignId, {
      kind: 'checkpoint',
      decision: 'keep',
      summary: 'Behind on clicks.',
      whyNowOrNotYet: 'Day 3 checkpoint.',
      checkpoint: { checkpoint: 'day3', metric: 'clicks', target: 200, actual: 40, status: 'behind', recommendation: 'adjust', tweaks: [] },
      nextCheckInHours: 48,
      nextCheckReason: 'day 5 look',
    });
    await service.scheduleTick();
    expect(calls()).toHaveLength(3);
    expect((calls()[2]!.command.payload as Record<string, unknown>).checkpoint).toBe('day3');
    row = await campaignRow(campaignId);
    expect(row.checkpoints_done).toEqual(['day3']);

    const reviews = await inject('GET', `/v1/analytics/reviews?probaCampaignId=${campaignId}`);
    const list = JSON.parse(reviews.body).reviews as Array<Record<string, any>>;
    expect(list.filter((r) => r.intent === 'brain')).toHaveLength(3);
    expect(list.find((r) => r.summary?.review?.kind === 'checkpoint')?.summary.review.checkpoint.status).toBe('behind');

    const audit = await pool.query(
      `SELECT payload->'details' AS d FROM audit_outbox WHERE payload->>'action' = 'brain.decision_made' AND payload::text LIKE '%' || $1 || '%'`,
      [campaignId]
    );
    expect(audit.rows.some((r) => r.d.reviewer === 'brain' && r.d.decision === 'change' && r.d.grantsSpend === false)).toBe(true);
  });
});
