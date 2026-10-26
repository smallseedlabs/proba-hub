import { describe, expect, it, vi } from 'vitest';
import { createAuditPublisher } from './publisher.js';
import { fixedClock } from './test-support.js';

describe('createAuditPublisher', () => {
  const clock = fixedClock();

  it('log adapter logs ids only and returns ordered message ids', async () => {
    const info = vi.fn();
    const bus = createAuditPublisher('log', { clock, logger: { info } });
    const ids = await bus.publishBatch('proba.audit.events', [
      { eventId: 'e1', traceId: 't1', action: 'goal.created', content: { text: 'secret text' }, details: { a: 1 } },
      { eventId: 'e2', traceId: 't1', action: 'goal.updated' },
    ]);
    expect(ids).toEqual(['log-1', 'log-2']);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[0][0]).toEqual({
      topic: 'proba.audit.events',
      messageId: 'log-1',
      eventId: 'e1',
      traceId: 't1',
      action: 'goal.created',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret text');
  });

  it('redis adapter does not load the Redis connection until the first publish', () => {
    const bus = createAuditPublisher('redis', { clock, logger: { info: vi.fn() } });
    expect(typeof bus.publish).toBe('function');
    expect(typeof bus.publishBatch).toBe('function');
  });

  it('rejects an unknown kind', () => {
    expect(() => createAuditPublisher('kafka' as never, { clock, logger: { info: vi.fn() } })).toThrow(/Unknown audit publisher/);
  });
});

describe('AUDIT_PUBLISHER config', () => {
  const load = async (value?: string) => {
    vi.resetModules();
    if (value === undefined) delete process.env.AUDIT_PUBLISHER;
    else process.env.AUDIT_PUBLISHER = value;
    return (await import('../config.js')).config.audit.publisher;
  };

  it('defaults to redis, accepts log (any case) and rejects anything else', async () => {
    try {
      expect(await load()).toBe('redis');
      expect(await load('')).toBe('redis');
      expect(await load(' LOG ')).toBe('log');
      await expect(load('kafka')).rejects.toThrow(/AUDIT_PUBLISHER must be one of redis, log/);
    } finally {
      delete process.env.AUDIT_PUBLISHER;
      vi.resetModules();
    }
  });
});
