/**
 * Campaign reviewer (Hub side). Hub only STARTS reviews; the brain (gateway run, reviewIntent=brain) judges
 * what to do and when to look again. Hub enforces the outer bounds, which are tighten-only against the
 * gateway code locks, and wakes a campaign early on pressing events.
 */

/** Gateway code locks (proba-llm-gateway src/limbs/review.ts). Hub config may only narrow these. */
export const REVIEW_LOCKS = Object.freeze({ minCheckHours: 1, maxCheckHours: 168, maxAutoChangePct: 20 });

export interface ReviewBounds {
  minCheckHours: number;
  maxCheckHours: number;
  maxAutoChangePct: number;
}

/** Narrow configured values to the locks: a looser value is replaced by the lock, never honoured. */
export function reviewBoundsFrom(raw: Partial<ReviewBounds>): ReviewBounds {
  const pos = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const min = Math.max(REVIEW_LOCKS.minCheckHours, pos(raw.minCheckHours) ?? REVIEW_LOCKS.minCheckHours);
  const max = Math.min(REVIEW_LOCKS.maxCheckHours, pos(raw.maxCheckHours) ?? REVIEW_LOCKS.maxCheckHours);
  const pct = Math.min(REVIEW_LOCKS.maxAutoChangePct, pos(raw.maxAutoChangePct) ?? REVIEW_LOCKS.maxAutoChangePct);
  return { minCheckHours: Math.min(min, max), maxCheckHours: max, maxAutoChangePct: pct };
}

/** Pressing events that wake a review early. Urgent ones skip the minimum interval. */
export const WAKE_EVENTS = ['metrics_anomaly', 'ad_disapproved', 'spend_pace', 'budget_nearly_exhausted', 'goal_off_track'] as const;
export type WakeEvent = (typeof WAKE_EVENTS)[number];
export const URGENT_WAKE_EVENTS: ReadonlySet<WakeEvent> = new Set(['ad_disapproved', 'spend_pace', 'budget_nearly_exhausted']);

export function isWakeEvent(value: unknown): value is WakeEvent {
  return typeof value === 'string' && (WAKE_EVENTS as readonly string[]).includes(value);
}

const HOUR = 3_600_000;

/** Keep a brain-chosen time inside the bounds; a missing or invalid time falls back to min(24h, max). */
export function clampNextCheck(now: Date, bounds: ReviewBounds, requested: unknown): { at: Date; clamped: boolean } {
  const t = typeof requested === 'string' ? Date.parse(requested) : NaN;
  const lo = now.getTime() + bounds.minCheckHours * HOUR;
  const hi = now.getTime() + bounds.maxCheckHours * HOUR;
  if (!Number.isFinite(t)) return { at: new Date(Math.min(hi, Math.max(lo, now.getTime() + 24 * HOUR))), clamped: true };
  const at = Math.min(hi, Math.max(lo, t));
  return { at: new Date(at), clamped: at !== t };
}

/**
 * When a woken campaign may run: urgent events now; others not before last review + minimum interval.
 * Returns the time to store as next_check_at (never later than the current one).
 */
export function wakeTime(now: Date, bounds: ReviewBounds, event: WakeEvent, lastReviewedAt: Date | null, current: Date | null): Date {
  let at = now.getTime();
  if (!URGENT_WAKE_EVENTS.has(event) && lastReviewedAt) at = Math.max(at, lastReviewedAt.getTime() + bounds.minCheckHours * HOUR);
  if (current && current.getTime() < at) at = current.getTime();
  return new Date(at);
}

export type Checkpoint = 'day3' | 'day7' | 'final';

/** The earliest checkpoint that is due and not yet reported (day 3, day 7, end of the planned duration). */
export function dueCheckpoint(now: Date, launchedAt: Date, done: readonly string[], durationDays: number | undefined): Checkpoint | undefined {
  const days = (now.getTime() - launchedAt.getTime()) / (24 * HOUR);
  const final = durationDays !== undefined && durationDays > 0 ? durationDays : undefined;
  const due: Checkpoint[] = [];
  if (days >= 3) due.push('day3');
  if (days >= 7) due.push('day7');
  if (final !== undefined && days >= final) due.push('final');
  // At the end only the final report matters.
  if (due.includes('final') && !done.includes('final')) return 'final';
  return due.find((c) => !done.includes(c));
}

export interface ReviewNote {
  kind?: string;
  decision?: string;
  summary?: string;
  whyNowOrNotYet?: string;
  nextCheckAt?: string;
  nextCheckReason?: string;
  checkpoint?: { checkpoint?: string };
  proposal?: { withinAutoLimit?: boolean; changePct?: number };
}

export function reviewNoteOf(summary: Record<string, unknown> | null | undefined): ReviewNote | undefined {
  const note = summary?.review;
  return typeof note === 'object' && note !== null && !Array.isArray(note) ? (note as ReviewNote) : undefined;
}
