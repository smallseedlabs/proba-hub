import type { FastifyInstance } from 'fastify';
import {
  commandEnvelopeSchema,
  validateCommandPayload,
  type CommandEnvelope,
} from '@smallseedlabs/proba-protocol';
import type { CommandProcessor } from '../services/command-processor.js';
import { logger } from '../logger.js';
import { pool, transaction } from '../db/client.js';
import type { CommandResult } from '../types.js';
import { getAudit } from '../audit/service.js';
import { TRACE_HEADER, bindTraceId, currentTrace } from '../audit/trace.js';
import type { PoolClient } from 'pg';

export interface CommandRoutesOptions {
  processor: CommandProcessor;
}

export async function commandRoutes(fastify: FastifyInstance, opts: CommandRoutesOptions) {
  const { processor } = opts;

  fastify.post<{ Body: unknown; Reply: CommandResult }>(
    '/commands',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = request.body;
      const userId = request.user!.id;
      const audit = getAudit();

      // Root the trace in the client's message id (a UUID in the protocol) before
      // anything else is logged or audited; the same id then ties together the
      // command, the brain call, its events and the SSE delivery.
      const rawClientMsgId = (body as { clientMsgId?: unknown } | null)?.clientMsgId;
      bindTraceId(rawClientMsgId);
      const traceId = currentTrace()?.traceId;
      if (traceId) reply.header(TRACE_HEADER, traceId);

      const commandType = (body as { type?: unknown } | null)?.type;
      const baseDetails = {
        commandType: typeof commandType === 'string' ? commandType.slice(0, 64) : null,
      };

      /** command.received (the request's root event) + the outcome events, in one transaction. */
      const reject = async (
        reason: 'validation_error' | 'thread_not_found',
        details: Record<string, unknown>,
        threadId?: string
      ) => {
        await transaction(async (client) => {
          const received = await audit.emit(
            { action: 'command.received', outcome: 'success', root: true, userId, details: baseDetails },
            { tx: client }
          );
          const parentSpanId = received?.spanId;
          if (reason === 'thread_not_found') {
            // The thread exists for someone else or not at all: an ownership check failed.
            await audit.emit(
              {
                action: 'policy.denied',
                outcome: 'denied',
                userId,
                target: { type: 'thread', id: threadId ?? 'unknown' },
                errorCode: reason,
                riskLevel: 'medium',
                parentSpanId,
                details: { policy: 'thread_ownership' },
              },
              { tx: client }
            );
          }
          await audit.emit(
            {
              action: 'command.rejected',
              outcome: reason === 'thread_not_found' ? 'denied' : 'failure',
              userId,
              errorCode: reason,
              parentSpanId,
              details: { ...baseDetails, reason, ...details },
            },
            { tx: client }
          );
        });
        return reply.code(202).send({
          status: 'rejected',
          clientMsgId: typeof rawClientMsgId === 'string' && rawClientMsgId ? rawClientMsgId : 'unknown',
          reason,
        });
      };

      const validation = commandEnvelopeSchema.safeParse(body);
      if (!validation.success) {
        logger.warn({ error: validation.error }, 'Invalid command envelope');
        // Only paths and codes: zod messages can quote the offending value.
        const issues = validation.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), code: i.code }));
        await reject('validation_error', { stage: 'envelope', issues });
        return reply;
      }

      let envelope = validation.data as CommandEnvelope;

      // The envelope schema types `payload` as unknown; validate it against the
      // per-command-type schema before it reaches the processor/DB.
      if (!validateCommandPayload(envelope.type, envelope.payload)) {
        logger.warn({ type: envelope.type, clientMsgId: envelope.clientMsgId }, 'Invalid command payload');
        await reject('validation_error', { stage: 'payload' }, envelope.threadId);
        return reply;
      }

      if (envelope.threadId) {
        const threadCheck = await pool.query(
          'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
          [envelope.threadId, userId]
        );

        if (threadCheck.rows.length === 0) {
          await reject('thread_not_found', { stage: 'thread' }, envelope.threadId);
          return reply;
        }
      }

      // Accept: the new thread (if any), command.received and command.accepted
      // commit together. The command itself is processed after the 202.
      envelope = await transaction(async (client: PoolClient) => {
        let accepted = envelope;
        let newThread = false;
        if (!envelope.threadId) {
          if (envelope.type === 'send_message' || envelope.type === 'create_goal') {
            // A new conversation: give it its own thread so the brain state, goal
            // and messages have somewhere to live (threads.id is NOT NULL for them).
            const title =
              envelope.type === 'create_goal'
                ? (envelope.payload as { title?: string }).title
                : (envelope.payload as { text?: string }).text;
            const created = await client.query<{ id: string }>(
              'INSERT INTO threads (user_id, status, title) VALUES ($1, $2, $3) RETURNING id',
              [userId, 'active', title ? title.slice(0, 500) : null]
            );
            accepted = { ...envelope, threadId: created.rows[0].id };
            newThread = true;
          } else {
            await client.query('INSERT INTO threads (user_id, status) VALUES ($1, $2) RETURNING id', [
              userId,
              'active',
            ]);
          }
        }
        const received = await audit.emit(
          {
            action: 'command.received',
            outcome: 'success',
            root: true,
            userId,
            threadId: accepted.threadId,
            details: baseDetails,
          },
          { tx: client }
        );
        await audit.emit(
          {
            action: 'command.accepted',
            outcome: 'success',
            userId,
            threadId: accepted.threadId,
            target: accepted.threadId ? { type: 'thread', id: accepted.threadId } : undefined,
            parentSpanId: received?.spanId,
            details: { ...baseDetails, newThread },
          },
          { tx: client }
        );
        return accepted;
      });

      // Each command runs in its own transaction, asynchronously after the 202.
      // setImmediate keeps the request's async context, so the processor audits
      // under the same traceId.
      setImmediate(() => {
        processor.processCommand(userId, envelope).catch((error) => {
          logger.error(
            { error, userId, clientMsgId: envelope.clientMsgId },
            'Command processing failed in background'
          );
          void processor.auditProcessingFailure(userId, envelope, error);
        });
      });

      reply.code(202).send({
        status: 'accepted',
        clientMsgId: envelope.clientMsgId,
      });
    }
  );
}
