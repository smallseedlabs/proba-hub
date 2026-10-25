import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import {
  bindTraceId,
  currentTrace,
  newTraceContext,
  runAsJob,
  runInSpan,
  runWithTrace,
  setTraceUser,
  startSpan,
  traceMixin,
} from './trace.js';

const UUID = '3f2b8c1e-9d4a-4b6e-8a7f-1c2d3e4f5a6b';

describe('trace context', () => {
  it('is empty outside a request', () => {
    expect(currentTrace()).toBeUndefined();
    expect(traceMixin()).toEqual({});
  });

  it('survives awaits, timers and setImmediate (the 202-then-process path)', async () => {
    const ctx = newTraceContext();
    const seen: Array<string | undefined> = [];
    await runWithTrace(ctx, async () => {
      seen.push(currentTrace()?.traceId);
      await new Promise<void>((resolve) => setImmediate(() => {
        seen.push(currentTrace()?.traceId);
        resolve();
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      seen.push(currentTrace()?.traceId);
    });
    expect(seen).toEqual([ctx.traceId, ctx.traceId, ctx.traceId]);
  });

  it('keeps concurrent requests apart', async () => {
    const a = newTraceContext();
    const b = newTraceContext();
    const read = async (ctx: typeof a) =>
      runWithTrace(ctx, async () => {
        await new Promise((r) => setTimeout(r, ctx === a ? 5 : 1));
        return currentTrace()?.traceId;
      });
    expect(await Promise.all([read(a), read(b)])).toEqual([a.traceId, b.traceId]);
  });

  it('roots the trace in a UUID clientMsgId (lower-cased) and mutates in place', () => {
    const ctx = newTraceContext();
    runWithTrace(ctx, () => bindTraceId(UUID.toUpperCase()));
    expect(ctx.traceId).toBe(UUID);
    expect(ctx.clientMsgId).toBeUndefined();
  });

  it('keeps the generated traceId for a non-UUID clientMsgId and remembers the raw id', () => {
    const ctx = newTraceContext();
    const generated = ctx.traceId;
    runWithTrace(ctx, () => bindTraceId('not-a-uuid'));
    expect(ctx.traceId).toBe(generated);
    expect(ctx.clientMsgId).toBe('not-a-uuid');
    runWithTrace(ctx, () => bindTraceId('x'.repeat(500)));
    expect(ctx.clientMsgId).toHaveLength(128);
  });

  it('ignores non-string ids and calls outside a context', () => {
    expect(() => bindTraceId(UUID)).not.toThrow();
    const ctx = newTraceContext();
    runWithTrace(ctx, () => {
      bindTraceId(42);
      bindTraceId(undefined);
      bindTraceId('');
    });
    expect(ctx.clientMsgId).toBeUndefined();
  });

  it('nests spans: children point at the span that was current', () => {
    const ctx = newTraceContext();
    runWithTrace(ctx, () => {
      const brain = startSpan();
      expect(brain.parentSpanId).toBe(ctx.rootSpanId);
      expect(brain.spanId).toMatch(/^[0-9a-f]{16}$/);
      runInSpan(brain, () => {
        expect(currentTrace()?.spanId).toBe(brain.spanId);
        expect(currentTrace()?.traceId).toBe(ctx.traceId);
        const tool = startSpan();
        expect(tool.parentSpanId).toBe(brain.spanId);
      });
      expect(currentTrace()?.spanId).toBe(ctx.rootSpanId);
      expect(startSpan('abcdefabcdefabcd').parentSpanId).toBe('abcdefabcdefabcd');
    });
  });

  it('gives every background job run its own traceId', () => {
    const first = runAsJob(() => currentTrace()?.traceId);
    const second = runAsJob(() => currentTrace()?.traceId);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  it('records the authenticated user on the context', () => {
    const ctx = newTraceContext();
    runWithTrace(ctx, () => setTraceUser('user-1'));
    expect(ctx.userId).toBe('user-1');
  });

  it('puts traceId on every pino line written inside a trace (and none outside)', () => {
    const lines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(String(chunk)));
        cb();
      },
    });
    const log = pino({ mixin: traceMixin }, sink);
    const child = log.child({ component: 'x' });
    log.info('outside');
    const ctx = newTraceContext(UUID);
    runWithTrace(ctx, () => {
      log.info('root logger');
      child.warn({ a: 1 }, 'child logger');
      log.error({ err: new Error('boom') }, 'error line');
    });
    expect(lines[0].traceId).toBeUndefined();
    expect(lines.slice(1).map((l) => l.traceId)).toEqual([UUID, UUID, UUID]);
  });
});
