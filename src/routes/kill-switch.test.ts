import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('H1-05 POST /v1/kill-switch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('pauses all workspace campaigns idempotently and emits control.emergency_stopped', async () => {
    const emitted: Array<{ action: string; outcome: string }> = [];
    vi.doMock('../audit/service.js', () => ({
      getAudit: () => ({
        emit: async (event: { action: string; outcome: string }) => {
          emitted.push({ action: event.action, outcome: event.outcome });
          return { spanId: 's1' };
        },
      }),
    }));

    const { analyticsRoutes } = await import('./analytics.js');
    const app = Fastify();
    const userId = '11111111-1111-4111-8111-111111111111';
    app.decorate('authenticate', async (request: { user?: { id: string; email: string } }) => {
      request.user = { id: userId, email: 'founder@smallseed.dev' };
    });

    const emergencyPauseAll = vi
      .fn()
      .mockResolvedValueOnce({ paused: 2, failed: 0 })
      .mockResolvedValueOnce({ paused: 0, failed: 0 });

    await app.register(analyticsRoutes, {
      prefix: '/v1',
      service: { emergencyPauseAll } as never,
      workspaceId: 'ws_1',
    });

    const r1 = await app.inject({ method: 'POST', url: '/v1/kill-switch' });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({ ok: true, paused: 2, failed: 0 });

    const r2 = await app.inject({ method: 'POST', url: '/v1/kill-switch' });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ ok: true, paused: 0, failed: 0 });

    expect(emergencyPauseAll).toHaveBeenCalledTimes(2);
    expect(emergencyPauseAll).toHaveBeenCalledWith(userId);
    expect(emitted.filter((e) => e.action === 'control.emergency_stopped')).toHaveLength(2);
    await app.close();
  });
});
