import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('H3-05 paid_actions persistence and per-goal cost sum', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('persists paid_actions and returns per-goal cost sum', async () => {
    const rows: Array<{
      id: string;
      goal_id: string;
      user_id: string;
      action_type: string;
      estimated_cost_usd: number;
      justification: string;
      evidence: string;
      created_at: string;
    }> = [];
    const userId = '11111111-1111-4111-8111-111111111111';
    const goalId = '22222222-2222-4222-8222-222222222222';

    vi.doMock('../db/client.js', () => ({
      pool: {
        query: async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM goals WHERE id = $1')) {
            return { rows: [{ id: goalId }], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO paid_actions')) {
            const [, gId, uId, actionType, cost, justification, evidence] = params as [
              string,
              string,
              string,
              string,
              number,
              string,
              string,
            ];
            const row = {
              id: `pa-${rows.length + 1}`,
              goal_id: gId,
              user_id: uId,
              action_type: actionType,
              estimated_cost_usd: cost,
              justification,
              evidence,
              created_at: '2026-11-21T22:00:00Z',
            };
            rows.push(row);
            return { rows: [row], rowCount: 1 };
          }
          if (sql.includes('SUM(estimated_cost_usd)')) {
            const total = rows.reduce((s, r) => s + r.estimated_cost_usd, 0);
            return { rows: [{ total_usd: total, count: rows.length }], rowCount: 1 };
          }
          if (sql.includes('FROM paid_actions')) {
            return { rows, rowCount: rows.length };
          }
          return { rows: [], rowCount: 0 };
        },
      },
    }));

    const { analyticsRoutes } = await import('./analytics.js');
    const app = Fastify();
    app.decorate('authenticate', async (request: { user?: { id: string; email: string } }) => {
      request.user = { id: userId, email: 'founder@smallseed.dev' };
    });
    await app.register(analyticsRoutes, {
      prefix: '/v1',
      service: {} as never,
      workspaceId: 'ws_1',
    });

    const p1 = await app.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/paid-actions`,
      payload: {
        actionType: 'media_generate',
        estimatedCostUsd: 0.08,
        justification: 'no_usable_site_image',
        evidence: '0 images >= 400px found',
      },
    });
    expect(p1.statusCode).toBe(201);

    const p2 = await app.inject({
      method: 'POST',
      url: `/v1/goals/${goalId}/paid-actions`,
      payload: {
        actionType: 'llm_call',
        estimatedCostUsd: 0.12,
        justification: 'user_requested',
        evidence: 'Campaign copy generation',
      },
    });
    expect(p2.statusCode).toBe(201);

    const sum = await app.inject({
      method: 'GET',
      url: `/v1/goals/${goalId}/costs`,
    });
    expect(sum.statusCode).toBe(200);
    expect(sum.json()).toMatchObject({
      goalId,
      totalUsd: 0.2,
      count: 2,
    });
    await app.close();
  });
});
