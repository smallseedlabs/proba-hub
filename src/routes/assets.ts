import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AssetService } from '../assets/service.js';
import { config } from '../config.js';

const createAssetSchema = z.object({
  goalId: z.string().uuid().optional(),
  kind: z.enum(['image', 'video']),
  url: z.string().url().max(2048),
  mimeType: z.string().max(120).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  aspectRatio: z.string().max(16).optional(),
  provider: z.string().min(1).max(64).default('manual'),
  model: z.string().max(128).optional(),
  prompt: z.string().max(2000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listQuerySchema = z.object({
  goalId: z.string().uuid().optional(),
  kind: z.enum(['image', 'video']).optional(),
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
      const assets = await service.list({
        workspaceId,
        userId: request.user!.id,
        ...parsed.data,
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
