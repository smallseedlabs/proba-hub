import type { FastifyInstance, FastifyReply } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { TokenVerificationError } from '../auth/assertions/errors.js';
import { ConnectionError, type ConnectionsService } from '../connections/service.js';
import { CONNECTION_PROVIDERS, isConnectionProvider, PROVIDER_DISPLAY_NAMES, type ConnectionProviderId } from '../connections/provider.js';
import type { AdsServiceTokenVerifier } from '../connections/service-token.js';

export interface ConnectionRoutesOptions {
  /** Null when connections are off (no HUB_CONNECTIONS_KEY_FILE): reads list providers as unavailable. */
  service: ConnectionsService | null;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ConnectionError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  throw error;
}

const providerParams = {
  type: 'object',
  required: ['provider'],
  properties: { provider: { type: 'string', enum: [...CONNECTION_PROVIDERS] } },
} as const;

/** Owner routes for the web Marketing section (session-authenticated). */
export async function connectionRoutes(fastify: FastifyInstance, options: ConnectionRoutesOptions) {
  const need = (reply: FastifyReply): ConnectionsService | undefined => {
    if (!options.service) {
      void reply.code(503).send({ error: 'connections_unavailable', message: 'Platform connections are not set up on this Hub' });
      return undefined;
    }
    return options.service;
  };

  fastify.get('/connections', { onRequest: [fastify.authenticate] }, async (request) => {
    if (!options.service) {
      return {
        enabled: false,
        connections: CONNECTION_PROVIDERS.map((provider) => ({
          provider,
          displayName: PROVIDER_DISPLAY_NAMES[provider],
          available: false,
          status: 'not_connected',
        })),
      };
    }
    return { enabled: true, workspaceId: options.service.workspaceId, connections: await options.service.list(request.user!.id) };
  });

  fastify.post<{ Params: { provider: ConnectionProviderId } }>(
    '/connections/:provider/start',
    { onRequest: [fastify.authenticate], schema: { params: providerParams } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return await service.start(request.user!.id, request.params.provider);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { provider: ConnectionProviderId }; Body: { state: string; code?: string; error?: string } }>(
    '/connections/:provider/callback',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: providerParams,
        body: {
          type: 'object',
          required: ['state'],
          additionalProperties: false,
          properties: {
            state: { type: 'string', minLength: 16, maxLength: 256 },
            code: { type: 'string', minLength: 1, maxLength: 2048 },
            error: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return { connection: await service.complete(request.user!.id, request.params.provider, request.body) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.put<{ Params: { provider: ConnectionProviderId }; Body: { accountId: string } }>(
    '/connections/:provider/account',
    {
      onRequest: [fastify.authenticate],
      schema: {
        params: providerParams,
        body: {
          type: 'object',
          required: ['accountId'],
          additionalProperties: false,
          properties: { accountId: { type: 'string', minLength: 1, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return { connection: await service.selectAccount(request.user!.id, request.params.provider, request.body.accountId) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { provider: ConnectionProviderId } }>(
    '/connections/:provider',
    { onRequest: [fastify.authenticate], schema: { params: providerParams } },
    async (request, reply) => {
      const service = need(reply);
      if (!service) return;
      try {
        return { connection: await service.disconnect(request.user!.id, request.params.provider) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
}

const accessTokenBody = z
  .object({
    workspaceId: z.string().min(1).max(256),
    purpose: z.enum(['mutate', 'metrics', 'preflight', 'billing']),
    userId: z.uuid().optional(),
    initiatedBy: z.enum(['user', 'policy', 'system']).optional(),
    traceId: z.string().min(1).max(128).optional(),
  })
  .strict();

export interface BrokerRoutesOptions {
  service: ConnectionsService;
  verifier: AdsServiceTokenVerifier;
}

/**
 * Internal broker route for the Ads service (not reachable with a user session).
 * Returns a short-lived provider access token plus the connection id and account the
 * caller must attribute its actions to. Never cached by intermediaries.
 */
export async function brokerRoutes(fastify: FastifyInstance, options: BrokerRoutesOptions) {
  await fastify.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: 60_000,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: 'Too many requests. Try again shortly.',
      retryAfter: context.after,
    }),
  });

  fastify.post<{ Params: { provider: string } }>('/connections/:provider/access-token', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    let caller;
    try {
      caller = await options.verifier.verify(token);
    } catch (error) {
      if (error instanceof TokenVerificationError) return reply.code(401).send({ error: error.code, message: 'service token rejected' });
      throw error;
    }
    if (!isConnectionProvider(request.params.provider)) return reply.code(404).send({ error: 'unknown_provider', message: 'unknown provider' });
    const parsed = accessTokenBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'invalid body' });
    if (parsed.data.workspaceId !== caller.workspaceId) {
      return reply.code(403).send({ error: 'workspace_mismatch', message: 'token and body name different workspaces' });
    }
    try {
      return await options.service.issueAccessToken({ ...parsed.data, provider: request.params.provider });
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
