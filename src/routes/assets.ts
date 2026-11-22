import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssetService } from '../assets/service.js';
import { config } from '../config.js';
import { pool } from '../db/client.js';

const createAssetSchema = z.object({
  id: z.string().min(4).max(128).optional(),
  goalId: z.string().uuid().optional(),
  kind: z.enum(['image', 'video']),
  url: z.string().url().max(2048),
  sourceUrl: z.string().url().max(2048).optional(),
  mimeType: z.string().max(120).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  aspectRatio: z.string().max(16).optional(),
  provider: z.string().min(1).max(64).default('manual'),
  model: z.string().max(128).optional(),
  prompt: z.string().max(2000).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(64)).max(24).optional(),
  visualStyle: z.string().max(120).optional(),
  brandElements: z.array(z.string().min(1).max(120)).max(12).optional(),
  useCases: z.array(z.string().min(1).max(64)).max(12).optional(),
  curationStatus: z.enum(['approved', 'candidate', 'do_not_use']).optional(),
  parentAssetId: z.string().max(128).optional(),
  dedupeByPrompt: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const patchAssetSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string().min(1).max(64)).max(24).optional(),
  visualStyle: z.string().max(120).optional(),
  brandElements: z.array(z.string().min(1).max(120)).max(12).optional(),
  useCases: z.array(z.string().min(1).max(64)).max(12).optional(),
  curationStatus: z.enum(['approved', 'candidate', 'do_not_use']).optional(),
});

const listQuerySchema = z.object({
  goalId: z.string().uuid().optional(),
  kind: z.enum(['image', 'video']).optional(),
  curationStatus: z.enum(['approved', 'candidate', 'do_not_use']).optional(),
  excludeDoNotUse: z.coerce.boolean().optional(),
  tag: z.string().max(64).optional(),
  useCase: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export interface AssetRoutesOptions {
  service?: AssetService;
  workspaceId?: string;
}

export async function assetRoutes(fastify: FastifyInstance, options: AssetRoutesOptions = {}) {
  const service = options.service ?? new AssetService();
  const workspaceId = options.workspaceId ?? config.audit.workspaceId;

  fastify.get(
    '/assets',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', message: parsed.error.issues[0]?.message });
      }
      const { q, ...rest } = parsed.data;
      const assets = await service.list({
        workspaceId,
        userId: request.user!.id,
        ...rest,
        ...(q ? { query: q } : {}),
      });
      return { assets };
    }
  );

  fastify.post(
    '/assets',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = createAssetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', message: parsed.error.issues[0]?.message });
      }
      const asset = await service.create({
        workspaceId,
        userId: request.user!.id,
        ...parsed.data,
      });
      return reply.code(201).send({ asset });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/assets/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const asset = await service.get(request.params.id, workspaceId, request.user!.id);
      if (!asset) return reply.code(404).send({ error: 'not_found' });
      return { asset };
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    '/assets/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = patchAssetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', message: parsed.error.issues[0]?.message });
      }
      const asset = await service.update(request.params.id, workspaceId, request.user!.id, parsed.data);
      if (!asset) return reply.code(404).send({ error: 'not_found' });
      return { asset };
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/assets/:id',
    { onRequest: [fastify.authenticate] },
    async (request, reply) => {
      const deleted = await service.remove(request.params.id, workspaceId, request.user!.id);
      if (!deleted) return reply.code(404).send({ error: 'not_found' });
      return { deleted: true };
    }
  );
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface InternalAssetRoutesOptions {
  service?: AssetService;
  internalToken?: string;
}

export async function internalAssetRoutes(fastify: FastifyInstance, options: InternalAssetRoutesOptions = {}) {
  const service = options.service ?? new AssetService();
  const expectedToken = (options.internalToken ?? process.env.HUB_INTERNAL_ASSET_TOKEN ?? '').trim();

  const authorizeInternal = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!expectedToken) {
      return reply.code(503).send({ error: 'internal_assets_unconfigured' });
    }
    const authHeader = request.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token || !tokenMatches(token, expectedToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  fastify.get(
    '/assets',
    { onRequest: [authorizeInternal] },
    async (request, reply) => {
      const schema = listQuerySchema.extend({
        workspaceId: z.string().min(1),
        userId: z.string().min(1),
      });
      const parsed = schema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', message: parsed.error.issues[0]?.message });
      }
      const { q, ...rest } = parsed.data;
      const assets = await service.list({
        excludeDoNotUse: true,
        ...rest,
        ...(q ? { query: q } : {}),
      });
      return { assets };
    }
  );

  fastify.post(
    '/assets',
    { onRequest: [authorizeInternal] },
    async (request, reply) => {
      const schema = createAssetSchema.extend({
        workspaceId: z.string().min(1),
        userId: z.string().min(1),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', message: parsed.error.issues[0]?.message });
      }
      const asset = await service.create(parsed.data);
      return reply.code(201).send({ asset });
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/assets/:id/use',
    { onRequest: [authorizeInternal] },
    async (request, reply) => {
      const schema = z.object({ workspaceId: z.string().min(1), userId: z.string().min(1) });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body' });
      }
      await service.markUsed(request.params.id, parsed.data.workspaceId, parsed.data.userId);
      return { ok: true };
    }
  );

  fastify.post(
    '/paid-actions',
    { onRequest: [authorizeInternal] },
    async (request, reply) => {
      const schema = z.object({
        goalId: z.string().uuid(),
        userId: z.string().uuid(),
        actionType: z.enum(['media_generate', 'research_paid', 'llm_call']),
        estimatedCostUsd: z.number().nonnegative(),
        justification: z.enum([
          'no_usable_site_image',
          'format_mismatch',
          'existing_asset_rejected_quality',
          'user_requested',
        ]),
        evidence: z.string().min(1).max(2000),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', message: parsed.error.issues[0]?.message });
      }
      const { goalId, userId, actionType, estimatedCostUsd, justification, evidence } = parsed.data;
      const inserted = await pool.query(
        `INSERT INTO paid_actions (goal_id, user_id, action_type, estimated_cost_usd, justification, evidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, goal_id, action_type, estimated_cost_usd, justification, created_at`,
        [goalId, userId, actionType, estimatedCostUsd, justification, evidence]
      );
      return reply.code(201).send({ ok: true, action: inserted.rows[0] });
    }
  );
}
