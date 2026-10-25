import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, validateAuditEvent } from './vendor/proba-audit/index.js';
import { createHubAudit, type AuditActionName } from './service.js';
import { newTraceContext, runWithTrace, setTraceUser, bindTraceId, startSpan } from './trace.js';
import { MemoryOutbox, captureLogger, fixedClock, sequentialIds } from './test-support.js';

const UUID = '3f2b8c1e-9d4a-4b6e-8a7f-1c2d3e4f5a6b';
const USER = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';

function setup(overrides: Partial<Parameters<typeof createHubAudit>[0]> = {}) {
  const outbox = new MemoryOutbox();
  const { logger, lines } = captureLogger();
  const audit = createHubAudit({
    outbox,
    enabled: true,
    service: 'hub',
    defaultWorkspaceId: 'seedbed',
    clock: fixedClock(),
    ids: sequentialIds(),
    logger,
    ...overrides,
  });
  return { audit, outbox, lines };
}

describe('HubAudit.emit', () => {
  it('builds a valid protocol event: category from the action, defaults, redacted details', async () => {
    const { audit, outbox } = setup();
    const ctx = newTraceContext(UUID);
    await runWithTrace(ctx, async () => {
      setTraceUser(USER);
      await audit.emit({
        action: 'command.received',
        outcome: 'success',
        root: true,
        details: { commandType: 'send_message', token: 'secret', note: 'mail a@b.com' },
      });
    });
    const [event] = outbox.events;
    expect(validateAuditEvent(event).success).toBe(true);
    expect(event).toMatchObject({
      traceId: UUID,
      spanId: ctx.rootSpanId,
      workspaceId: 'seedbed',
      service: 'hub',
      category: 'command',
      action: 'command.received',
      userId: USER,
      actor: { type: 'user', id: USER },
      occurredAt: '2026-10-25T10:00:00.000Z',
    });
    expect(event.parentSpanId).toBeUndefined();
    expect(event.details).toEqual({ commandType: 'send_message', token: '[REDACTED]', note: 'mail [REDACTED_EMAIL]' });
  });

  it('derives the category for every action in AUDIT_ACTIONS', async () => {
    const { audit, outbox } = setup();
    for (const [category, actions] of Object.entries(AUDIT_ACTIONS)) {
      for (const action of actions) {
        await audit.emit({ action: action as AuditActionName, outcome: 'success' });
        expect(outbox.events.at(-1)?.category).toBe(category);
      }
    }
    expect(outbox.events.every((e) => validateAuditEvent(e).success)).toBe(true);
  });

  it('chains spans: root has no parent, children point at the root or an explicit span', async () => {
    const { audit, outbox } = setup();
    const ctx = newTraceContext(UUID);
    await runWithTrace(ctx, async () => {
      await audit.emit({ action: 'command.received', outcome: 'success', root: true });
      await audit.emit({ action: 'command.accepted', outcome: 'success' });
      const brain = startSpan();
      await audit.emit({ action: 'brain.llm_call', outcome: 'success', spanId: brain.spanId, parentSpanId: brain.parentSpanId });
      await audit.emit({ action: 'tool.called', outcome: 'success', parentSpanId: brain.spanId });
    });
    const [received, accepted, llm, tool] = outbox.events;
    expect(received.parentSpanId).toBeUndefined();
    expect(accepted.parentSpanId).toBe(received.spanId);
    expect(llm.parentSpanId).toBe(received.spanId);
    expect(tool.parentSpanId).toBe(llm.spanId);
    expect(new Set(outbox.events.map((e) => e.traceId))).toEqual(new Set([UUID]));
    expect(new Set(outbox.events.map((e) => e.spanId)).size).toBe(4);
  });

  it('records a client message id that could not become the traceId', async () => {
    const { audit, outbox } = setup();
    const ctx = newTraceContext();
    await runWithTrace(ctx, async () => {
      bindTraceId('legacy-id-1');
      await audit.emit({ action: 'command.rejected', outcome: 'failure' });
    });
    expect(outbox.events[0].traceId).toBe(ctx.traceId);
    expect(outbox.events[0].details).toMatchObject({ clientMsgId: 'legacy-id-1' });
  });

  it('uses the system actor when nobody is authenticated and a fresh trace outside a request', async () => {
    const { audit, outbox } = setup();
    await audit.emit({ action: 'system.started', outcome: 'success' });
    expect(outbox.events[0].actor).toEqual({ type: 'system', id: 'hub' });
    expect(outbox.events[0].traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes nothing when disabled', async () => {
    const { audit, outbox } = setup({ enabled: false });
    expect(await audit.emit({ action: 'command.received', outcome: 'success' })).toBeNull();
    expect(outbox.rows).toHaveLength(0);
  });

  it('refuses an action that is not in AUDIT_ACTIONS (never invents one)', async () => {
    const { audit, outbox, lines } = setup();
    expect(await audit.emit({ action: 'goal.created' as AuditActionName, outcome: 'success' })).toBeNull();
    expect(outbox.rows).toHaveLength(0);
    expect(lines.some((l) => l.level === 'error')).toBe(true);
  });

  it('fails open on validation errors: logs an error and returns null', async () => {
    const { audit, outbox, lines } = setup();
    const result = await audit.emit({
      action: 'command.received',
      outcome: 'success',
      cost: { currency: 'usd-not-iso', amount: 1 },
    });
    expect(result).toBeNull();
    expect(outbox.rows).toHaveLength(0);
    expect(lines.some((l) => l.level === 'error' && l.msg === 'audit event not emitted')).toBe(true);
  });

  it('fails closed on database errors (throws so the business transaction rolls back)', async () => {
    const { audit, outbox } = setup();
    outbox.failEnqueue = new Error('connection terminated');
    await expect(audit.emit({ action: 'command.received', outcome: 'success' })).rejects.toThrow('connection terminated');
  });

  it('bestEffort never throws', async () => {
    const { audit, outbox, lines } = setup();
    outbox.failEnqueue = new Error('connection terminated');
    expect(await audit.emit({ action: 'data_access.read', outcome: 'success' }, { bestEffort: true })).toBeNull();
    expect(lines.some((l) => l.msg.includes('best effort'))).toBe(true);
  });

  it('redacts secrets out of error messages', async () => {
    const { audit, outbox } = setup();
    await audit.emit({
      action: 'system.error',
      outcome: 'failure',
      errorMessage: 'upstream said Bearer abc123 for bob@example.com',
    });
    expect(outbox.events[0].errorMessage).not.toMatch(/abc123|bob@example/);
  });

  it('keeps durationMs a non-negative integer', async () => {
    const { audit, outbox } = setup();
    await audit.emit({ action: 'command.processed', outcome: 'success', durationMs: 12.7 });
    await audit.emit({ action: 'command.processed', outcome: 'success', durationMs: -5 });
    expect(outbox.events.map((e) => e.durationMs)).toEqual([13, 0]);
  });
});
