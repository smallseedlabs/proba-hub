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

  // H3-05: Record a spend-gated paid action and query per-goal model/media costs.
  fastify.post<{
    Params: { goalId: string };
    Body: {
      actionType: string;
      estimatedCostUsd: number;
      justification: string;
      evidence: string;
    };
  }>(
    '/goals/:goalId/paid-actions',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { goalId: uuid } },
        body: {
          type: 'object',
          required: ['actionType', 'estimatedCostUsd', 'justification', 'evidence'],
          properties: {
            actionType: { type: 'string', minLength: 1, maxLength: 64 },
            estimatedCostUsd: { type: 'number', minimum: 0 },
            justification: { type: 'string', minLength: 1, maxLength: 64 },
            evidence: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { goalId } = request.params;
      const { actionType, estimatedCostUsd, justification, evidence } = request.body;
      const owned = await pool.query<{ id: string }>(
        'SELECT id FROM goals WHERE id = $1 AND user_id = $2',
        [goalId, userId]
      );
      if (owned.rows.length === 0) {
        return reply.code(404).send({ error: 'Goal not found' });
      }
      const inserted = await pool.query<{
        id: string;
        action_type: string;
        estimated_cost_usd: number;
        justification: string;
        evidence: string;
        created_at: string;
      }>(
        `INSERT INTO paid_actions
           (workspace_id, goal_id, user_id, action_type, estimated_cost_usd, justification, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, action_type, estimated_cost_usd, justification, evidence, created_at`,
        [options.workspaceId, goalId, userId, actionType, estimatedCostUsd, justification, evidence]
      );
      return reply.code(201).send({ paidAction: inserted.rows[0] });
    }
  );

  fastify.get<{ Params: { goalId: string } }>(
    '/goals/:goalId/costs',
    {
      onRequest: [fastify.authenticate],
      schema: { params: { type: 'object', properties: { goalId: uuid } } },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { goalId } = request.params;
      const sumRes = await pool.query<{ total_usd: string | number; count: string | number }>(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total_usd, COUNT(*)::int AS count
         FROM paid_actions
         WHERE goal_id = $1 AND user_id = $2`,
        [goalId, userId]
      );
      const actionsRes = await pool.query(
        `SELECT id, action_type, estimated_cost_usd, justification, evidence, created_at
         FROM paid_actions
         WHERE goal_id = $1 AND user_id = $2
         ORDER BY created_at DESC
         LIMIT 50`,
        [goalId, userId]
      );
      return reply.send({
        goalId,
        totalUsd: Number(sumRes.rows[0]?.total_usd ?? 0),
        count: Number(sumRes.rows[0]?.count ?? 0),
        actions: actionsRes.rows,
      });
    }
  );

  // Manual override: pause all live platform campaigns in the workspace (idempotent kill-switch).
  fastify.post(
    '/kill-switch',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      const userId = request.user!.id;
      try {
        const result = await service.emergencyPauseAll(userId);
        await getAudit().emit({
          action: 'control.emergency_stopped',
          outcome: result.failed === 0 ? 'success' : result.paused > 0 ? 'partial' : 'failure',
          userId,
          target: { type: 'execution_state', id: userId },
          tags: ['emergency_stop'],
          details: { scope: 'workspace', via: 'kill_switch', ...result },
        });
        return reply.send({ ok: result.failed === 0, ...result });
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

  // Manual override: cancel one specific platform campaign (pauses provider campaign, rejects its pending proposals, disables its reviews).
  fastify.post<{ Params: { campaignId: string } }>(
    '/campaigns/:campaignId/cancel',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { campaignId: { type: 'string', minLength: 1 } } } } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return reply.send(await service.cancelSingleCampaign(request.user!.id, request.params.campaignId));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  // Per-platform creative variants & v1 -> v2 enhancement / winner promotion
  fastify.get<{ Params: { goalId: string } }>(
    '/goals/:goalId/creatives',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { goalId: uuid } } } },
    async (request, reply) => {
      try {
        const rows = await pool.query(
          `SELECT id, goal_id as "goalId", platform, version, parent_variant_id as "parentVariantId",
                  proba_campaign_id as "probaCampaignId", provider_ad_id as "providerAdId",
                  status, mode, change_reason as "changeReason", creative_json as "creative",
                  targeting_json as "targeting", metrics_json as "metrics",
                  created_at as "createdAt", updated_at as "updatedAt"
           FROM goal_creative_variants
           WHERE goal_id = $1 AND user_id = $2
           ORDER BY platform ASC, version DESC`,
          [request.params.goalId, request.user!.id]
        );
        return reply.send({ variants: rows.rows });
      } catch {
        return reply.send({ variants: [] });
      }
    }
  );

  fastify.post<{
    Params: { goalId: string; variantId: string };
    Body: {
      mode: 'ab_test' | 'replace';
      headline?: string;
      body?: string;
      imageUrl?: string;
      videoUrl?: string;
      ctaType?: string;
      changeReason?: string;
    };
  }>(
    '/goals/:goalId/creatives/:variantId/enhance',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: { type: 'object', properties: { goalId: uuid, variantId: uuid } },
        body: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['ab_test', 'replace'] },
            headline: { type: 'string', maxLength: 300 },
            body: { type: 'string', maxLength: 5000 },
            imageUrl: { type: 'string', maxLength: 2048 },
            videoUrl: { type: 'string', maxLength: 2048 },
            ctaType: { type: 'string', maxLength: 64 },
            changeReason: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const result = await transaction(async (client) => {
        const parentRes = await client.query<{
          id: string;
          workspace_id: string;
          platform: string;
          version: number;
          proba_campaign_id: string | null;
          creative_json: Record<string, unknown>;
          targeting_json: Record<string, unknown> | null;
        }>(
          `SELECT id, workspace_id, platform, version, proba_campaign_id, creative_json, targeting_json
           FROM goal_creative_variants
           WHERE id = $1 AND goal_id = $2 AND user_id = $3`,
          [request.params.variantId, request.params.goalId, userId]
        );
        const parent = parentRes.rows[0];
        if (!parent) return undefined;

        const maxRes = await client.query<{ max_ver: number }>(
          `SELECT COALESCE(MAX(version), 0) as max_ver FROM goal_creative_variants WHERE goal_id = $1 AND platform = $2`,
          [request.params.goalId, parent.platform]
        );
        const nextVersion = Number(maxRes.rows[0]?.max_ver ?? parent.version) + 1;

        const nextCreative: Record<string, unknown> = {
          ...parent.creative_json,
          ...(request.body.headline !== undefined ? { headline: request.body.headline } : {}),
          ...(request.body.body !== undefined ? { body: request.body.body } : {}),
          ...(request.body.imageUrl !== undefined ? { imageUrl: request.body.imageUrl } : {}),
          ...(request.body.videoUrl !== undefined ? { videoUrl: request.body.videoUrl } : {}),
          ...(request.body.ctaType !== undefined ? { ctaType: request.body.ctaType } : {}),
        };
        if (nextCreative.imageUrl && nextCreative.type === 'TEXT') {
          nextCreative.type = 'IMAGE';
          nextCreative.mediaUrl = nextCreative.imageUrl;
        }

        const nextStatus = request.body.mode === 'ab_test' ? 'testing' : 'active';
        if (request.body.mode === 'replace') {
          await client.query(
            `UPDATE goal_creative_variants SET status = 'paused', updated_at = NOW()
             WHERE goal_id = $1 AND platform = $2 AND status IN ('active', 'testing', 'winner')`,
            [request.params.goalId, parent.platform]
          );
        }

        const inserted = await client.query(
          `INSERT INTO goal_creative_variants
             (workspace_id, user_id, goal_id, platform, version, parent_variant_id, proba_campaign_id, status, mode, change_reason, creative_json, targeting_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb)
           RETURNING id, goal_id as "goalId", platform, version, parent_variant_id as "parentVariantId",
                     proba_campaign_id as "probaCampaignId", provider_ad_id as "providerAdId",
                     status, mode, change_reason as "changeReason", creative_json as "creative",
                     targeting_json as "targeting", metrics_json as "metrics",
                     created_at as "createdAt", updated_at as "updatedAt"`,
          [
            parent.workspace_id,
            userId,
            request.params.goalId,
            parent.platform,
            nextVersion,
            parent.id,
            parent.proba_campaign_id,
            nextStatus,
            request.body.mode,
            request.body.changeReason ?? null,
            JSON.stringify(nextCreative),
            parent.targeting_json ? JSON.stringify(parent.targeting_json) : null,
          ]
        );

        await client.query(
          `UPDATE goals SET approved_creative = $3::jsonb, creative_approved_at = NOW(), updated_at = NOW()
           WHERE id = $1 AND user_id = $2`,
          [request.params.goalId, userId, JSON.stringify(nextCreative)]
        );

        return inserted.rows[0];
      });
      if (!result) return reply.code(404).send({ error: 'variant_not_found' });
      return reply.status(201).send({ variant: result });
    }
  );

  fastify.post<{ Params: { goalId: string; variantId: string } }>(
    '/goals/:goalId/creatives/:variantId/promote',
    { onRequest: [fastify.authenticate], schema: { params: { type: 'object', properties: { goalId: uuid, variantId: uuid } } } },
    async (request, reply) => {
      const userId = request.user!.id;
      const promoted = await transaction(async (client) => {
        const targetRes = await client.query<{ id: string; platform: string; creative_json: Record<string, unknown> }>(
          `SELECT id, platform, creative_json FROM goal_creative_variants WHERE id = $1 AND goal_id = $2 AND user_id = $3`,
          [request.params.variantId, request.params.goalId, userId]
        );
        const target = targetRes.rows[0];
        if (!target) return undefined;

        await client.query(
          `UPDATE goal_creative_variants SET status = 'paused', updated_at = NOW()
           WHERE goal_id = $1 AND platform = $2 AND id <> $3 AND status IN ('active', 'testing', 'winner')`,
          [request.params.goalId, target.platform, target.id]
        );
        const updated = await client.query(
          `UPDATE goal_creative_variants SET status = 'winner', updated_at = NOW()
           WHERE id = $1
           RETURNING id, goal_id as "goalId", platform, version, parent_variant_id as "parentVariantId",
                     proba_campaign_id as "probaCampaignId", provider_ad_id as "providerAdId",
                     status, mode, change_reason as "changeReason", creative_json as "creative",
                     targeting_json as "targeting", metrics_json as "metrics",
                     created_at as "createdAt", updated_at as "updatedAt"`,
          [target.id]
        );
        await client.query(
          `UPDATE goals SET approved_creative = $3::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $2`,
          [request.params.goalId, userId, JSON.stringify(target.creative_json)]
        );
        return updated.rows[0];
      });
      if (!promoted) return reply.code(404).send({ error: 'variant_not_found' });
      return reply.send({ variant: promoted });
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
