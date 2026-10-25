import type { AuditEvent, Clock, IdGenerator, Logger, OutboxEntry, OutboxStore } from './vendor/proba-audit/index.js';

/** In-memory OutboxStore for unit tests (the real one is exercised against Postgres). */
export class MemoryOutbox implements OutboxStore<unknown> {
  rows: Array<{ id: number; event: AuditEvent; published: boolean; lockedUntil: number; attempts: number; error?: string }> = [];
  failEnqueue: Error | null = null;
  private nextId = 1;
  now = () => Date.now();

  async enqueue(events: AuditEvent[]): Promise<number> {
    if (this.failEnqueue) throw this.failEnqueue;
    let n = 0;
    for (const event of events) {
      if (this.rows.some((r) => r.event.eventId === event.eventId)) continue;
      this.rows.push({ id: this.nextId++, event, published: false, lockedUntil: 0, attempts: 0 });
      n++;
    }
    return n;
  }
  async claim(limit: number, leaseMs: number): Promise<OutboxEntry[]> {
    const now = this.now();
    const claimed = this.rows.filter((r) => !r.published && r.lockedUntil <= now).slice(0, limit);
    for (const r of claimed) {
      r.lockedUntil = now + leaseMs;
      r.attempts++;
    }
    return claimed.map((r) => ({ id: String(r.id), event: r.event, createdAt: new Date().toISOString(), attempts: r.attempts }));
  }
  async markPublished(ids: string[]): Promise<void> {
    for (const r of this.rows) if (ids.includes(String(r.id))) r.published = true;
  }
  async markFailed(ids: string[], error: string): Promise<void> {
    for (const r of this.rows) if (ids.includes(String(r.id))) r.error = error;
  }
  async pendingCount(): Promise<number> {
    return this.rows.filter((r) => !r.published).length;
  }
  async prunePublished(): Promise<number> {
    return 0;
  }
  async ping(): Promise<void> {}
  async close(): Promise<void> {}
  get events(): AuditEvent[] {
    return this.rows.map((r) => r.event);
  }
}

export const fixedClock = (iso = '2026-10-25T10:00:00.000Z'): Clock => ({ now: () => new Date(iso), isoNow: () => iso });

export function sequentialIds(): IdGenerator {
  let n = 0;
  const hex = (v: number, len: number) => v.toString(16).padStart(len, '0');
  return {
    uuid: () => `00000000-0000-4000-8000-${hex(++n, 12)}`,
    spanId: () => hex(++n + 0xabc0000000, 16),
  };
}

export interface CapturedLog {
  level: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export function captureLogger(): { logger: Logger; lines: CapturedLog[] } {
  const lines: CapturedLog[] = [];
  const make = (): Logger => ({
    debug: (msg, fields) => void lines.push({ level: 'debug', msg, fields }),
    info: (msg, fields) => void lines.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => void lines.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => void lines.push({ level: 'error', msg, fields }),
    child: () => make(),
  });
  return { logger: make(), lines };
}
