import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActAsAssertionClaims } from '@smallseedlabs/proba-protocol';
import {
  ACT_AS_HEADER,
  CONTEXT_READER_ROLE,
  CONTEXT_READER_ROUTES,
  TokenVerificationError,
  type ContextBridgeHubAuth,
  type ContextServiceToken,
} from '../auth/assertions/index.js';
import { getAudit } from '../audit/service.js';
import { currentTrace } from '../audit/trace.js';
import { authorizeActor, loadGoalState, loadThreadMessages } from '../services/internal-reads.js';
import { config } from '../config.js';

const scopeQuerySchema = z.object({
  actorId: z.string().min(1),
  workspaceId: z.string().min(1),
  goalId: z.string().uuid(),
});

const authorizeBodySchema = z.object({
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  goalId: z.string().uuid(),
});

export interface InternalRoutesOptions {
  auth: ContextBridgeHubAuth;
  /** Cap on messages page size (default from config). */
  messagesLimitCap?: number;
}

interface ContextReaderSession {
  assertion: ActAsAssertionClaims;
  service: ContextServiceToken;
}

declare module 'fastify' {
  interface FastifyRequest {
    contextReader?: ContextReaderSession;
  }
}

function routeKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions?.url ?? request.url.split('?')[0]}`;
}

/**
 * Internal read routes for the context bridge (`context-reader` only).
 * Not reachable with a user session token.
 */
export async function internalRoutes(fastify: FastifyInstance, options: InternalRoutesOptions) {
  const { auth } = options;
  const messagesCap = options.messagesLimitCap ?? config.contextBridge.messagesLimitCap;

  const deny = async (
    request: FastifyRequest,
    code: string,
    outcome: 'denied' | 'failure',
    extra: Record<string, unknown> = {},
    workspaceId?: string
  ) => {
    await getAudit().emit(
      {
        action: 'auth.denied',
        outcome,
        root: true,
        actor: { type: 'service', id: CONTEXT_READER_ROLE },
        ...(workspaceId ? { workspaceId } : {}),
        target: { type: 'route', id: `${request.method} ${routeKey(request)}` },
        errorCode: code,
        details: { caller: CONTEXT_READER_ROLE, verifier: 'context-service', ...extra },
      },
      { bestEffort: true }
    );
  };

  const auditRead = async (
    request: FastifyRequest,
    operation: string,
    details: Record<string, unknown>
  ) => {
    const session = request.contextReader!;
    await getAudit().emit({
      action: 'context.source_fetched',
      outcome: 'success',
      root: !currentTrace()?.spanId,
      actor: { type: 'service', id: CONTEXT_READER_ROLE },
      userId: session.assertion.sub,
      workspaceId: session.assertion.workspaceId,
      goalId: session.assertion.goalId,
      threadId: session.assertion.threadId,
      target: { type: 'route', id: `${request.method} ${routeKey(request)}` },
      details: {
        caller: CONTEXT_READER_ROLE,
        assertionJti: session.assertion.jti,
        tokenJti: session.service.jti,
        source: 'hub',
        operation,
        ...details,
      },
    });
  };

  fastify.addHook('preHandler', async (request, reply) => {
    if (!auth.contextReaderEnabled || !auth.service || !auth.assertions) {
      return reply.code(401).send({ error: 'invalid_token', message: 'Sign in to continue.', traceId: currentTrace()?.traceId });
    }

    const header = request.headers.authorization;
    if (!header || !/^Bearer\s+\S+$/i.test(header)) {
      await deny(request, 'missing_token', 'failure');
      return reply.code(401).send({ error: 'missing_token', message: 'Sign in to continue.', traceId: currentTrace()?.traceId });
    }
    const presented = header.replace(/^Bearer\s+/i, '');
    if (!auth.service.claimsToBeBridge(presented)) {
      await deny(request, 'invalid_token', 'failure');
      return reply.code(401).send({ error: 'invalid_token', message: 'Sign in to continue.', traceId: currentTrace()?.traceId });
    }

    let service: ContextServiceToken;
    try {
      service = await auth.service.verify(presented);
    } catch (err) {
      if (err instanceof TokenVerificationError) {
        await deny(request, err.code, 'failure', { tokenError: err.code });
        return reply
          .code(401)
          .send({ error: err.code, message: 'Your sign-in could not be verified. Sign in again.', traceId: currentTrace()?.traceId });
      }
      throw err;
    }

    const refuse = async (
      status: number,
      code: string,
      message: string,
      extra: Record<string, unknown> = {},
      workspaceId?: string
    ): Promise<FastifyReply> => {
      await deny(request, code, 'denied', { tokenJti: service.jti, ...extra }, workspaceId);
      return reply.code(status).send({ error: code, message, traceId: currentTrace()?.traceId });
    };

    // Only the three routes registered on this plugin are allow-listed. A bridge
    // token presented elsewhere is refused by the session authenticator (401).
    const key = routeKey(request);
    if (!CONTEXT_READER_ROUTES.has(key)) {
      return refuse(403, 'insufficient_role', 'This role cannot use this route.');
    }

    const assertionHeader = request.headers[ACT_AS_HEADER];
    if (typeof assertionHeader !== 'string' || assertionHeader.trim() === '') {
      return refuse(400, 'act_as_required', 'The X-Act-As assertion is required.');
    }

    let assertion: ActAsAssertionClaims;
    try {
      assertion = await auth.assertions.verify(assertionHeader.trim());
    } catch (err) {
      if (err instanceof TokenVerificationError) {
        return refuse(
          403,
          err.code === 'token_expired' ? 'act_as_expired' : 'act_as_invalid',
          'The X-Act-As assertion is not valid.'
        );
      }
      throw err;
    }

    const withAssertion = { assertionJti: assertion.jti };
    const isAuthorize = request.method === 'POST' && key.endsWith('/authorize');
    if (isAuthorize) {
      const body = authorizeBodySchema.safeParse(request.body);
      if (!body.success) {
        return refuse(400, 'act_as_scope_required', 'userId, workspaceId and goalId are required.', withAssertion, assertion.workspaceId);
      }
      if (
        body.data.userId !== assertion.sub ||
        body.data.workspaceId !== assertion.workspaceId ||
        body.data.goalId !== assertion.goalId
      ) {
        return refuse(
          403,
          'act_as_mismatch',
          'userId, workspaceId and goalId must match the X-Act-As assertion.',
          withAssertion,
          assertion.workspaceId
        );
      }
    } else {
      const params = scopeQuerySchema.safeParse(request.query);
      if (!params.success) {
        return refuse(
          400,
          'act_as_scope_required',
          'actorId, workspaceId and goalId are required query parameters.',
          withAssertion,
          assertion.workspaceId
        );
      }
      if (
        params.data.actorId !== assertion.sub ||
        params.data.workspaceId !== assertion.workspaceId ||
        params.data.goalId !== assertion.goalId
      ) {
        return refuse(
          403,
          'act_as_mismatch',
          'actorId, workspaceId and goalId must match the X-Act-As assertion.',
          withAssertion,
          assertion.workspaceId
        );
      }
      const goalParam = (request.params as { goalId?: string }).goalId;
      if (goalParam && goalParam !== assertion.goalId) {
        return refuse(403, 'act_as_mismatch', 'goalId must match the X-Act-As assertion.', withAssertion, assertion.workspaceId);
      }
    }

    request.contextReader = { assertion, service };
  });

  fastify.get<{
    Params: { goalId: string };
    Querystring: { actorId?: string; workspaceId?: string; goalId?: string };
  }>('/goals/:goalId/state', async (request, reply) => {
    const session = request.contextReader!;
    const state = await loadGoalState({
      goalId: request.params.goalId,
      userId: session.assertion.sub,
      workspaceId: session.assertion.workspaceId,
    });
    if (!state) {
      await auditRead(request, 'goal_state', { counts: { found: 0 } });
      return reply.code(404).send({ error: 'goal_not_found', message: 'Goal not found.', traceId: currentTrace()?.traceId });
    }
    await auditRead(request, 'goal_state', {
      counts: {
        found: 1,
        approvals: state.approvals.length,
        declines: state.declines.length,
        campaignIds: state.campaignIds.length,
      },
    });
    return reply.send(state);
  });

  fastify.get<{
    Params: { threadId: string };
    Querystring: { actorId?: string; workspaceId?: string; goalId?: string; cursor?: string; limit?: string };
  }>('/threads/:threadId/messages', async (request, reply) => {
    const session = request.contextReader!;
    const rawLimit = parseInt(request.query.limit ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, messagesCap) : Math.min(50, messagesCap);
    const page = await loadThreadMessages({
      threadId: request.params.threadId,
      userId: session.assertion.sub,
      workspaceId: session.assertion.workspaceId,
      goalId: session.assertion.goalId,
      cursor: request.query.cursor,
      limit,
    });
    if (!page) {
      await auditRead(request, 'thread_messages', { counts: { found: 0 } });
      return reply.code(404).send({ error: 'thread_not_found', message: 'Thread not found.', traceId: currentTrace()?.traceId });
    }
    await auditRead(request, 'thread_messages', { counts: { messages: page.messages.length } });
    return reply.send(page);
  });

  fastify.post<{ Body: { userId?: string; workspaceId?: string; goalId?: string } }>(
    '/authorize',
    async (request, reply) => {
      const body = authorizeBodySchema.parse(request.body);
      const result = await authorizeActor({
        userId: body.userId,
        workspaceId: body.workspaceId,
        goalId: body.goalId,
      });
      await auditRead(request, 'authorize', {
        counts: { allowed: result.allowed ? 1 : 0 },
        reason: result.reason,
      });
      return reply.send(result);
    }
  );
}
