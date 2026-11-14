/**
 * FAKE in-process analytics gateway used by Hub tests.
 *
 * Not the gateway evaluator, not the Ads domain, not a provider. It never opens a
 * network destination and never spends. Metrics are fixed test numbers set by the
 * test; "executed" actions only flip an in-memory flag. Every snapshot carries
 * FAKE_ANALYTICS_GATEWAY_LABEL so it cannot be mistaken for a real run.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { GatewayClient, GatewayRunRequest, GatewayRunSnapshot } from '../brain/gateway-client.js';
import { GatewayClientError } from '../brain/gateway-client.js';

export const FAKE_ANALYTICS_GATEWAY_LABEL =
  'FAKE: in-process analytics gateway (no network, no provider, no Ads call, no spend)';

export interface FakeMetricRow {
  impressions: number | 'unknown';
  clicks: number | 'unknown';
  spend: number | 'unknown';
  conversions: number | 'unknown';
}

interface FakeDecision {
  decisionId: string;
  probaCampaignId: string;
  verb: string;
  args: Record<string, unknown>;
  argsHash: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

/** Key-order independent, like the real gateway's canonicalArgsHash (args round-trip through JSONB). */
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class FakeAnalyticsGatewayClient implements GatewayClient {
  readonly label = FAKE_ANALYTICS_GATEWAY_LABEL;
  readonly calls: GatewayRunRequest[] = [];
  readonly executed: Array<{ verb: string; args: Record<string, unknown> }> = [];
  /** Next metrics returned per campaign (set by the test). */
  metrics = new Map<string, FakeMetricRow[]>();
  /** Window the fake evaluator gives a proposal. */
  reviewWindowMs = 6 * 60 * 60 * 1000;
  /** When set, the next approved action fails with this code. */
  failNextAction: string | undefined;
  /** Clock shared with the Hub service under test. */
  now: () => Date = () => new Date();
  private latest = new Map<string, FakeDecision>();
  /** FAKE brain reviewer notes per campaign (reviewIntent=brain); the fake does NOT clamp, Hub must. */
  brainNotes = new Map<string, Record<string, unknown>>();

  async createRun(request: GatewayRunRequest): Promise<GatewayRunSnapshot> {
    this.calls.push(structuredClone(request));
    const payload = rec(rec(request.command).payload);
    const runId = randomUUID();
    if (request.stepType === 'review_performance') return this.review(runId, payload);
    if (request.stepType === 'handle_approval' && payload.analyticsAction) {
      return this.approve(runId, request, rec(payload.analyticsAction));
    }
    throw new GatewayClientError('fake_unsupported', `${FAKE_ANALYTICS_GATEWAY_LABEL}: unsupported step`, 400);
  }

  private review(runId: string, payload: Record<string, unknown>): GatewayRunSnapshot {
    const probaCampaignId = String(payload.probaCampaignId);
    const intent = String(payload.reviewIntent ?? 'report');
    const decisionId = randomUUID();
    const metrics = this.metrics.get(probaCampaignId) ?? [];
    const until = new Date(this.now().getTime() + this.reviewWindowMs).toISOString();
    let proposal: Record<string, unknown> | null = null;
    const note = intent === 'brain' ? this.brainNotes.get(probaCampaignId) : undefined;
    const change = note ? rec(note.change) : {};
    if (note && (change.action === 'pause' || change.action === 'lower_budget')) {
      const verb = change.action === 'pause' ? 'ads.pause_campaign' : 'ads.update_campaign';
      const args =
        change.action === 'pause'
          ? { probaCampaignId }
          : { probaCampaignId, dailyBudget: change.dailyBudget, ...(payload.currency ? { currency: payload.currency } : {}) };
      const argsHash = hash(args);
      proposal = { verb, args, argsHash, grantsSpend: false, dryRun: true };
      this.latest.set(probaCampaignId, { decisionId, probaCampaignId, verb, args, argsHash });
    } else if (intent === 'propose_pause' || intent === 'propose_cap') {
      const verb = intent === 'propose_pause' ? 'ads.pause_campaign' : 'ads.update_campaign';
      const args =
        intent === 'propose_pause'
          ? { probaCampaignId }
          : { probaCampaignId, dailyBudget: payload.dailyBudget, ...(payload.currency ? { currency: payload.currency } : {}) };
      const argsHash = hash(args);
      proposal = { verb, args, argsHash, grantsSpend: false };
      this.latest.set(probaCampaignId, { decisionId, probaCampaignId, verb, args, argsHash });
    } else {
      this.latest.delete(probaCampaignId);
    }
    return {
      runId,
      status: 'completed',
      iteration: 1,
      outputs: [{ type: 'text', text: FAKE_ANALYTICS_GATEWAY_LABEL }],
      analytics: {
        fake: FAKE_ANALYTICS_GATEWAY_LABEL,
        decisionId,
        outcome: proposal ? 'dry_run_proposal' : 'report',
        grantsSpend: false,
        asOf: this.now().toISOString(),
        scope: { probaCampaignId, platform: payload.platform, accountId: payload.accountId },
        reviewWindowUntil: until,
        unknownMetrics: metrics.some((m) => Object.values(m).includes('unknown')),
        metrics,
        proposal,
        ...(note
          ? {
              review: {
                ...note,
                nextCheckAt: new Date(this.now().getTime() + Number(note.nextCheckInHours ?? 24) * 3_600_000).toISOString(),
              },
            }
          : {}),
      },
    };
  }

  private approve(runId: string, request: GatewayRunRequest, action: Record<string, unknown>): GatewayRunSnapshot {
    const fail = (code: string): GatewayRunSnapshot => ({
      runId,
      status: 'blocked',
      iteration: 1,
      error: { code, message: `${FAKE_ANALYTICS_GATEWAY_LABEL}: ${code}` },
      actionOutcome: { ok: false, code, fake: FAKE_ANALYTICS_GATEWAY_LABEL },
    });
    if (request.resume?.askId !== action.proposalId) return fail('resume_mismatch');
    const latest = this.latest.get(String(action.probaCampaignId));
    if (!latest || latest.decisionId !== action.decisionId) return fail('proposal_superseded');
    if (latest.argsHash !== action.argsHash || hash(action.args) !== latest.argsHash) return fail('args_mismatch');
    if (this.failNextAction) {
      const code = this.failNextAction;
      this.failNextAction = undefined;
      return fail(code);
    }
    this.executed.push({ verb: latest.verb, args: latest.args });
    this.latest.delete(latest.probaCampaignId);
    return {
      runId,
      status: 'completed',
      iteration: 1,
      actionOutcome: { ok: true, verb: latest.verb, decisionId: latest.decisionId, fake: FAKE_ANALYTICS_GATEWAY_LABEL },
    };
  }

  async getRun(runId: string): Promise<GatewayRunSnapshot> {
    throw new GatewayClientError('fake_not_found', `${FAKE_ANALYTICS_GATEWAY_LABEL}: ${runId}`, 404);
  }

  async cancelRun(runId: string): Promise<GatewayRunSnapshot> {
    return { runId, status: 'cancelled', iteration: 0 };
  }
}
