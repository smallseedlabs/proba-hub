import { describe, expect, it } from 'vitest';
import { OutboxRelay, RedisStreamsPublisher, buildAuditEvent, type EventBus } from './vendor/proba-audit/index.js';
import { MemoryOutbox, captureLogger, fixedClock } from './test-support.js';

const event = (n: number) =>
  buildAuditEvent({
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    traceId: '3f2b8c1e-9d4a-4b6e-8a7f-1c2d3e4f5a6b',
    spanId: '00000000000000a1',
    workspaceId: 'seedbed',
    actor: { type: 'system', id: 'hub' },
    service: 'hub',
    action: 'system.started',
    category: 'system',
    outcome: 'success',
  });

describe('OutboxRelay (vendored) with the Hub wiring', () => {
  it('publishes claimed rows in order to the configured topic, then marks them published', async () => {
    const outbox = new MemoryOutbox();
    await outbox.enqueue([event(1), event(2), event(3)]);
    const published: Array<{ topic: string; payloads: unknown[] }> = [];
    const bus: EventBus = {
      publish: async () => '1-0',
      publishBatch: async (topic, payloads) => {
        published.push({ topic, payloads });
        return payloads.map((_, i) => `${i}-0`);
      },
    };
    const relay = new OutboxRelay({ outbox, bus, topic: 'proba.audit.events', logger: captureLogger().logger });
    expect(await relay.runOnce()).toEqual({ claimed: 3, published: 3, failed: 0 });
    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe('proba.audit.events');
    expect((published[0].payloads as Array<{ eventId: string }>).map((p) => p.eventId.slice(-1))).toEqual(['1', '2', '3']);
    expect(await outbox.pendingCount()).toBe(0);
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  it('keeps rows (and retries after the lease) when the bus fails', async () => {
    const outbox = new MemoryOutbox();
    let now = 1_000;
    outbox.now = () => now;
    await outbox.enqueue([event(1)]);
    let fail = true;
    const bus: EventBus = {
      publish: async () => '1-0',
      publishBatch: async (_t, payloads) => {
        if (fail) throw new Error('redis down');
        return payloads.map(() => '1-0');
      },
    };
    const relay = new OutboxRelay({ outbox, bus, topic: 't', logger: captureLogger().logger, leaseMs: 100 });
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    expect(await outbox.pendingCount()).toBe(1);
    expect(outbox.rows[0].error).toBe('redis down');
    expect((await relay.runOnce()).claimed).toBe(0); // still leased
    fail = false;
    now += 101;
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    expect(outbox.rows[0].attempts).toBe(2);
  });
});

describe('RedisStreamsPublisher', () => {
  function fakeClient() {
    const calls: Array<{ key: string; id: string; message: Record<string, string>; options?: unknown }> = [];
    return {
      calls,
      client: {
        xAdd: async (key: string, id: string, message: Record<string, string>, options?: unknown) => {
          calls.push({ key, id, message, options });
          return `${calls.length}-0`;
        },
        multi: () => {
          const queued: Array<() => Promise<string>> = [];
          const m = {
            xAdd(key: string, id: string, message: Record<string, string>, options?: unknown) {
              queued.push(async () => {
                calls.push({ key, id, message, options });
                return `${calls.length}-0`;
              });
              return m;
            },
            exec: async () => {
              const out: string[] = [];
              for (const q of queued) out.push(await q());
              return out;
            },
          };
          return m;
        },
      },
    };
  }

  it('writes the entry format proba-audit consumes: data (JSON), publishedAt, optional key', async () => {
    const { client, calls } = fakeClient();
    const publisher = new RedisStreamsPublisher({ client, clock: fixedClock('2026-10-25T10:00:00.000Z') });
    const e = event(7);
    await publisher.publish('proba.audit.events', e, { key: 'seedbed' });
    await publisher.publishBatch('proba.audit.events', [event(1), event(2)]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ key: 'proba.audit.events', id: '*' });
    expect(JSON.parse(calls[0].message.data)).toEqual(JSON.parse(JSON.stringify(e)));
    expect(calls[0].message.publishedAt).toBe('2026-10-25T10:00:00.000Z');
    expect(calls[0].message.key).toBe('seedbed');
    expect(Object.keys(calls[1].message).sort()).toEqual(['data', 'publishedAt']);
    expect(calls[0].options).toBeUndefined();
  });

  it('trims with MAXLEN ~ when configured and returns ids in order', async () => {
    const { client, calls } = fakeClient();
    const publisher = new RedisStreamsPublisher({ client, clock: fixedClock(), maxStreamLength: 1000 });
    expect(await publisher.publishBatch('t', [event(1), event(2)])).toEqual(['1-0', '2-0']);
    expect(calls[0].options).toEqual({ TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 1000 } });
    expect(await publisher.publishBatch('t', [])).toEqual([]);
  });
});
