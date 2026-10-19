import type { FastifyInstance } from 'fastify';
import { commandEnvelopeSchema, type CommandEnvelope } from '@smallseedlabs/proba-protocol';
import { CommandProcessor } from '../services/command-processor.js';
import { MockBrain } from '../brain/mock-brain.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db/client.js';
import type { CommandResult } from '../types.js';

// Lazy-load brain to allow tests to change scenario via env var
// Cache processor per scenario to allow test isolation
// Read env var directly since config is cached at import time
let processorCache: Map<string, CommandProcessor> = new Map();

function getProcessor(): CommandProcessor {
  const scenario = process.env.MOCK_BRAIN_SCENARIO || 'happy_path';
  let processor = processorCache.get(scenario);
  
  if (!processor) {
    const brain = new MockBrain(scenario);
    processor = new CommandProcessor(brain);
    processorCache.set(scenario, processor);
  }
  
  return processor;
}

export async function commandRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: unknown; Reply: CommandResult }>(
    '/commands',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const body = request.body;

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
          await getProcessor().processCommand(request.user!.id, envelope);
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
