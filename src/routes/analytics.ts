import { WAKE_EVENTS, type WakeEvent } from '../analytics/reviewer.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { pool, transaction } from '../db/client.js';
import { getAudit } from '../audit/service.js';
import { AnalyticsError, type AnalyticsService } from '../analytics/service.js';
import { parseApprovedCreative, parseApprovedTargeting } from '../analytics/creative.js';

export interface AnalyticsRouteOptions {
  /** Null when the gateway is not configured: read/creative routes work, reviews/decisions return 503. */
  service: AnalyticsService | null;
  workspaceId: string;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AnalyticsError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  throw error;
}

const uuid = { type: 'string', format: 'uuid' } as const;
const campaignId = { type: 'string', minLength: 1, maxLength: 128 } as const;

export async function analyticsRoutes(fastify: FastifyInstance, options: AnalyticsRouteOptions) {
  const need = (reply: FastifyReply): AnalyticsService | undefined => {
    if (!options.service) {
      void reply.code(503).send({ error: 'analytics_unavailable', message: 'gateway is not configured; analytics reviews are off' });
      return undefined;
    }
    return options.service;
  };

  fastify.get('/analytics/campaigns', { onRequest: [fastify.authenticate] }, async (request, reply) => {
    const service = need(reply);
    if (!service) return;
    return reply.send({ campaigns: await service.listCampaigns(request.user!.id) });
  });

  fastify.post<{
    Body: {
      goalId: string;
      probaCampaignId: string;
      platform: string;
      accountId?: string;
      providerCampaignId?: string;
      currentDailyBudget?: number;
      currency?: string;
      rules?: unknown;
    };
  }>(
    '/analytics/campaigns',
    {
      onRequest: [fastify.authenticate],
      schema: {
        body: {
          type: 'object',
          required: ['goalId', 'probaCampaignId', 'platform'],
          additionalProperties: false,
          properties: {
            goalId: uuid,
            probaCampaignId: campaignId,
            platform: { type: 'string', enum: ['reddit', 'microsoft', 'google', 'meta'] },
            accountId: { type: 'string', minLength: 1, maxLength: 128 },
            providerCampaignId: { type: 'string', minLength: 1, maxLength: 128 },
            currentDailyBudget: { type: 'number' },
            currency: { type: 'string', minLength: 3, maxLength: 3 },
            rules: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.code(201).send({ campaign: await service.registerCampaign(request.user!.id, request.body) });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.patch<{
    Params: { probaCampaignId: string };
    Body: { reviewEnabled?: boolean; currentDailyBudget?: number | null; rules?: unknown };
  }>(
    '/analytics/campaigns/:probaCampaignId',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { probaCampaignId: campaignId } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            reviewEnabled: { type: 'boolean' },
            currentDailyBudget: { type: ['number', 'null'] },
            rules: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send({
          campaign: await service.updateCampaign(request.user!.id, request.params.probaCampaignId, request.body),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.post<{
    Params: { probaCampaignId: string };
    Body: { intent?: 'report' | 'propose_pause' | 'propose_cap' | 'brain'; dailyBudget?: number };
  }>(
    '/analytics/campaigns/:probaCampaignId/review',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { probaCampaignId: campaignId } },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            intent: { type: 'string', enum: ['report', 'propose_pause', 'propose_cap', 'brain'] },
            dailyBudget: { type: 'number' },
          },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        if (request.body?.intent === 'brain') {
          const review = await service.runBrainReview(request.user!.id, request.params.probaCampaignId, { trigger: 'manual' });
          return reply.send({ review });
        }
        const intent = request.body?.intent;
        const review = await service.runReview(request.user!.id, request.params.probaCampaignId, {
          trigger: 'manual',
          intent: intent ?? 'report',
          ...(request.body?.dailyBudget !== undefined ? { dailyBudget: request.body.dailyBudget } : {}),
        });
        return reply.send({ review });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Wake the brain reviewer early on a pressing event (it still decides what, if anything, to change).
  fastify.post<{ Params: { probaCampaignId: string }; Body: { event: WakeEvent } }>(
    '/analytics/campaigns/:probaCampaignId/wake',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { probaCampaignId: campaignId } },
        body: {
          type: 'object',
          required: ['event'],
          additionalProperties: false,
          properties: { event: { type: 'string', enum: [...WAKE_EVENTS] } },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send({ campaign: await service.wake(request.user!.id, request.params.probaCampaignId, request.body.event) });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.get<{ Querystring: { probaCampaignId?: string } }>(
    '/analytics/reviews',
    {
      onRequest: [fastify.authenticate],
      schema: { querystring: { type: 'object', properties: { probaCampaignId: campaignId } } },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      return reply.send({ reviews: await service.listReviews(request.user!.id, request.query.probaCampaignId) });
    }
  );

  fastify.get<{ Querystring: { status?: string } }>(
    '/analytics/proposals',
    {
      onRequest: [fastify.authenticate],
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'approved', 'rejected', 'executed', 'failed', 'expired', 'superseded'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      return reply.send({ proposals: await service.listProposals(request.user!.id, request.query.status) });
    }
  );

  fastify.post<{ Params: { proposalId: string }; Body: { decision: 'approve' | 'reject' } }>(
    '/analytics/proposals/:proposalId/decision',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { proposalId: uuid } },
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: { decision: { type: 'string', enum: ['approve', 'reject'] } },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send({
          proposal: await service.decide(request.user!.id, request.params.proposalId, request.body.decision),
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Goal page: Now / Next / Spend vs cap / Progress / Recent decisions (audited numbers only; unknown is null).
  fastify.get<{ Params: { goalId: string } }>(
    '/goals/:goalId/status',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { goalId: uuid } } } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send(await service.goalStatus(request.user!.id, request.params.goalId));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Manual override: pause all platform campaigns under a single Proba goal.
  fastify.post<{ Params: { goalId: string } }>(
    '/goals/:goalId/pause',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { goalId: uuid } } } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send(await service.pauseGoalCampaigns(request.user!.id, request.params.goalId));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Manual override: cancel an entire goal (stops campaigns, pending proposals, and scheduled reviews while preserving history).
  fastify.post<{ Params: { goalId: string } }>(
    '/goals/:goalId/cancel',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { goalId: uuid } } } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send(await service.cancelGoal(request.user!.id, request.params.goalId));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Manual override: pause one specific platform campaign under a Proba goal.
  fastify.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/pause',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { campaignId: { type: 'string', minLength: 1 } } } } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send(await service.pauseSingleCampaign(request.user!.id, request.params.campaignId));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Operator-approved creative/targeting for Reddit post creation on a goal.
  fastify.get<{ Params: { goalId: string } }>(
    '/goals/:goalId/creative',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { goalId: uuid } } } },
    async (request, reply) => {
      const result = await pool.query(
        `SELECT approved_creative, approved_targeting, creative_approved_at FROM goals WHERE id = $1 AND user_id = $2`,
        [request.params.goalId, request.user!.id]
      );
      const row = result.rows[0];
      if (!row) return reply.code(404).send({ error: 'goal_not_found' });
      return reply.send({
        creative: row.approved_creative ?? null,
        targeting: row.approved_targeting ?? null,
        approvedAt: row.creative_approved_at ? new Date(row.creative_approved_at).toISOString() : null,
      });
    }
  );

  fastify.put<{ Params: { goalId: string }; Body: { creative: unknown; targeting?: unknown } }>(
    '/goals/:goalId/creative',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { goalId: uuid } },
        body: {
          type: 'object',
          required: ['creative'],
          additionalProperties: false,
          properties: { creative: { type: 'object' }, targeting: { type: 'object' } },
        },
      },
    },
    async (request, reply) => {
      const creative = parseApprovedCreative(request.body.creative);
      if (!creative.ok) return reply.code(400).send({ error: 'invalid_creative', message: creative.error });
      const targeting = parseApprovedTargeting(request.body.targeting);
      if (!targeting.ok) return reply.code(400).send({ error: 'invalid_targeting', message: targeting.error });
      const userId = request.user!.id;
      const saved = await transaction(async (client) => {
        const updated = await client.query(
          `UPDATE goals SET approved_creative = $3, approved_targeting = $4, creative_approved_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND user_id = $2 RETURNING id, thread_id, creative_approved_at`,
          [
            request.params.goalId,
            userId,
            JSON.stringify(creative.creative),
            targeting.targeting ? JSON.stringify(targeting.targeting) : null,
          ]
        );
        const row = updated.rows[0];
        if (!row) return undefined;
        await getAudit().emit(
          {
            action: 'goal.updated',
            outcome: 'success',
            userId,
            workspaceId: options.workspaceId,
            goalId: row.id,
            threadId: row.thread_id,
            target: { type: 'goal', id: row.id },
            details: {
              change: 'creative_approved',
              creativeType: creative.creative.type,
              headlineLength: creative.creative.headline.length,
              hasTargeting: Boolean(targeting.targeting),
            },
          },
          { tx: client }
        );
        return row;
      });
      if (!saved) return reply.code(404).send({ error: 'goal_not_found' });
      return reply.send({
        creative: creative.creative,
        targeting: targeting.targeting ?? null,
        approvedAt: new Date(saved.creative_approved_at).toISOString(),
      });
    }
  );
}
