/**
 * Owner-set deterministic review rules. Pure functions; no I/O.
 *
 * The gateway evaluator only proposes when asked (`reviewIntent`). Hub decides
 * which intent to ask for from the owner's rules applied to the latest known
 * metrics. Unknown metrics never trigger a rule (unknown is not zero), and no
 * rule can propose a budget increase.
 */

import { createHash } from 'node:crypto';

export type ReviewIntent = 'report' | 'propose_pause' | 'propose_cap';

export interface AnalyticsRules {
  /** Propose pause when spend >= minSpend and conversions <= maxConversions. */
  pauseWhen?: { minSpend: number; maxConversions: number };
  /** Propose a cap decrease when spend >= minSpend and cost per conversion > maxCostPerConversion. */
  capWhen?: { minSpend: number; maxCostPerConversion: number; proposedDailyBudget: number };
}

export type MetricValue = number | 'unknown';

export interface MetricRow {
  impressions: MetricValue;
  clicks: MetricValue;
  spend: MetricValue;
  conversions: MetricValue;
}

export interface MetricTotals {
  impressions: MetricValue;
  clicks: MetricValue;
  spend: MetricValue;
  conversions: MetricValue;
}

function sum(values: MetricValue[]): MetricValue {
  if (values.length === 0) return 'unknown';
  let total = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'unknown';
    total += v;
  }
  return total;
}

export function totals(rows: MetricRow[]): MetricTotals {
  return {
    impressions: sum(rows.map((r) => r.impressions)),
    clicks: sum(rows.map((r) => r.clicks)),
    spend: sum(rows.map((r) => r.spend)),
    conversions: sum(rows.map((r) => r.conversions)),
  };
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Validate an owner rules document. Returns an error message or undefined. */
export function rulesIssue(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'rules must be an object';
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (key !== 'pauseWhen' && key !== 'capWhen') return `unknown rule ${key}`;
  }
  if (r.pauseWhen !== undefined) {
    const p = r.pauseWhen as Record<string, unknown>;
    if (!p || typeof p !== 'object' || !finiteNonNegative(p.minSpend) || !finiteNonNegative(p.maxConversions)) {
      return 'pauseWhen needs numeric minSpend and maxConversions';
    }
  }
  if (r.capWhen !== undefined) {
    const c = r.capWhen as Record<string, unknown>;
    if (
      !c ||
      typeof c !== 'object' ||
      !finiteNonNegative(c.minSpend) ||
      !finitePositive(c.maxCostPerConversion) ||
      !finitePositive(c.proposedDailyBudget)
    ) {
      return 'capWhen needs numeric minSpend, maxCostPerConversion and proposedDailyBudget';
    }
  }
  return undefined;
}

export type IntentDecision =
  | { intent: 'report'; reason: string }
  | { intent: 'propose_pause'; reason: string }
  | { intent: 'propose_cap'; reason: string; dailyBudget: number };

/** Decide which review to request. Pause wins over cap. */
export function decideIntent(input: {
  rules: AnalyticsRules;
  metrics: MetricTotals | undefined;
  currentDailyBudget: number | null | undefined;
}): IntentDecision {
  const m = input.metrics;
  if (!m) return { intent: 'report', reason: 'no earlier metrics; reporting first' };
  const { pauseWhen, capWhen } = input.rules;
  if (pauseWhen && typeof m.spend === 'number' && typeof m.conversions === 'number') {
    if (m.spend >= pauseWhen.minSpend && m.conversions <= pauseWhen.maxConversions) {
      return {
        intent: 'propose_pause',
        reason: `spend ${m.spend} >= ${pauseWhen.minSpend} with ${m.conversions} conversions (<= ${pauseWhen.maxConversions})`,
      };
    }
  }
  if (capWhen && typeof m.spend === 'number' && typeof m.conversions === 'number' && m.conversions > 0) {
    const cpa = m.spend / m.conversions;
    const current = input.currentDailyBudget;
    if (
      m.spend >= capWhen.minSpend &&
      cpa > capWhen.maxCostPerConversion &&
      typeof current === 'number' &&
      capWhen.proposedDailyBudget < current
    ) {
      return {
        intent: 'propose_cap',
        dailyBudget: capWhen.proposedDailyBudget,
        reason: `cost per conversion ${cpa.toFixed(2)} > ${capWhen.maxCostPerConversion}; cap ${current} -> ${capWhen.proposedDailyBudget}`,
      };
    }
  }
  return { intent: 'report', reason: 'no owner rule triggered on known metrics' };
}

/** Coalescing window for scheduled reviews. */
export function windowKey(now: Date, cadenceMs: number): string {
  return `w${cadenceMs}:${Math.floor(now.getTime() / cadenceMs)}`;
}

/** Deterministic RFC 4122-shaped UUID (version 5 nibble) so retries replay on the gateway. */
export function stableUuid(...parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
