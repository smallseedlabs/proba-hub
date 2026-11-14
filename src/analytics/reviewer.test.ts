import { describe, expect, it } from 'vitest';
import { clampNextCheck, dueCheckpoint, REVIEW_LOCKS, reviewBoundsFrom, wakeTime } from './reviewer.js';

const now = new Date('2026-11-14T10:00:00.000Z');
const H = 3_600_000;
const bounds = reviewBoundsFrom({ minCheckHours: 6, maxCheckHours: 72, maxAutoChangePct: 20 });

describe('reviewer bounds are tighten-only', () => {
  it('replaces looser values with the gateway locks', () => {
    expect(reviewBoundsFrom({ minCheckHours: 0.1, maxCheckHours: 1000, maxAutoChangePct: 90 })).toEqual({ ...REVIEW_LOCKS });
    expect(reviewBoundsFrom({ minCheckHours: 100, maxCheckHours: 50 })).toMatchObject({ minCheckHours: 50, maxCheckHours: 50 });
  });

  it('clamps the brain-chosen time; missing falls back to 24h inside the bounds', () => {
    expect(clampNextCheck(now, bounds, new Date(now.getTime() + 200 * H).toISOString())).toEqual({ at: new Date(now.getTime() + 72 * H), clamped: true });
    expect(clampNextCheck(now, bounds, new Date(now.getTime() + 1 * H).toISOString()).at).toEqual(new Date(now.getTime() + 6 * H));
    expect(clampNextCheck(now, bounds, new Date(now.getTime() + 30 * H).toISOString())).toEqual({ at: new Date(now.getTime() + 30 * H), clamped: false });
    expect(clampNextCheck(now, bounds, undefined).at).toEqual(new Date(now.getTime() + 24 * H));
  });
});

describe('wake events', () => {
  const last = new Date(now.getTime() - 2 * H);
  const current = new Date(now.getTime() + 48 * H);
  it('urgent events run now; others respect the minimum interval since the last review', () => {
    expect(wakeTime(now, bounds, 'ad_disapproved', last, current)).toEqual(now);
    expect(wakeTime(now, bounds, 'metrics_anomaly', last, current)).toEqual(new Date(last.getTime() + 6 * H));
  });
  it('never pushes a check later than already planned', () => {
    const soon = new Date(now.getTime() + 1 * H);
    expect(wakeTime(now, bounds, 'goal_off_track', last, soon)).toEqual(soon);
  });
});

describe('checkpoints', () => {
  const launched = (days: number) => new Date(now.getTime() - days * 24 * H);
  it('day 3, day 7, then final at the planned duration; each once', () => {
    expect(dueCheckpoint(now, launched(2), [], 14)).toBeUndefined();
    expect(dueCheckpoint(now, launched(3.5), [], 14)).toBe('day3');
    expect(dueCheckpoint(now, launched(8), ['day3'], 14)).toBe('day7');
    expect(dueCheckpoint(now, launched(8), ['day3', 'day7'], 14)).toBeUndefined();
    expect(dueCheckpoint(now, launched(15), ['day3'], 14)).toBe('final');
    expect(dueCheckpoint(now, launched(15), ['day3', 'day7', 'final'], 14)).toBeUndefined();
    expect(dueCheckpoint(now, launched(30), ['day3', 'day7'], undefined)).toBeUndefined();
  });
});
