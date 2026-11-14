/**
 * Analytics and action bot, Hub side.
 *
 * - Owner registers a Proba campaign for review (scoped to one provider/account).
 * - Scheduled and manual reviews are coalesced per workspace+user+campaign per
 *   cadence window (unique row + stable gateway idempotency key).
 * - The gateway evaluator returns a report or a dry-run proposal. Proposals are
 *   stored as `pending` for the owner; they are never executed automatically.
 * - Only an explicit owner `approve` (while execution is running, before the
 *   review window ends) sends the exact proposal to the gateway, which executes
 *   it through the Ads domain. Every step is audited.
 *
 * There is no delegated/automatic execution path here and no spend grant.
 * Moving budget between providers is not a proposal type.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, transaction } from '../db/client.js';
import type { HubAudit } from '../audit/service.js';
import type { AssertionMinter } from '../auth/assertions/mint.js';
import type { GatewayTokenMinter } from '../auth/gateway-token.js';
import type { GatewayClient, GatewayRunRequest, GatewayRunSnapshot } from '../brain/gateway-client.js';
import { GatewayClientError } from '../brain/gateway-client.js';
import { getExecutionState, lockExecutionState } from '../services/execution-state.js';
import { logger } from '../logger.js';
import {
  decideIntent,
  rulesIssue,
  stableUuid,
  totals,
  windowKey,
  type AnalyticsRules,
  type MetricRow,
  type MetricTotals,
  type ReviewIntent,
} from './rules.js';
import {
  clampNextCheck,
  dueCheckpoint,
  reviewNoteOf,
  wakeTime,
  type ReviewBounds,
  type WakeEvent,
} from './reviewer.js';
import { REVIEW_LOCKS } from './reviewer.js';
import type { CampaignDeliveryResolver, CampaignDeliveryStatus } from './delivery.js';

export const AD_PLATFORMS = ['reddit', 'microsoft', 'google', 'meta'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export class AnalyticsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

export interface AnalyticsCampaign {
  probaCampaignId: string;
  goalId: string;
  threadId: string;
  platform: AdPlatform;
  accountId: string | null;
  providerCampaignId: string | null;
  currentDailyBudget: number | null;
  currency: string | null;
  reviewEnabled: boolean;
  rules: AnalyticsRules;
  /** When the brain reviewer wants to look again, and why (null before the first review). */
  nextCheckAt: string | null;
  nextCheckReason: string | null;
  lastReviewedAt: string | null;
  checkpointsDone: string[];
  wakeEvent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalStatus {
  goal: { id: string; title: string; status: string };
  plan: Record<string, unknown> | null;
  now: {
    state: 'no_campaign' | 'awaiting_approval' | 'running';
    campaigns: Array<{
      probaCampaignId: string;
      platform: string;
      accountId: string | null;
      providerCampaignId: string | null;
      currentDailyBudget: number | null;
      currency: string | null;
      reviewEnabled: boolean;
      lastReviewedAt: string | null;
      delivery: CampaignDeliveryStatus | null;
    }>;
    pendingProposals: number;
  };
  next: { checkAt: string; reason: string | null; probaCampaignId: string } | null;
  spend: { spent: number | null; dailyCap: number | null; totalCap: number | null; currency: string | null };
  progress: { metric: string | null; target: number | null; actual: number | null; checkpointsDone: string[] };
  decisions: Array<Record<string, unknown>>;
}

export interface AnalyticsReview {
  id: string;
  probaCampaignId: string;
  windowKey: string;
  intent: ReviewIntent | 'brain';
  trigger: 'schedule' | 'manual' | 'event';
  status: string;
  outcome: string | null;
  decisionId: string | null;
  summary: Record<string, unknown> | null;
  errorCode: string | null;
  coalesced?: boolean;
  createdAt: string;
}

export interface AnalyticsProposal {
  id: string;
  reviewId: string;
  probaCampaignId: string;
  platform: string;
  accountId: string | null;
  decisionId: string;
  verb: string;
  args: Record<string, unknown>;
  argsHash: string;
  reason: string | null;
  metrics: unknown;
  reviewWindowUntil: string;
  status: string;
  decidedAt: string | null;
  outcome: Record<string, unknown> | null;
  createdAt: string;
}

export interface AnalyticsServiceOptions {
  client: GatewayClient;
  serviceTokens: GatewayTokenMinter;
  assertions: AssertionMinter | null;
  workspaceId: string;
  tokenTtlSeconds: number;
  cadenceMs: number;
  /** Scheduled reviews: brain or the deterministic owner-rule evaluator (default here; config defaults to brain). */
  reviewer?: 'brain' | 'rules';
  /** Brain reviewer outer bounds (already narrowed to the gateway locks by config). */
  reviewBounds?: ReviewBounds;
  /** Optional resolver for live provider delivery & moderation status per campaign. */
  delivery?: CampaignDeliveryResolver | null;
  audit: HubAudit;
  now?: () => Date;
}

const ACTION_VERBS = new Set(['ads.pause_campaign', 'ads.update_campaign']);

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function campaignRow(row: Record<string, unknown>): AnalyticsCampaign {
  return {
    probaCampaignId: String(row.proba_campaign_id),
    goalId: String(row.goal_id),
    threadId: String(row.thread_id),
    platform: row.platform as AdPlatform,
    accountId: (row.account_id as string | null) ?? null,
    providerCampaignId: (row.provider_campaign_id as string | null) ?? null,
    currentDailyBudget: num(row.current_daily_budget),
    currency: row.currency ? String(row.currency).trim() : null,
    reviewEnabled: Boolean(row.review_enabled),
    rules: (asRecord(row.rules) ?? {}) as AnalyticsRules,
    nextCheckAt: row.next_check_at ? iso(row.next_check_at) : null,
    nextCheckReason: (row.next_check_reason as string | null) ?? null,
    lastReviewedAt: row.last_reviewed_at ? iso(row.last_reviewed_at) : null,
    checkpointsDone: Array.isArray(row.checkpoints_done) ? (row.checkpoints_done as string[]) : [],
    wakeEvent: (row.wake_event as string | null) ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function reviewRow(row: Record<string, unknown>): AnalyticsReview {
  return {
    id: String(row.id),
    probaCampaignId: String(row.proba_campaign_id),
    windowKey: String(row.window_key),
    intent: row.intent as ReviewIntent,
    trigger: row.trigger as 'schedule' | 'manual',
    status: String(row.status),
    outcome: (row.outcome as string | null) ?? null,
    decisionId: (row.decision_id as string | null) ?? null,
    summary: asRecord(row.summary) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: iso(row.created_at),
  };
}

function proposalRow(row: Record<string, unknown>): AnalyticsProposal {
  return {
    id: String(row.id),
    reviewId: String(row.review_id),
    probaCampaignId: String(row.proba_campaign_id),
    platform: String(row.platform),
    accountId: (row.account_id as string | null) ?? null,
    decisionId: String(row.decision_id),
    verb: String(row.verb),
    args: asRecord(row.args) ?? {},
    argsHash: String(row.args_hash),
    reason: (row.reason as string | null) ?? null,
    metrics: row.metrics ?? null,
    reviewWindowUntil: iso(row.review_window_until),
    status: String(row.status),
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    outcome: asRecord(row.outcome) ?? null,
    createdAt: iso(row.created_at),
  };
}

function metricRows(summary: Record<string, unknown> | null | undefined): MetricRow[] {
  const metrics = summary?.metrics;
  if (!Array.isArray(metrics)) return [];
  return metrics.map((m) => {
    const r = asRecord(m) ?? {};
    const v = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 'unknown') as number | 'unknown';
    return { impressions: v(r.impressions), clicks: v(r.clicks), spend: v(r.spend), conversions: v(r.conversions) };
  });
}

export function metricTotalsOf(summary: Record<string, unknown> | null | undefined): MetricTotals | undefined {
  const rows = metricRows(summary);
  return rows.length > 0 ? totals(rows) : undefined;
}

export class AnalyticsService {
  private readonly now: () => Date;

  constructor(private readonly options: AnalyticsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  // ---------------------------------------------------------------- campaigns

  async registerCampaign(
    userId: string,
    input: {
      goalId: string;
      probaCampaignId: string;
      platform: string;
      accountId?: string;
      providerCampaignId?: string;
      currentDailyBudget?: number;
      currency?: string;
      rules?: unknown;
    }
  ): Promise<AnalyticsCampaign> {
    if (!(AD_PLATFORMS as readonly string[]).includes(input.platform)) {
      throw new AnalyticsError('invalid_platform', 'platform must be reddit, microsoft, google or meta');
    }
    const issue = rulesIssue(input.rules);
    if (issue) throw new AnalyticsError('invalid_rules', issue);
    if (input.currentDailyBudget !== undefined && !(input.currentDailyBudget > 0)) {
      throw new AnalyticsError('invalid_budget', 'currentDailyBudget must be positive when set (unknown is omitted, not 0)');
    }
    const goal = await pool.query<{ id: string; thread_id: string }>(
      'SELECT id, thread_id FROM goals WHERE id = $1 AND user_id = $2',
      [input.goalId, userId]
    );
    const goalRow = goal.rows[0];
    if (!goalRow) throw new AnalyticsError('goal_not_found', 'goal not found', 404);
    const result = await transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO analytics_campaigns
           (workspace_id, user_id, proba_campaign_id, goal_id, thread_id, platform, account_id,
            provider_campaign_id, current_daily_budget, currency, rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (workspace_id, user_id, proba_campaign_id) DO NOTHING
         RETURNING *`,
        [
          this.workspaceId,
          userId,
          input.probaCampaignId,
          goalRow.id,
          goalRow.thread_id,
          input.platform,
          input.accountId ?? null,
          input.providerCampaignId ?? null,
          input.currentDailyBudget ?? null,
          input.currency?.toUpperCase() ?? null,
          JSON.stringify(input.rules ?? {}),
        ]
      );
      if (!inserted.rows[0]) throw new AnalyticsError('campaign_exists', 'campaign is already registered', 409);
      await this.options.audit.emit(
        {
          action: 'goal.updated',
          outcome: 'success',
          userId,
          workspaceId: this.workspaceId,
          goalId: goalRow.id,
          threadId: goalRow.thread_id,
          target: { type: 'campaign', id: input.probaCampaignId },
          details: {
            change: 'analytics_campaign_registered',
            platform: input.platform,
            ...(input.accountId ? { accountId: input.accountId } : {}),
            rules: Object.keys(asRecord(input.rules) ?? {}),
            automaticExecution: false,
          },
        },
        { tx: client }
      );
      return inserted.rows[0];
    });
    return campaignRow(result);
  }

  async updateCampaign(
    userId: string,
    probaCampaignId: string,
    patch: { reviewEnabled?: boolean; currentDailyBudget?: number | null; rules?: unknown }
  ): Promise<AnalyticsCampaign> {
    if (patch.rules !== undefined) {
      const issue = rulesIssue(patch.rules);
      if (issue) throw new AnalyticsError('invalid_rules', issue);
    }
    if (patch.currentDailyBudget !== undefined && patch.currentDailyBudget !== null && !(patch.currentDailyBudget > 0)) {
      throw new AnalyticsError('invalid_budget', 'currentDailyBudget must be positive or null (unknown)');
    }
    const row = await transaction(async (client) => {
      const updated = await client.query(
        `UPDATE analytics_campaigns SET
           review_enabled = COALESCE($4, review_enabled),
           current_daily_budget = CASE WHEN $5::boolean THEN $6::numeric ELSE current_daily_budget END,
           rules = COALESCE($7::jsonb, rules),
           updated_at = NOW()
         WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3
         RETURNING *`,
        [
          this.workspaceId,
          userId,
          probaCampaignId,
          patch.reviewEnabled ?? null,
          patch.currentDailyBudget !== undefined,
          patch.currentDailyBudget ?? null,
          patch.rules === undefined ? null : JSON.stringify(patch.rules),
        ]
      );
      if (!updated.rows[0]) throw new AnalyticsError('campaign_not_found', 'campaign not found', 404);
      await this.options.audit.emit(
        {
          action: 'goal.updated',
          outcome: 'success',
          userId,
          workspaceId: this.workspaceId,
          goalId: String(updated.rows[0].goal_id),
          target: { type: 'campaign', id: probaCampaignId },
          details: { change: 'analytics_campaign_updated', fields: Object.keys(patch), automaticExecution: false },
        },
        { tx: client }
      );
      return updated.rows[0];
    });
    return campaignRow(row);
  }

  async listCampaigns(userId: string): Promise<AnalyticsCampaign[]> {
    const result = await pool.query(
      'SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 200',
      [this.workspaceId, userId]
    );
    return result.rows.map(campaignRow);
  }

  private async getCampaign(userId: string, probaCampaignId: string): Promise<AnalyticsCampaign> {
    const result = await pool.query(
      'SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3',
      [this.workspaceId, userId, probaCampaignId]
    );
    const row = result.rows[0];
    if (!row) throw new AnalyticsError('campaign_not_found', 'campaign not found', 404);
    return campaignRow(row);
  }

  async listReviews(userId: string, probaCampaignId?: string): Promise<AnalyticsReview[]> {
    const result = await pool.query(
      `SELECT * FROM analytics_reviews WHERE workspace_id = $1 AND user_id = $2
         AND ($3::text IS NULL OR proba_campaign_id = $3)
       ORDER BY created_at DESC LIMIT 100`,
      [this.workspaceId, userId, probaCampaignId ?? null]
    );
    return result.rows.map(reviewRow);
  }

  async listProposals(userId: string, status?: string): Promise<AnalyticsProposal[]> {
    await this.expireStale(userId);
    const result = await pool.query(
      `SELECT * FROM analytics_proposals WHERE workspace_id = $1 AND user_id = $2
         AND ($3::text IS NULL OR status = $3)
       ORDER BY created_at DESC LIMIT 100`,
      [this.workspaceId, userId, status ?? null]
    );
    return result.rows.map(proposalRow);
  }

  private async expireStale(userId: string): Promise<void> {
    const expired = await pool.query<{ id: string; proba_campaign_id: string; goal_id: string }>(
      `UPDATE analytics_proposals SET status = 'expired', updated_at = NOW()
       WHERE workspace_id = $1 AND user_id = $2 AND status = 'pending' AND review_window_until <= $3
       RETURNING id, proba_campaign_id, goal_id`,
      [this.workspaceId, userId, this.now()]
    );
    for (const row of expired.rows) {
      await this.options.audit.emit(
        {
          action: 'approval.expired',
          outcome: 'denied',
          userId,
          workspaceId: this.workspaceId,
          goalId: row.goal_id,
          target: { type: 'proposal', id: row.id },
          errorCode: 'proposal_expired',
          details: { probaCampaignId: row.proba_campaign_id, reason: 'review window passed' },
        },
        { bestEffort: true }
      );
    }
  }

  // ------------------------------------------------------------------ reviews

  async latestCompletedSummary(userId: string, probaCampaignId: string): Promise<Record<string, unknown> | undefined> {
    const result = await pool.query(
      `SELECT summary FROM analytics_reviews
       WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3 AND status = 'completed' AND summary IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [this.workspaceId, userId, probaCampaignId]
    );
    return asRecord(result.rows[0]?.summary);
  }

  /**
   * Request one evaluator review. Coalesced: the same campaign + window + intent
   * returns the existing review instead of starting another gateway run.
   */
  async runReview(
    userId: string,
    probaCampaignId: string,
    opts: { trigger: 'schedule' | 'manual'; intent?: ReviewIntent; dailyBudget?: number }
  ): Promise<AnalyticsReview> {
    const campaign = await this.getCampaign(userId, probaCampaignId);
    if (opts.trigger === 'schedule' && !campaign.reviewEnabled) {
      throw new AnalyticsError('review_disabled', 'scheduled review is disabled for this campaign', 409);
    }
    const state = await getExecutionState(userId);
    if (state !== 'running') {
      throw new AnalyticsError('execution_paused', `execution is ${state}; reviews wait until resumed`, 409);
    }

    let intent: ReviewIntent = opts.intent ?? 'report';
    let dailyBudget = opts.dailyBudget;
    let reason = 'manual review';
    if (!opts.intent) {
      const decision = decideIntent({
        rules: campaign.rules,
        metrics: metricTotalsOf(await this.latestCompletedSummary(userId, probaCampaignId)),
        currentDailyBudget: campaign.currentDailyBudget,
      });
      intent = decision.intent;
      reason = decision.reason;
      if (decision.intent === 'propose_cap') dailyBudget = decision.dailyBudget;
    }
    if (intent === 'propose_cap') {
      if (campaign.currentDailyBudget === null) {
        throw new AnalyticsError('budget_unknown', 'a cap proposal needs the current daily budget; unknown is not zero');
      }
      if (dailyBudget === undefined || !(dailyBudget > 0) || dailyBudget >= campaign.currentDailyBudget) {
        throw new AnalyticsError('cap_not_decrease', 'a cap proposal must be a decrease from the current daily budget');
      }
    }

    const key = windowKey(this.now(), this.options.cadenceMs);
    const idempotencyKey = stableUuid(this.workspaceId, userId, probaCampaignId, key, intent, String(dailyBudget ?? ''));
    const inserted = await pool.query(
      `INSERT INTO analytics_reviews
         (workspace_id, user_id, proba_campaign_id, window_key, intent, trigger, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, user_id, proba_campaign_id, window_key, intent) DO NOTHING
       RETURNING *`,
      [this.workspaceId, userId, probaCampaignId, key, intent, opts.trigger, idempotencyKey]
    );
    if (!inserted.rows[0]) {
      const existing = await pool.query(
        `SELECT * FROM analytics_reviews WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3
           AND window_key = $4 AND intent = $5`,
        [this.workspaceId, userId, probaCampaignId, key, intent]
      );
      return { ...reviewRow(existing.rows[0]), coalesced: true };
    }
    const review = reviewRow(inserted.rows[0]);

    const request: GatewayRunRequest = {
      traceId: randomUUID(),
      workspaceId: this.workspaceId,
      userId,
      goalId: campaign.goalId,
      threadId: campaign.threadId,
      stepId: review.id,
      stepType: 'review_performance',
      idempotencyKey,
      command: {
        kind: 'command',
        clientMsgId: idempotencyKey,
        type: 'send_message',
        threadId: campaign.threadId,
        payload: {
          text: `analytics review (${opts.trigger})`,
          probaCampaignId,
          platform: campaign.platform,
          ...(campaign.accountId ? { accountId: campaign.accountId } : {}),
          ...(campaign.providerCampaignId ? { providerCampaignId: campaign.providerCampaignId } : {}),
          reviewIntent: intent,
          ...(intent === 'propose_cap'
            ? {
                dailyBudget,
                currentDailyBudget: campaign.currentDailyBudget,
                ...(campaign.currency ? { currency: campaign.currency } : {}),
              }
            : {}),
        },
        sentAt: this.now().toISOString(),
      },
    };

    await this.options.audit.emit(
      {
        action: 'analytics.queried',
        outcome: 'partial',
        userId,
        workspaceId: this.workspaceId,
        goalId: campaign.goalId,
        threadId: campaign.threadId,
        target: { type: 'campaign', id: probaCampaignId },
        details: { reviewId: review.id, trigger: opts.trigger, intent, reason, windowKey: key, grantsSpend: false },
      },
      { bestEffort: true }
    );

    let snapshot: GatewayRunSnapshot;
    try {
      snapshot = await this.callGateway(request, campaign);
    } catch (error) {
      const code = error instanceof GatewayClientError ? error.code : 'gateway_error';
      await pool.query(
        `UPDATE analytics_reviews SET status = 'failed', error_code = $2, updated_at = NOW() WHERE id = $1`,
        [review.id, code]
      );
      await this.options.audit.emit(
        {
          action: 'system.job_failed',
          outcome: 'failure',
          userId,
          workspaceId: this.workspaceId,
          goalId: campaign.goalId,
          target: { type: 'campaign', id: probaCampaignId },
          errorCode: code,
          details: { reviewId: review.id, job: 'analytics_review' },
        },
        { bestEffort: true }
      );
      return { ...review, status: 'failed', errorCode: code };
    }

    const summary = asRecord(snapshot.analytics) ?? null;
    const outcome = typeof summary?.outcome === 'string' ? summary.outcome : null;
    const decisionId = typeof summary?.decisionId === 'string' ? summary.decisionId : null;
    const status = snapshot.status === 'completed' ? 'completed' : snapshot.status === 'blocked' ? 'blocked' : 'failed';
    await pool.query(
      `UPDATE analytics_reviews SET status = $2, outcome = $3, decision_id = $4, summary = $5, run_id = $6,
         error_code = $7, updated_at = NOW() WHERE id = $1`,
      [review.id, status, outcome, decisionId, summary ? JSON.stringify(summary) : null, snapshot.runId, snapshot.error?.code ?? null]
    );
    await this.options.audit.emit(
      {
        action: 'brain.decision_made',
        outcome: status === 'completed' ? 'success' : 'denied',
        userId,
        workspaceId: this.workspaceId,
        goalId: campaign.goalId,
        threadId: campaign.threadId,
        target: { type: 'campaign', id: probaCampaignId },
        ...(snapshot.error?.code ? { errorCode: snapshot.error.code } : {}),
        details: { reviewId: review.id, runId: snapshot.runId, outcome, decisionId, grantsSpend: false },
      },
      { bestEffort: true }
    );

    const proposal = asRecord(summary?.proposal);
    if (status === 'completed' && outcome === 'dry_run_proposal' && proposal && decisionId) {
      await this.recordProposal(userId, campaign, review.id, decisionId, summary!, proposal, reason, opts.trigger);
    }
    return { ...review, status, outcome, decisionId, summary };
  }

  private async recordProposal(
    userId: string,
    campaign: AnalyticsCampaign,
    reviewId: string,
    decisionId: string,
    summary: Record<string, unknown>,
    proposal: Record<string, unknown>,
    reason: string,
    trigger: 'schedule' | 'manual' | 'brain'
  ): Promise<void> {
    const verb = typeof proposal.verb === 'string' ? proposal.verb : '';
    const args = asRecord(proposal.args);
    const argsHash = typeof proposal.argsHash === 'string' ? proposal.argsHash : '';
    const until = typeof summary.reviewWindowUntil === 'string' ? summary.reviewWindowUntil : undefined;
    if (!ACTION_VERBS.has(verb) || !args || !argsHash || !until) {
      logger.warn({ reviewId, verb }, 'analytics proposal ignored: not a pause/cap proposal with a review window');
      return;
    }
    if (args.probaCampaignId !== campaign.probaCampaignId) {
      logger.warn({ reviewId }, 'analytics proposal ignored: campaign scope mismatch');
      return;
    }
    // Scheduled proposals must still match the owner's rule on the fresh metrics.
    if (trigger === 'schedule') {
      const recheck = decideIntent({
        rules: campaign.rules,
        metrics: metricTotalsOf(summary),
        currentDailyBudget: campaign.currentDailyBudget,
      });
      const expected = verb === 'ads.pause_campaign' ? 'propose_pause' : 'propose_cap';
      if (recheck.intent !== expected) {
        logger.info({ reviewId }, 'analytics proposal dropped: owner rule no longer holds on fresh metrics');
        return;
      }
      reason = recheck.reason;
    }
    await transaction(async (client) => {
      await client.query(
        `UPDATE analytics_proposals SET status = 'superseded', updated_at = NOW()
         WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3 AND status = 'pending'`,
        [this.workspaceId, userId, campaign.probaCampaignId]
      );
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO analytics_proposals
           (review_id, workspace_id, user_id, proba_campaign_id, goal_id, thread_id, platform, account_id,
            decision_id, verb, args, args_hash, reason, metrics, review_window_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          reviewId,
          this.workspaceId,
          userId,
          campaign.probaCampaignId,
          campaign.goalId,
          campaign.threadId,
          campaign.platform,
          campaign.accountId,
          decisionId,
          verb,
          JSON.stringify(args),
          argsHash,
          reason,
          JSON.stringify(summary.metrics ?? []),
          until,
        ]
      );
      await this.options.audit.emit(
        {
          action: 'approval.requested',
          outcome: 'partial',
          userId,
          workspaceId: this.workspaceId,
          goalId: campaign.goalId,
          threadId: campaign.threadId,
          target: { type: 'proposal', id: inserted.rows[0]!.id },
          details: {
            probaCampaignId: campaign.probaCampaignId,
            platform: campaign.platform,
            verb,
            argsHash,
            decisionId,
            reviewWindowUntil: until,
            grantsSpend: false,
            automaticExecution: false,
          },
        },
        { tx: client }
      );
    });
  }

  // ---------------------------------------------------------------- decisions

  async decide(userId: string, proposalId: string, decision: 'approve' | 'reject'): Promise<AnalyticsProposal> {
    const locked = await transaction(async (client) => {
      const result = await client.query(
        'SELECT * FROM analytics_proposals WHERE id = $1 AND workspace_id = $2 AND user_id = $3 FOR UPDATE',
        [proposalId, this.workspaceId, userId]
      );
      const row = result.rows[0];
      if (!row) throw new AnalyticsError('proposal_not_found', 'proposal not found', 404);
      const proposal = proposalRow(row);
      if (proposal.status !== 'pending') {
        throw new AnalyticsError('proposal_not_pending', `proposal is ${proposal.status}`, 409);
      }
      if (Date.parse(proposal.reviewWindowUntil) <= this.now().getTime()) {
        await client.query(`UPDATE analytics_proposals SET status = 'expired', updated_at = NOW() WHERE id = $1`, [proposalId]);
        await this.audit(client, userId, row, 'approval.expired', 'denied', { reason: 'review window passed' }, 'proposal_expired');
        return { expired: true as const };
      }
      if (decision === 'reject') {
        await client.query(
          `UPDATE analytics_proposals SET status = 'rejected', decided_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [proposalId]
        );
        await this.audit(client, userId, row, 'approval.rejected', 'denied', { verb: proposal.verb });
        return { rejected: true as const };
      }
      const state = await lockExecutionState(client, userId, 'share');
      if (state !== 'running') {
        throw new AnalyticsError('execution_paused', `execution is ${state}; approve after resuming`, 409);
      }
      const actionKey = randomUUID();
      await client.query(
        `UPDATE analytics_proposals SET status = 'approved', decided_at = NOW(), action_idempotency_key = $2,
           updated_at = NOW() WHERE id = $1`,
        [proposalId, actionKey]
      );
      await this.audit(client, userId, row, 'approval.granted', 'success', { verb: proposal.verb, argsHash: proposal.argsHash });
      return { approved: true as const, proposal, actionKey };
    });

    if ('expired' in locked) throw new AnalyticsError('proposal_expired', 'proposal review window has passed', 409);
    if ('rejected' in locked) return this.getProposal(userId, proposalId);

    const { proposal, actionKey } = locked;
    const request: GatewayRunRequest = {
      traceId: randomUUID(),
      workspaceId: this.workspaceId,
      userId,
      goalId: (await this.goalOf(proposalId)).goalId,
      threadId: (await this.goalOf(proposalId)).threadId,
      stepId: proposalId,
      stepType: 'handle_approval',
      idempotencyKey: actionKey,
      command: {
        kind: 'command',
        clientMsgId: actionKey,
        type: 'send_message',
        payload: {
          text: 'approved analytics action',
          analyticsAction: {
            proposalId,
            decisionId: proposal.decisionId,
            verb: proposal.verb,
            args: proposal.args,
            argsHash: proposal.argsHash,
            probaCampaignId: proposal.probaCampaignId,
            platform: proposal.platform,
            ...(proposal.accountId ? { accountId: proposal.accountId } : {}),
          },
        },
        sentAt: this.now().toISOString(),
      },
      resume: { askId: proposalId, choice: 'approve' },
    };

    let snapshot: GatewayRunSnapshot | undefined;
    let failure: { code: string; message: string } | undefined;
    try {
      snapshot = await this.callGateway(request);
    } catch (error) {
      failure = {
        code: error instanceof GatewayClientError ? error.code : 'gateway_error',
        message: error instanceof Error ? error.message : 'gateway error',
      };
    }
    const outcome = asRecord(snapshot?.actionOutcome);
    const ok = snapshot?.status === 'completed' && outcome?.ok === true;
    const status = ok ? 'executed' : 'failed';
    const outcomeBody = {
      ...(outcome ?? {}),
      ...(snapshot ? { runStatus: snapshot.status, runId: snapshot.runId } : {}),
      ...(snapshot?.error ? { code: snapshot.error.code, message: snapshot.error.message } : {}),
      ...(failure ? failure : {}),
      grantsSpend: false,
    };
    await transaction(async (client) => {
      const updated = await client.query(
        `UPDATE analytics_proposals SET status = $2, action_run_id = $3, outcome = $4, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [proposalId, status, snapshot?.runId ?? null, JSON.stringify(outcomeBody)]
      );
      const row = updated.rows[0];
      if (ok && proposal.verb === 'ads.update_campaign' && typeof proposal.args.dailyBudget === 'number') {
        await client.query(
          `UPDATE analytics_campaigns SET current_daily_budget = $4, updated_at = NOW()
           WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3`,
          [this.workspaceId, userId, proposal.probaCampaignId, proposal.args.dailyBudget]
        );
      }
      const action = ok
        ? proposal.verb === 'ads.pause_campaign'
          ? 'campaign.paused'
          : 'campaign.budget_changed'
        : 'tool.failed';
      await this.audit(
        client,
        userId,
        row,
        action,
        ok ? 'success' : 'failure',
        { verb: proposal.verb, runId: snapshot?.runId, hubApproval: true },
        ok ? undefined : outcomeBody.code as string | undefined
      );
    });
    return this.getProposal(userId, proposalId);
  }

  private async goalOf(proposalId: string): Promise<{ goalId: string; threadId: string }> {
    const result = await pool.query<{ goal_id: string; thread_id: string }>(
      'SELECT goal_id, thread_id FROM analytics_proposals WHERE id = $1',
      [proposalId]
    );
    return { goalId: result.rows[0]!.goal_id, threadId: result.rows[0]!.thread_id };
  }

  async getProposal(userId: string, proposalId: string): Promise<AnalyticsProposal> {
    const result = await pool.query(
      'SELECT * FROM analytics_proposals WHERE id = $1 AND workspace_id = $2 AND user_id = $3',
      [proposalId, this.workspaceId, userId]
    );
    if (!result.rows[0]) throw new AnalyticsError('proposal_not_found', 'proposal not found', 404);
    return proposalRow(result.rows[0]);
  }

  // ---------------------------------------------------------------- schedule

  /** One scheduler pass across all users' enabled campaigns. Coalesced per window. */
  async scheduleTick(): Promise<{ attempted: number; coalesced: number; skipped: number }> {
    const brain = this.options.reviewer === 'brain';
    // Brain reviewer: only campaigns whose chosen check time has come (first look after the minimum interval).
    const due = await pool.query<{ user_id: string; proba_campaign_id: string }>(
      brain
        ? `SELECT c.user_id, c.proba_campaign_id FROM analytics_campaigns c
           LEFT JOIN execution_state e ON e.user_id = c.user_id
           WHERE c.workspace_id = $1 AND c.review_enabled = TRUE AND COALESCE(e.state, 'running') = 'running'
             AND COALESCE(c.next_check_at, c.created_at + make_interval(secs => $2)) <= $3
           ORDER BY COALESCE(c.next_check_at, c.created_at) ASC LIMIT 500`
        : `SELECT c.user_id, c.proba_campaign_id FROM analytics_campaigns c
           LEFT JOIN execution_state e ON e.user_id = c.user_id
           WHERE c.workspace_id = $1 AND c.review_enabled = TRUE AND COALESCE(e.state, 'running') = 'running'
           ORDER BY c.updated_at ASC LIMIT 500`,
      brain ? [this.workspaceId, this.bounds.minCheckHours * 3600, this.now()] : [this.workspaceId]
    );
    let attempted = 0;
    let coalesced = 0;
    let skipped = 0;
    for (const row of due.rows) {
      try {
        const review = brain
          ? await this.runBrainReview(row.user_id, row.proba_campaign_id, { trigger: 'schedule' })
          : await this.runReview(row.user_id, row.proba_campaign_id, { trigger: 'schedule' });
        if (review.coalesced) coalesced += 1;
        else attempted += 1;
      } catch (error) {
        skipped += 1;
        logger.warn(
          { userId: row.user_id, probaCampaignId: row.proba_campaign_id, err: error instanceof Error ? error.message : error },
          'scheduled analytics review skipped'
        );
      }
    }
    await this.options.audit.emit(
      {
        action: 'system.job_run',
        outcome: 'success',
        workspaceId: this.workspaceId,
        details: { job: 'analytics_review_schedule', reviewer: brain ? 'brain' : 'rules', attempted, coalesced, skipped },
      },
      { bestEffort: true }
    );
    return { attempted, coalesced, skipped };
  }

  // ---------------------------------------------------------------- brain reviewer

  private get bounds(): ReviewBounds {
    return this.options.reviewBounds ?? { ...REVIEW_LOCKS };
  }

  /** The approved plan saved by the plan card (goals.approved_plan, proba-hub#51); null when absent. */
  private async approvedPlan(goalId: string): Promise<Record<string, unknown> | null> {
    // to_jsonb keeps this safe on a schema without the column (plan card not migrated yet).
    const result = await pool.query(`SELECT to_jsonb(g) -> 'approved_plan' AS plan FROM goals g WHERE g.id = $1`, [goalId]);
    return asRecord(result.rows[0]?.plan) ?? null;
  }

  /**
   * Start one system-initiated brain review (a normal gateway run with reviewIntent=brain). The brain decides
   * whether to change anything and when to look again; Hub stores its note, clamps the next check to the
   * bounds, and turns any change into the usual pending proposal (owner approval; never auto-executed).
   */
  async runBrainReview(
    userId: string,
    probaCampaignId: string,
    opts: { trigger: 'schedule' | 'manual' | 'event'; wakeEvent?: WakeEvent }
  ): Promise<AnalyticsReview> {
    const campaign = await this.getCampaign(userId, probaCampaignId);
    if (opts.trigger !== 'manual' && !campaign.reviewEnabled) {
      throw new AnalyticsError('review_disabled', 'scheduled review is disabled for this campaign', 409);
    }
    const state = await getExecutionState(userId);
    if (state !== 'running') {
      throw new AnalyticsError('execution_paused', `execution is ${state}; reviews wait until resumed`, 409);
    }
    const now = this.now();
    const bounds = this.bounds;
    const plan = await this.approvedPlan(campaign.goalId);
    const durationDays = typeof plan?.durationDays === 'number' ? plan.durationDays : undefined;
    const checkpoint = dueCheckpoint(now, new Date(campaign.createdAt), campaign.checkpointsDone, durationDays);
    const wakeEvent = opts.wakeEvent ?? (campaign.wakeEvent as WakeEvent | null) ?? undefined;
    // Coalesce: one review per chosen check time (or per hour for manual / event wakes).
    const slot =
      opts.trigger === 'schedule' && !wakeEvent
        ? `s:${campaign.nextCheckAt ?? 'first'}`
        : `${opts.trigger}:${wakeEvent ?? ''}:${now.toISOString().slice(0, 13)}`;
    const key = `brain:${stableUuid(slot, checkpoint ?? '').slice(0, 36)}`.slice(0, 64);
    const idempotencyKey = stableUuid(this.workspaceId, userId, probaCampaignId, key, 'brain');
    const inserted = await pool.query(
      `INSERT INTO analytics_reviews
         (workspace_id, user_id, proba_campaign_id, window_key, intent, trigger, idempotency_key)
       VALUES ($1,$2,$3,$4,'brain',$5,$6)
       ON CONFLICT (workspace_id, user_id, proba_campaign_id, window_key, intent) DO NOTHING
       RETURNING *`,
      [this.workspaceId, userId, probaCampaignId, key, opts.trigger, idempotencyKey]
    );
    if (!inserted.rows[0]) {
      const existing = await pool.query(
        `SELECT * FROM analytics_reviews WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3
           AND window_key = $4 AND intent = 'brain'`,
        [this.workspaceId, userId, probaCampaignId, key]
      );
      return { ...reviewRow(existing.rows[0]), coalesced: true };
    }
    const review = reviewRow(inserted.rows[0]);
    const deliveryStatus = this.options.delivery
      ? await this.options.delivery
          .resolve({
            workspaceId: this.workspaceId,
            userId,
            probaCampaignId: campaign.probaCampaignId,
            platform: campaign.platform,
            accountId: campaign.accountId,
            providerCampaignId: campaign.providerCampaignId,
          })
          .catch(() => null)
      : null;

    const request: GatewayRunRequest = {
      traceId: randomUUID(),
      workspaceId: this.workspaceId,
      userId,
      goalId: campaign.goalId,
      threadId: campaign.threadId,
      stepId: review.id,
      stepType: 'review_performance',
      idempotencyKey,
      command: {
        kind: 'command',
        clientMsgId: idempotencyKey,
        type: 'send_message',
        threadId: campaign.threadId,
        payload: {
          text: `campaign review (${opts.trigger}${wakeEvent ? `: ${wakeEvent}` : ''})`,
          probaCampaignId,
          platform: campaign.platform,
          ...(campaign.accountId ? { accountId: campaign.accountId } : {}),
          ...(campaign.providerCampaignId ? { providerCampaignId: campaign.providerCampaignId } : {}),
          ...(deliveryStatus ? { deliveryStatus } : {}),
          reviewIntent: 'brain',
          reviewTrigger: opts.trigger,
          ...(wakeEvent ? { wakeEvent } : {}),
          ...(checkpoint ? { checkpoint } : {}),
          ...(plan ? { plan } : {}),
          ...(campaign.currentDailyBudget !== null ? { currentDailyBudget: campaign.currentDailyBudget } : {}),
          ...(campaign.currency ? { currency: campaign.currency } : {}),
          ...(campaign.lastReviewedAt ? { lastReviewedAt: campaign.lastReviewedAt } : {}),
          launchedAt: campaign.createdAt,
          reviewBounds: bounds,
        },
        sentAt: now.toISOString(),
      },
    };

    await this.options.audit.emit(
      {
        action: 'analytics.queried',
        outcome: 'partial',
        userId,
        workspaceId: this.workspaceId,
        goalId: campaign.goalId,
        threadId: campaign.threadId,
        target: { type: 'campaign', id: probaCampaignId },
        details: { reviewId: review.id, reviewer: 'brain', trigger: opts.trigger, wakeEvent, checkpoint, grantsSpend: false },
      },
      { bestEffort: true }
    );

    let snapshot: GatewayRunSnapshot;
    try {
      snapshot = await this.callGateway(request, campaign);
    } catch (error) {
      const code = error instanceof GatewayClientError ? error.code : 'gateway_error';
      await pool.query(`UPDATE analytics_reviews SET status = 'failed', error_code = $2, updated_at = NOW() WHERE id = $1`, [review.id, code]);
      // Try again after the minimum interval rather than every tick.
      await this.scheduleNext(userId, probaCampaignId, new Date(now.getTime() + bounds.minCheckHours * 3_600_000), `review failed (${code}); retrying`, null);
      await this.options.audit.emit(
        {
          action: 'system.job_failed',
          outcome: 'failure',
          userId,
          workspaceId: this.workspaceId,
          goalId: campaign.goalId,
          target: { type: 'campaign', id: probaCampaignId },
          errorCode: code,
          details: { reviewId: review.id, job: 'campaign_review' },
        },
        { bestEffort: true }
      );
      return { ...review, status: 'failed', errorCode: code };
    }

    const summary = asRecord(snapshot.analytics) ?? null;
    const outcome = typeof summary?.outcome === 'string' ? summary.outcome : null;
    const decisionId = typeof summary?.decisionId === 'string' ? summary.decisionId : null;
    const status = snapshot.status === 'completed' ? 'completed' : snapshot.status === 'blocked' ? 'blocked' : 'failed';
    const note = reviewNoteOf(summary);
    const next = status === 'completed' ? clampNextCheck(now, bounds, note?.nextCheckAt) : { at: new Date(now.getTime() + bounds.minCheckHours * 3_600_000), clamped: true };
    const nextReason =
      status !== 'completed'
        ? `review ${status}${snapshot.error?.code ? ` (${snapshot.error.code})` : ''}; retrying`
        : note?.nextCheckReason ?? 'no note from the review; default check';
    const stored = summary
      ? {
          ...summary,
          // A pending change lives until the next check the brain chose (clamped).
          ...(note ? { reviewWindowUntil: next.at.toISOString(), review: { ...note, nextCheckAt: next.at.toISOString() } } : {}),
        }
      : null;
    await pool.query(
      `UPDATE analytics_reviews SET status = $2, outcome = $3, decision_id = $4, summary = $5, run_id = $6,
         error_code = $7, updated_at = NOW() WHERE id = $1`,
      [review.id, status, outcome, decisionId, stored ? JSON.stringify(stored) : null, snapshot.runId, snapshot.error?.code ?? null]
    );
    const doneCheckpoint = status === 'completed' && note?.kind === 'checkpoint' ? note.checkpoint?.checkpoint ?? checkpoint : undefined;
    await this.scheduleNext(userId, probaCampaignId, next.at, nextReason, doneCheckpoint ?? null);
    await this.options.audit.emit(
      {
        action: 'brain.decision_made',
        outcome: status === 'completed' ? 'success' : 'denied',
        userId,
        workspaceId: this.workspaceId,
        goalId: campaign.goalId,
        threadId: campaign.threadId,
        target: { type: 'campaign', id: probaCampaignId },
        ...(snapshot.error?.code ? { errorCode: snapshot.error.code } : {}),
        details: {
          reviewId: review.id,
          runId: snapshot.runId,
          reviewer: 'brain',
          trigger: opts.trigger,
          kind: note?.kind ?? null,
          decision: note?.decision ?? null,
          whyNowOrNotYet: note?.whyNowOrNotYet?.slice(0, 400) ?? null,
          nextCheckAt: next.at.toISOString(),
          nextCheckReason: nextReason.slice(0, 200),
          clamped: next.clamped,
          checkpoint: doneCheckpoint ?? null,
          outcome,
          decisionId,
          grantsSpend: false,
        },
      },
      { bestEffort: true }
    );

    const proposal = asRecord(summary?.proposal);
    if (status === 'completed' && outcome === 'dry_run_proposal' && proposal && decisionId && stored) {
      const reason = [note?.summary, note?.whyNowOrNotYet].filter(Boolean).join(' ').slice(0, 1000) || 'campaign review';
      await this.recordProposal(userId, campaign, review.id, decisionId, stored, proposal, reason, 'brain');
    }
    return { ...review, status, outcome, decisionId, summary: stored };
  }

  private async scheduleNext(userId: string, probaCampaignId: string, at: Date, reason: string, checkpoint: string | null): Promise<void> {
    await pool.query(
      `UPDATE analytics_campaigns SET next_check_at = $4, next_check_reason = $5, last_reviewed_at = $7, wake_event = NULL,
         checkpoints_done = CASE WHEN $6::text IS NULL OR $6 = ANY(checkpoints_done) THEN checkpoints_done ELSE array_append(checkpoints_done, $6::text) END,
         updated_at = NOW()
       WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3`,
      [this.workspaceId, userId, probaCampaignId, at, reason.slice(0, 500), checkpoint, this.now()]
    );
  }

  /**
   * A pressing event (metrics anomaly, disapproval, spend pace, budget nearly gone, off track) wakes the
   * review early. Urgent events run on the next tick; others wait for the minimum interval since the last review.
   */
  async wake(userId: string, probaCampaignId: string, event: WakeEvent): Promise<AnalyticsCampaign> {
    const campaign = await this.getCampaign(userId, probaCampaignId);
    const at = wakeTime(
      this.now(),
      this.bounds,
      event,
      campaign.lastReviewedAt ? new Date(campaign.lastReviewedAt) : null,
      campaign.nextCheckAt ? new Date(campaign.nextCheckAt) : null
    );
    const result = await pool.query(
      `UPDATE analytics_campaigns SET next_check_at = $4, next_check_reason = $5, wake_event = $6, updated_at = NOW()
       WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3 RETURNING *`,
      [this.workspaceId, userId, probaCampaignId, at, `woken: ${event}`, event]
    );
    await this.options.audit.emit(
      {
        action: 'analytics.queried',
        outcome: 'partial',
        userId,
        workspaceId: this.workspaceId,
        goalId: campaign.goalId,
        threadId: campaign.threadId,
        target: { type: 'campaign', id: probaCampaignId },
        details: { reviewer: 'brain', wakeEvent: event, nextCheckAt: at.toISOString(), grantsSpend: false },
      },
      { bestEffort: true }
    );
    return campaignRow(result.rows[0]);
  }

  // ---------------------------------------------------------------- goal page

  /**
   * One read for the goal page: Now / Next / Spend vs cap / Progress / Recent decisions. Numbers come only
   * from the latest audited review metrics; anything missing is null (unknown), never zero.
   */
  async goalStatus(userId: string, goalId: string): Promise<GoalStatus> {
    const goal = await pool.query(
      `SELECT id, title, status, budget, to_jsonb(g) -> 'approved_plan' AS plan FROM goals g WHERE id = $1 AND user_id = $2`,
      [goalId, userId]
    );
    const g = goal.rows[0];
    if (!g) throw new AnalyticsError('goal_not_found', 'goal not found', 404);
    const campaigns = (
      await pool.query(
        `SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 AND goal_id = $3 ORDER BY created_at`,
        [this.workspaceId, userId, goalId]
      )
    ).rows.map(campaignRow);
    const ids = campaigns.map((c) => c.probaCampaignId);
    const reviews = ids.length
      ? (
          await pool.query(
            `SELECT * FROM analytics_reviews WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = ANY($3)
               AND status = 'completed' ORDER BY created_at DESC LIMIT 20`,
            [this.workspaceId, userId, ids]
          )
        ).rows.map(reviewRow)
      : [];
    const proposals = ids.length
      ? (
          await pool.query(
            `SELECT id, review_id, verb, status, created_at FROM analytics_proposals
             WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = ANY($3) ORDER BY created_at DESC LIMIT 20`,
            [this.workspaceId, userId, ids]
          )
        ).rows
      : [];
    const plan = asRecord(g.plan) ?? null;
    const budget = asRecord(g.budget) ?? {};

    // Latest audited metrics per campaign (from the newest completed review that has metrics).
    const latest = new Map<string, Record<string, unknown>[]>();
    for (const r of reviews) {
      const rows = Array.isArray(r.summary?.metrics) ? (r.summary!.metrics as Record<string, unknown>[]) : [];
      if (rows.length > 0 && !latest.has(r.probaCampaignId)) latest.set(r.probaCampaignId, rows);
    }
    const sumOf = (field: string): number | null => {
      if (campaigns.length === 0 || latest.size < campaigns.length) return null;
      let total = 0;
      for (const rows of latest.values()) {
        for (const row of rows) {
          const v = row[field];
          if (typeof v !== 'number') return null;
          total += v;
        }
      }
      return total;
    };
    const spent = sumOf('spend');
    const clicks = sumOf('clicks');
    const impressions = sumOf('impressions');
    const conversions = sumOf('conversions');
    const metric = typeof plan?.successMetric === 'string' ? plan.successMetric : null;
    const actual =
      metric === 'clicks' ? clicks
      : metric === 'conversions' || metric === 'signups' ? conversions
      : metric === 'ctr' ? (clicks !== null && impressions ? clicks / impressions : null)
      : metric === 'cpc' ? (spent !== null && clicks ? spent / clicks : null)
      : null;
    const nextRow = campaigns
      .filter((c) => c.reviewEnabled && c.nextCheckAt)
      .sort((a, b) => Date.parse(a.nextCheckAt!) - Date.parse(b.nextCheckAt!))[0];
    const dailyCap = campaigns.every((c) => c.currentDailyBudget !== null) && campaigns.length > 0
      ? campaigns.reduce((t, c) => t + (c.currentDailyBudget ?? 0), 0)
      : null;
    const proposalByReview = new Map(proposals.map((p) => [String(p.review_id), p]));
    const decisions = reviews
      .filter((r) => r.summary?.review)
      .slice(0, 10)
      .map((r) => {
        const note = reviewNoteOf(r.summary)!;
        const p = proposalByReview.get(r.id);
        return {
          at: r.createdAt,
          probaCampaignId: r.probaCampaignId,
          trigger: r.trigger,
          kind: note.kind ?? 'review',
          decision: note.decision ?? null,
          summary: note.summary ?? null,
          whyNowOrNotYet: note.whyNowOrNotYet ?? null,
          nextCheckAt: note.nextCheckAt ?? null,
          nextCheckReason: note.nextCheckReason ?? null,
          checkpoint: (note.checkpoint as Record<string, unknown> | undefined) ?? null,
          proposal: p ? { id: String(p.id), verb: String(p.verb), status: String(p.status) } : null,
        };
      });
    const pending = proposals.filter((p) => p.status === 'pending').length;
    const deliveries = await Promise.all(
      campaigns.map((c) =>
        this.options.delivery
          ? this.options.delivery
              .resolve({
                workspaceId: this.workspaceId,
                userId,
                probaCampaignId: c.probaCampaignId,
                platform: c.platform,
                accountId: c.accountId,
                providerCampaignId: c.providerCampaignId,
              })
              .catch(() => null)
          : Promise.resolve(null)
      )
    );
    return {
      goal: { id: String(g.id), title: String(g.title), status: String(g.status) },
      plan,
      now: {
        state: campaigns.length === 0 ? 'no_campaign' : pending > 0 ? 'awaiting_approval' : 'running',
        campaigns: campaigns.map((c, idx) => ({
          probaCampaignId: c.probaCampaignId,
          platform: c.platform,
          accountId: c.accountId,
          providerCampaignId: c.providerCampaignId,
          currentDailyBudget: c.currentDailyBudget,
          currency: c.currency,
          reviewEnabled: c.reviewEnabled,
          lastReviewedAt: c.lastReviewedAt,
          delivery: deliveries[idx] ?? null,
        })),
        pendingProposals: pending,
      },
      next: nextRow ? { checkAt: nextRow.nextCheckAt!, reason: nextRow.nextCheckReason, probaCampaignId: nextRow.probaCampaignId } : null,
      spend: {
        spent,
        dailyCap,
        totalCap: typeof budget.total === 'number' ? budget.total : null,
        currency: campaigns.find((c) => c.currency)?.currency ?? (typeof budget.currency === 'string' ? budget.currency : null),
      },
      progress: {
        metric,
        target: typeof plan?.successTarget === 'number' ? plan.successTarget : null,
        actual,
        checkpointsDone: [...new Set(campaigns.flatMap((c) => c.checkpointsDone))],
      },
      decisions,
    };
  }

  /**
   * Emergency stop: best-effort pause all live provider campaigns & ads for this user across all platforms.
   */
  async emergencyPauseAll(userId: string): Promise<{ paused: number; failed: number }> {
    const campaigns = (
      await pool.query(
        `SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 AND provider_campaign_id IS NOT NULL`,
        [this.workspaceId, userId]
      )
    ).rows.map(campaignRow);
    return this.pauseCampaignList(userId, campaigns, 'emergency_stop');
  }

  /**
   * Manual override: pause every platform campaign belonging to one Proba goal owned by `userId`.
   */
  async pauseGoalCampaigns(userId: string, goalId: string): Promise<{ paused: number; failed: number }> {
    const campaigns = (
      await pool.query(
        `SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 AND goal_id = $3 AND provider_campaign_id IS NOT NULL`,
        [this.workspaceId, userId, goalId]
      )
    ).rows.map(campaignRow);
    return this.pauseCampaignList(userId, campaigns, 'manual_goal_pause');
  }

  /**
   * Manual override: pause a single platform campaign owned by `userId`.
   */
  async pauseSingleCampaign(
    userId: string,
    probaCampaignId: string
  ): Promise<{ paused: number; failed: number }> {
    const campaigns = (
      await pool.query(
        `SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = $3 AND provider_campaign_id IS NOT NULL`,
        [this.workspaceId, userId, probaCampaignId]
      )
    ).rows.map(campaignRow);
    if (campaigns.length === 0) {
      throw Object.assign(new Error('campaign not found'), { statusCode: 404, code: 'campaign_not_found' });
    }
    return this.pauseCampaignList(userId, campaigns, 'manual_platform_pause');
  }

  /**
   * Manual override: cancel an entire goal owned by `userId`.
   * Pauses all live provider campaigns, rejects pending proposals, disables future bot reviews,
   * and marks the goal `cancelled` while preserving all historical data, metrics, and thread logs.
   */
  async cancelGoal(
    userId: string,
    goalId: string
  ): Promise<{ goalId: string; status: 'cancelled'; paused: number; failed: number; proposalsCancelled: number }> {
    const goalRes = await pool.query(
      `SELECT id, title, status, thread_id FROM goals WHERE id = $1 AND user_id = $2`,
      [goalId, userId]
    );
    const goal = goalRes.rows[0] as { id: string; title: string; status: string; thread_id: string } | undefined;
    if (!goal) throw new AnalyticsError('goal_not_found', 'goal not found', 404);

    const campaigns = (
      await pool.query(
        `SELECT * FROM analytics_campaigns WHERE workspace_id = $1 AND user_id = $2 AND goal_id = $3`,
        [this.workspaceId, userId, goalId]
      )
    ).rows.map(campaignRow);
    const liveCampaigns = campaigns.filter((c) => Boolean(c.providerCampaignId));
    const { paused, failed } = await this.pauseCampaignList(userId, liveCampaigns, 'manual_goal_pause');

    await pool.query(
      `UPDATE analytics_campaigns
       SET review_enabled = false, next_review_at = NULL, updated_at = now()
       WHERE workspace_id = $1 AND user_id = $2 AND goal_id = $3`,
      [this.workspaceId, userId, goalId]
    );

    let proposalsCancelled = 0;
    const ids = campaigns.map((c) => c.probaCampaignId);
    if (ids.length > 0) {
      const propRes = await pool.query(
        `UPDATE analytics_proposals
         SET status = 'rejected', decided_at = now()
         WHERE workspace_id = $1 AND user_id = $2 AND proba_campaign_id = ANY($3) AND status = 'pending'`,
        [this.workspaceId, userId, ids]
      );
      proposalsCancelled = propRes.rowCount ?? 0;
    }

    await pool.query(
      `UPDATE goals SET status = 'cancelled', updated_at = now() WHERE id = $1 AND user_id = $2`,
      [goalId, userId]
    );

    await this.options.audit.emit(
      {
        action: 'goal.status_changed',
        outcome: 'success',
        userId,
        workspaceId: this.workspaceId,
        goalId,
        threadId: goal.thread_id,
        target: { type: 'goal', id: goalId },
        tags: ['manual_goal_cancel'],
        details: {
          goalId,
          from: goal.status,
          to: 'cancelled',
          paused,
          failed,
          proposalsCancelled,
          grantsSpend: false,
        },
      },
      { bestEffort: true }
    );

    return { goalId, status: 'cancelled', paused, failed, proposalsCancelled };
  }

  private async pauseCampaignList(
    userId: string,
    campaigns: AnalyticsCampaign[],
    reasonTag: 'emergency_stop' | 'manual_goal_pause' | 'manual_platform_pause'
  ): Promise<{ paused: number; failed: number }> {
    const pauseFn = this.options.delivery?.pauseCampaign?.bind(this.options.delivery);
    if (!pauseFn) return { paused: 0, failed: 0 };
    let paused = 0;
    let failed = 0;
    for (const c of campaigns) {
      const res = await pauseFn({
        workspaceId: this.workspaceId,
        userId,
        probaCampaignId: c.probaCampaignId,
        platform: c.platform,
        accountId: c.accountId,
        providerCampaignId: c.providerCampaignId,
      });
      if (res.ok) {
        paused += 1;
        await this.options.audit.emit(
          {
            action: 'campaign.paused',
            outcome: 'success',
            userId,
            workspaceId: this.workspaceId,
            goalId: c.goalId,
            threadId: c.threadId,
            target: { type: 'campaign', id: c.probaCampaignId },
            tags: [reasonTag],
            details: {
              probaCampaignId: c.probaCampaignId,
              platform: c.platform,
              providerCampaignId: c.providerCampaignId,
              adsPaused: res.adsPaused,
              emergencyStop: reasonTag === 'emergency_stop',
              manualOverride: reasonTag !== 'emergency_stop',
              grantsSpend: false,
            },
          },
          { bestEffort: true }
        );
      } else {
        failed += 1;
      }
    }
    return { paused, failed };
  }

  // ---------------------------------------------------------------- helpers

  private async callGateway(request: GatewayRunRequest, campaign?: AnalyticsCampaign): Promise<GatewayRunSnapshot> {
    const token = await this.options.serviceTokens.mint({
      workspaceId: this.workspaceId,
      ttlSeconds: this.options.tokenTtlSeconds,
    });
    const goalId = request.goalId ?? campaign?.goalId;
    const threadId = request.threadId ?? campaign?.threadId;
    if (this.options.assertions && goalId && threadId) {
      const { token: actAs } = await this.options.assertions.mint({
        userId: request.userId,
        workspaceId: this.workspaceId,
        goalId,
        threadId,
        scopes: ['context:build'],
      });
      request.actAsAssertion = actAs;
    }
    return this.options.client.createRun(request, token);
  }

  private async audit(
    client: PoolClient,
    userId: string,
    row: Record<string, unknown>,
    action:
      | 'approval.granted'
      | 'approval.rejected'
      | 'approval.expired'
      | 'campaign.paused'
      | 'campaign.budget_changed'
      | 'tool.failed',
    outcome: 'success' | 'denied' | 'failure',
    details: Record<string, unknown>,
    errorCode?: string
  ): Promise<void> {
    await this.options.audit.emit(
      {
        action,
        outcome,
        userId,
        workspaceId: this.workspaceId,
        goalId: String(row.goal_id),
        threadId: String(row.thread_id),
        target: { type: 'proposal', id: String(row.id) },
        ...(errorCode ? { errorCode } : {}),
        details: {
          probaCampaignId: row.proba_campaign_id,
          platform: row.platform,
          ...(row.account_id ? { accountId: row.account_id } : {}),
          decisionId: row.decision_id,
          grantsSpend: false,
          ...details,
        },
      },
      { tx: client }
    );
  }
}
