/**
 * Isolated PG contract tests for the Hub analytics and action bot.
 *
 * REAL: Hub routes, AnalyticsService, Postgres tables, coalescing, audit outbox rows.
 * FAKE: the gateway (FakeAnalyticsGatewayClient / FakeResearchGatewayClient). No
 * evaluator, no Ads domain, no provider, no model, no network, no spend.
 * The scheduler is off by default and is driven here by calling scheduleTick().
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { config } from './config.js';
import { AnalyticsService } from './analytics/service.js';
import { getAudit } from './audit/service.js';
import { GatewayBrain } from './brain/gateway-brain.js';
import { PostgresGatewayRunStore } from './brain/postgres-gateway-run-store.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createTestUser, postCommand, waitForEvents, waitUntil, type TestUser } from './test-helpers.js';
import { FAKE_ANALYTICS_GATEWAY_LABEL, FakeAnalyticsGatewayClient } from './testing/fake-analytics-gateway.js';
import { FakeResearchGatewayClient } from './testing/fake-research-gateway.js';

const tokens = { kid: 'hub-gw-1', mint: async () => 'svc.jwt.token' };
const CREATIVE = { type: 'TEXT', headline: 'Operator headline', body: 'Operator-approved body text.' };

async function insertGoal(user: TestUser): Promise<string> {
  const goal = await pool.query<{ id: string }>(
    `INSERT INTO goals (user_id, thread_id, title, status) VALUES ($1, $2, 'Analytics goal', 'active') RETURNING id`,
    [user.userId, user.threadId]
  );
  return goal.rows[0]!.id;
}

async function auditActions(userId: string): Promise<string[]> {
  const rows = await pool.query<{ action: string }>(
    `SELECT payload->>'action' AS action FROM audit_outbox WHERE payload->'actor'->>'userId' = $1
       OR payload->>'userId' = $1 OR payload::text LIKE '%' || $1 || '%' ORDER BY id`,
    [userId]
  );
  return rows.rows.map((r) => r.action);
}

describe('Hub analytics and action bot (FAKE gateway, real Postgres)', () => {
  const fake = new FakeAnalyticsGatewayClient();
  let clock = new Date();
  let app: FastifyInstance;
  let service: AnalyticsService;
  let user: TestUser;
  let other: TestUser;

  const inject = (u: TestUser, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${u.token}` },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    await runMigrations();
    fake.now = () => clock;
    service = new AnalyticsService({
      client: fake,
      serviceTokens: tokens,
      assertions: null,
      workspaceId: config.audit.workspaceId,
      tokenTtlSeconds: 120,
      cadenceMs: 6 * 60 * 60 * 1000,
      audit: getAudit(),
      now: () => clock,
    });
    app = await buildApp({ analytics: service, startBackgroundJobs: false });
    user = await createTestUser(app, 'analytics');
    other = await createTestUser(app, 'analytics-other');
  });

  afterAll(async () => {
    await app.close();
  });

  it('scheduled analytics reviews are off by default', () => {
    expect(config.analytics.scheduleEnabled).toBe(false);
    expect(fake.label).toBe(FAKE_ANALYTICS_GATEWAY_LABEL);
  });

  it('registers a campaign, reports metrics with unknown kept unknown, and coalesces the same window', async () => {
    const goalId = await insertGoal(user);
    const campaignId = `pc-${randomUUID()}`;
    const reg = await inject(user, 'POST', '/v1/analytics/campaigns', {
      goalId,
      probaCampaignId: campaignId,
      platform: 'reddit',
      accountId: 'acct-1',
      currentDailyBudget: 40,
      currency: 'usd',
      rules: { pauseWhen: { minSpend: 50, maxConversions: 0 } },
    });
    expect(reg.statusCode).toBe(201);
    expect(JSON.parse(reg.body).campaign.reviewEnabled).toBe(true);

    const dup = await inject(user, 'POST', '/v1/analytics/campaigns', { goalId, probaCampaignId: campaignId, platform: 'reddit' });
    expect(dup.statusCode).toBe(409);
    const zero = await inject(user, 'POST', '/v1/analytics/campaigns', {
      goalId,
      probaCampaignId: `pc-${randomUUID()}`,
      platform: 'reddit',
      currentDailyBudget: 0,
    });
    expect(zero.statusCode).toBe(400);

    fake.metrics.set(campaignId, [{ impressions: 1000, clicks: 'unknown', spend: 60, conversions: 0 }]);
    const before = fake.calls.length;
    const first = await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, {});
    expect(first.statusCode).toBe(200);
    const review = JSON.parse(first.body).review;
    expect(review.status).toBe('completed');
    expect(review.outcome).toBe('report');
    expect(review.summary.unknownMetrics).toBe(true);
    expect(review.summary.metrics[0].clicks).toBe('unknown');
    expect(fake.calls.length).toBe(before + 1);
    expect(fake.calls.at(-1)?.stepType).toBe('review_performance');

    const again = await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, {});
    expect(JSON.parse(again.body).review.coalesced).toBe(true);
    expect(fake.calls.length).toBe(before + 1);

    // Another owner cannot see or review this campaign.
    const foreign = await inject(other, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, {});
    expect(foreign.statusCode).toBe(404);
    const otherList = await inject(other, 'GET', '/v1/analytics/reviews');
    expect(JSON.parse(otherList.body).reviews).toHaveLength(0);
  });

  it('scheduled tick turns an owner rule into a pending pause proposal; approve executes once, audited', async () => {
    const goalId = await insertGoal(user);
    const campaignId = `pc-${randomUUID()}`;
    await inject(user, 'POST', '/v1/analytics/campaigns', {
      goalId,
      probaCampaignId: campaignId,
      platform: 'reddit',
      rules: { pauseWhen: { minSpend: 50, maxConversions: 0 } },
    });
    fake.metrics.set(campaignId, [{ impressions: 900, clicks: 12, spend: 75, conversions: 0 }]);
    await service.runReview(user.userId, campaignId, { trigger: 'manual', intent: 'report' });
    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    await service.scheduleTick();

    const pending = JSON.parse((await inject(user, 'GET', '/v1/analytics/proposals?status=pending')).body).proposals;
    const proposal = pending.find((p: { probaCampaignId: string }) => p.probaCampaignId === campaignId);
    expect(proposal).toBeDefined();
    expect(proposal.verb).toBe('ads.pause_campaign');
    expect(proposal.args).toEqual({ probaCampaignId: campaignId });
    expect(fake.executed).toHaveLength(0);

    const notMine = await inject(other, 'POST', `/v1/analytics/proposals/${proposal.id}/decision`, { decision: 'approve' });
    expect(notMine.statusCode).toBe(404);

    // Paused execution blocks approval.
    await pool.query(
      `INSERT INTO execution_state (user_id, state) VALUES ($1, 'paused')
       ON CONFLICT (user_id) DO UPDATE SET state = 'paused'`,
      [user.userId]
    );
    const blocked = await inject(user, 'POST', `/v1/analytics/proposals/${proposal.id}/decision`, { decision: 'approve' });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.body).error).toBe('execution_paused');
    const userCalls = () => fake.calls.filter((c) => c.userId === user.userId).length;
    const callsWhilePaused = userCalls();
    await service.scheduleTick();
    expect(userCalls()).toBe(callsWhilePaused);
    await pool.query(`UPDATE execution_state SET state = 'running' WHERE user_id = $1`, [user.userId]);

    const approved = await inject(user, 'POST', `/v1/analytics/proposals/${proposal.id}/decision`, { decision: 'approve' });
    expect(approved.statusCode).toBe(200);
    const result = JSON.parse(approved.body).proposal;
    expect(result.status).toBe('executed');
    expect(result.outcome.grantsSpend).toBe(false);
    expect(fake.executed).toEqual([{ verb: 'ads.pause_campaign', args: { probaCampaignId: campaignId } }]);
    const call = fake.calls.at(-1)!;
    expect(call.stepType).toBe('handle_approval');
    expect(call.resume).toEqual({ askId: proposal.id, choice: 'approve' });
    expect((call.command as { payload: { analyticsAction: { decisionId: string } } }).payload.analyticsAction.decisionId).toBe(
      proposal.decisionId
    );

    const twice = await inject(user, 'POST', `/v1/analytics/proposals/${proposal.id}/decision`, { decision: 'approve' });
    expect(twice.statusCode).toBe(409);
    expect(fake.executed).toHaveLength(1);

    await waitUntil(async () => (await auditActions(user.userId)).includes('campaign.paused'));
    const actions = await auditActions(user.userId);
    expect(actions).toEqual(expect.arrayContaining(['approval.requested', 'approval.granted', 'campaign.paused']));
  });

  it('cap proposal: reject never calls the gateway; expired cannot be approved; failed action is recorded', async () => {
    const goalId = await insertGoal(user);
    const campaignId = `pc-${randomUUID()}`;
    await inject(user, 'POST', '/v1/analytics/campaigns', {
      goalId,
      probaCampaignId: campaignId,
      platform: 'microsoft',
      currentDailyBudget: 50,
      currency: 'USD',
    });
    const up = await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, {
      intent: 'propose_cap',
      dailyBudget: 80,
    });
    expect(up.statusCode).toBe(400);
    expect(JSON.parse(up.body).error).toBe('cap_not_decrease');

    await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, { intent: 'propose_cap', dailyBudget: 30 });
    let pending = (await service.listProposals(user.userId, 'pending')).filter((p) => p.probaCampaignId === campaignId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.args.dailyBudget).toBe(30);
    const callsBefore = fake.calls.length;
    const rejected = await inject(user, 'POST', `/v1/analytics/proposals/${pending[0]!.id}/decision`, { decision: 'reject' });
    expect(JSON.parse(rejected.body).proposal.status).toBe('rejected');
    expect(fake.calls.length).toBe(callsBefore);

    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, { intent: 'propose_cap', dailyBudget: 25 });
    pending = (await service.listProposals(user.userId, 'pending')).filter((p) => p.probaCampaignId === campaignId);
    const expiring = pending[0]!;
    clock = new Date(Date.parse(expiring.reviewWindowUntil) + 1000);
    const late = await inject(user, 'POST', `/v1/analytics/proposals/${expiring.id}/decision`, { decision: 'approve' });
    expect(late.statusCode).toBe(409);
    expect(JSON.parse(late.body).error).toBe('proposal_expired');
    expect((await service.getProposal(user.userId, expiring.id)).status).toBe('expired');

    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, { intent: 'propose_cap', dailyBudget: 20 });
    pending = (await service.listProposals(user.userId, 'pending')).filter((p) => p.probaCampaignId === campaignId);
    fake.failNextAction = 'billing_unverified';
    const failed = await inject(user, 'POST', `/v1/analytics/proposals/${pending[0]!.id}/decision`, { decision: 'approve' });
    const failedBody = JSON.parse(failed.body).proposal;
    expect(failedBody.status).toBe('failed');
    expect(failedBody.outcome.code).toBe('billing_unverified');
    const campaigns = await service.listCampaigns(user.userId);
    expect(campaigns.find((c) => c.probaCampaignId === campaignId)?.currentDailyBudget).toBe(50);

    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, { intent: 'propose_cap', dailyBudget: 20 });
    pending = (await service.listProposals(user.userId, 'pending')).filter((p) => p.probaCampaignId === campaignId);
    const ok = await inject(user, 'POST', `/v1/analytics/proposals/${pending[0]!.id}/decision`, { decision: 'approve' });
    expect(JSON.parse(ok.body).proposal.status).toBe('executed');
    const after = await service.listCampaigns(user.userId);
    expect(after.find((c) => c.probaCampaignId === campaignId)?.currentDailyBudget).toBe(20);
  });

  it('a newer review supersedes an older pending proposal', async () => {
    const goalId = await insertGoal(user);
    const campaignId = `pc-${randomUUID()}`;
    await inject(user, 'POST', '/v1/analytics/campaigns', { goalId, probaCampaignId: campaignId, platform: 'google' });
    await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, { intent: 'propose_pause' });
    const first = (await service.listProposals(user.userId, 'pending')).find((p) => p.probaCampaignId === campaignId)!;
    clock = new Date(clock.getTime() + 7 * 60 * 60 * 1000);
    await inject(user, 'POST', `/v1/analytics/campaigns/${campaignId}/review`, { intent: 'propose_pause' });
    expect((await service.getProposal(user.userId, first.id)).status).toBe('superseded');
    const stale = await inject(user, 'POST', `/v1/analytics/proposals/${first.id}/decision`, { decision: 'approve' });
    expect(stale.statusCode).toBe(409);
  });
});

describe('Hub approved creative forwarding (FAKE research gateway, real Postgres)', () => {
  const fake = new FakeResearchGatewayClient();
  let app: FastifyInstance;
  let user: TestUser;

  beforeAll(async () => {
    await runMigrations();
    const brain = new GatewayBrain({
      client: fake,
      serviceTokens: tokens,
      assertions: null,
      workspaceId: 'seedbed',
      tokenTtlSeconds: 120,
      store: new PostgresGatewayRunStore(),
    });
    app = await buildApp({ brain, analytics: null, startBackgroundJobs: true });
    user = await createTestUser(app, 'creative');
  });

  afterAll(async () => {
    await app.close();
  });

  it('owner-approved creative is stored on the goal and forwarded with the operator URL on the next command', async () => {
    const landing = `https://operator-entered.example/creative-${randomUUID()}`;
    await postCommand(app, user.token, {
      kind: 'command',
      clientMsgId: randomUUID(),
      type: 'create_goal',
      payload: { title: 'Creative goal', budget: { daily: 10, currency: 'USD' }, userSuppliedInput: { landingPageUrl: landing } },
      sentAt: new Date().toISOString(),
    });
    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === landing)
    );
    const ask = events.find((e) => e.payload?.research?.landingPageUrl === landing);
    const goal = await pool.query<{ id: string }>('SELECT id FROM goals WHERE thread_id = $1', [ask.threadId]);
    const goalId = goal.rows[0]!.id;

    const bad = await app.inject({
      method: 'PUT',
      url: `/v1/goals/${goalId}/creative`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { creative: { type: 'IMAGE', headline: 'x', mediaUrl: 'not a url' } },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/goals/${goalId}/creative`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { creative: CREATIVE, targeting: { subreddits: ['r/example'] } },
    });
    expect(put.statusCode).toBe(200);

    // Approval resumes replay the bound request unchanged; the next new command carries the creative.
    const before = fake.calls.length;
    await postCommand(app, user.token, {
      kind: 'command',
      clientMsgId: randomUUID(),
      type: 'send_message',
      threadId: ask.threadId,
      payload: { text: 'Use the approved creative for the Reddit post.' },
      sentAt: new Date().toISOString(),
    });
    await waitUntil(async () => fake.calls.length > before);
    expect(fake.calls.at(-1)?.userSuppliedInput).toEqual({
      landingPageUrl: landing,
      creative: CREATIVE,
      targeting: { subreddits: ['r/example'] },
    });
  });
});
