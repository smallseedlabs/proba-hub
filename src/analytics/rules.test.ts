import { describe, expect, it } from 'vitest';
import { decideIntent, rulesIssue, stableUuid, totals, windowKey } from './rules.js';

describe('analytics rules', () => {
  const rules = {
    pauseWhen: { minSpend: 20, maxConversions: 0 },
    capWhen: { minSpend: 20, maxCostPerConversion: 10, proposedDailyBudget: 5 },
  };

  it('never treats unknown metrics as zero', () => {
    const m = totals([{ impressions: 100, clicks: 2, spend: 30, conversions: 'unknown' }]);
    expect(m.conversions).toBe('unknown');
    expect(decideIntent({ rules, metrics: m, currentDailyBudget: 10 }).intent).toBe('report');
  });

  it('proposes pause when spend is high and conversions are low', () => {
    const m = totals([{ impressions: 100, clicks: 2, spend: 30, conversions: 0 }]);
    expect(decideIntent({ rules, metrics: m, currentDailyBudget: 10 }).intent).toBe('propose_pause');
  });

  it('proposes a cap only as a decrease from a known current budget', () => {
    const m = totals([{ impressions: 100, clicks: 2, spend: 60, conversions: 2 }]);
    expect(decideIntent({ rules, metrics: m, currentDailyBudget: 10 })).toMatchObject({ intent: 'propose_cap', dailyBudget: 5 });
    expect(decideIntent({ rules, metrics: m, currentDailyBudget: null }).intent).toBe('report');
    expect(decideIntent({ rules, metrics: m, currentDailyBudget: 4 }).intent).toBe('report');
  });

  it('reports when no rules are set (rules are owner opt-in)', () => {
    const m = totals([{ impressions: 100, clicks: 2, spend: 60, conversions: 0 }]);
    expect(decideIntent({ rules: {}, metrics: m, currentDailyBudget: 10 }).intent).toBe('report');
  });

  it('validates rule documents', () => {
    expect(rulesIssue(rules)).toBeUndefined();
    expect(rulesIssue({ autoExecute: true })).toMatch(/unknown rule/);
    expect(rulesIssue({ capWhen: { minSpend: 1, maxCostPerConversion: 1 } })).toMatch(/capWhen/);
  });

  it('coalesces by window and produces stable uuids', () => {
    const a = windowKey(new Date('2026-11-09T10:00:00Z'), 6 * 3600_000);
    const b = windowKey(new Date('2026-11-09T11:59:00Z'), 6 * 3600_000);
    expect(a).toBe(b);
    expect(stableUuid('x', a)).toBe(stableUuid('x', b));
    expect(stableUuid('x', a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
