import type { FastifyInstance } from 'fastify';
import {
  commandEnvelopeSchema,
  validateCommandPayload,
  type CommandEnvelope,
} from '@smallseedlabs/proba-protocol';
import type { CommandProcessor } from '../services/command-processor.js';
import { logger } from '../logger.js';
import { pool } from '../db/client.js';
import type { CommandResult } from '../types.js';

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

      const validation = commandEnvelopeSchema.safeParse(body);
      if (!validation.success) {
        logger.warn({ error: validation.error }, 'Invalid command envelope');
        const invalidBody = body as { clientMsgId?: string };
        return reply.code(202).send({
          status: 'rejected',
          clientMsgId: invalidBody?.clientMsgId || 'unknown',
          reason: 'validation_error',
        });
      }

      const envelope = validation.data as CommandEnvelope;

      // The envelope schema types `payload` as unknown; validate it against the
      // per-command-type schema before it reaches the processor/DB.
      if (!validateCommandPayload(envelope.type, envelope.payload)) {
        logger.warn({ type: envelope.type, clientMsgId: envelope.clientMsgId }, 'Invalid command payload');
        return reply.code(202).send({
          status: 'rejected',
          clientMsgId: envelope.clientMsgId,
          reason: 'validation_error',
        });
      }

      if (envelope.threadId) {
        const threadCheck = await pool.query(
          'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
          [envelope.threadId, userId]
        );

        if (threadCheck.rows.length === 0) {
          return reply.code(202).send({
            status: 'rejected',
            clientMsgId: envelope.clientMsgId,
            reason: 'thread_not_found',
          });
        }
      } else if (envelope.type !== 'send_message' && envelope.type !== 'create_goal') {
        await pool.query(
          'INSERT INTO threads (user_id, status) VALUES ($1, $2) RETURNING id',
          [userId, 'active']
        );
      }

      // Each command runs in its own transaction, asynchronously after the 202.
      setImmediate(() => {
        processor.processCommand(userId, envelope).catch((error) => {
          logger.error(
            { error, userId, clientMsgId: envelope.clientMsgId },
            'Command processing failed in background'
          );
        });
      });

      reply.code(202).send({
        status: 'accepted',
        clientMsgId: envelope.clientMsgId,
      });
    }
  );
}
