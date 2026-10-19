import type { FastifyInstance } from 'fastify';
import { commandEnvelopeSchema, isCommandEnvelope } from '@smallseedlabs/proba-protocol';
import { CommandProcessor } from '../services/command-processor.js';
import { MockBrain } from '../brain/mock-brain.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db/client.js';
import type { CommandResult } from '../types.js';

const brain = new MockBrain(config.brain.scenario);
const processor = new CommandProcessor(brain);

export async function commandRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: unknown; Reply: CommandResult }>(
    '/commands',
    {
      onRequest: [(fastify as any).authenticate],
    },
    async (request, reply) => {
      const body = request.body;

      const validation = commandEnvelopeSchema.safeParse(body);
      if (!validation.success) {
        logger.warn({ error: validation.error }, 'Invalid command envelope');
        return reply.code(202).send({
          status: 'rejected',
          clientMsgId: (body as any)?.clientMsgId || 'unknown',
          reason: 'validation_error',
        });
      }

      if (!isCommandEnvelope(body)) {
        return reply.code(202).send({
          status: 'rejected',
          clientMsgId: (body as any)?.clientMsgId || 'unknown',
          reason: 'invalid_envelope',
        });
      }

      const envelope = body;

      if (envelope.threadId) {
        const threadCheck = await pool.query(
          'SELECT id FROM threads WHERE id = $1 AND user_id = $2',
          [envelope.threadId, request.user!.id]
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
          [request.user!.id, 'active']
        );
      }

      setImmediate(async () => {
        try {
          await processor.processCommand(request.user!.id, envelope);
        } catch (error) {
          logger.error(
            { error, userId: request.user!.id, clientMsgId: envelope.clientMsgId },
            'Command processing failed'
          );
        }
      });

      reply.code(202).send({
        status: 'accepted',
        clientMsgId: envelope.clientMsgId,
      });
    }
  );
}
