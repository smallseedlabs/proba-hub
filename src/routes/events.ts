import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sseManager } from '../services/sse-manager.js';
import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

interface EventsQuery {
  after?: string;
}

interface PollingResponse {
  events: EventEnvelope[];
  nextSeq: number;
  hasMore: boolean;
}

export async function eventRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: EventsQuery }>(
    '/events',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const afterSeq = request.query.after ? parseInt(request.query.after, 10) : undefined;

      if (afterSeq !== undefined) {
        return handlePolling(userId, afterSeq, reply);
      }

      return handleSSE(userId, request, reply);
    }
  );
}

interface EventRow {
  seq: number;
  type: string;
  thread_id?: string;
  payload: unknown;
  created_at: Date;
  component?: string;
  version?: string;
  props?: unknown;
  actions?: unknown;
  fallback_text?: string;
}

async function handlePolling(
  userId: string,
  afterSeq: number,
  reply: FastifyReply
): Promise<void> {
  const limit = 50;

  const result = await pool.query(
    `SELECT e.id, e.user_id, e.seq, e.type, e.thread_id, e.payload,
            u.component, u.version, u.props, u.actions,
            e.fallback_text, e.created_at
     FROM events e
     LEFT JOIN ui_payloads u ON e.ui_payload_id = u.id
     WHERE e.user_id = $1 AND e.seq > $2
     ORDER BY e.seq ASC
     LIMIT $3`,
    [userId, afterSeq, limit + 1]
  );

  const hasMore = result.rows.length > limit;
  const events = result.rows.slice(0, limit);

  const envelopes: EventEnvelope[] = events.map((row: EventRow) => {
    return buildEventEnvelope(row);
  });

  const nextSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq;

  reply.send({
    events: envelopes,
    nextSeq,
    hasMore,
  } as PollingResponse);
}

async function handleSSE(
  userId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const lastEventId = request.headers['last-event-id'];
  const lastSeq = lastEventId ? parseInt(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId, 10) : 0;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const catchupResult = await pool.query(
    `SELECT e.id, e.user_id, e.seq, e.type, e.thread_id, e.payload,
            u.component, u.version, u.props, u.actions,
            e.fallback_text, e.created_at
     FROM events e
     LEFT JOIN ui_payloads u ON e.ui_payload_id = u.id
     WHERE e.user_id = $1 AND e.seq > $2
     ORDER BY e.seq ASC`,
    [userId, lastSeq]
  );

  for (const row of catchupResult.rows) {
    const envelope = buildEventEnvelope(row);
    sendSSEEvent(reply, envelope);
  }

  const connection = {
    userId,
    lastSeq: catchupResult.rows.length > 0 
      ? catchupResult.rows[catchupResult.rows.length - 1].seq 
      : lastSeq,
    send: (event: EventEnvelope) => {
      sendSSEEvent(reply, event);
    },
    close: () => {
      reply.raw.end();
    },
  };

  sseManager.addConnection(connection);

  const heartbeatInterval = setInterval(() => {
    if (!reply.raw.writable) {
      clearInterval(heartbeatInterval);
      sseManager.removeConnection(userId);
      return;
    }
    reply.raw.write(': heartbeat\n\n');
  }, config.sse.heartbeatIntervalMs);

  request.raw.on('close', () => {
    clearInterval(heartbeatInterval);
    sseManager.removeConnection(userId);
    logger.info({ userId }, 'SSE connection closed');
  });

  logger.info({ userId, lastSeq }, 'SSE connection established');
}

function buildEventEnvelope(row: EventRow): EventEnvelope {
  const envelope: EventEnvelope = {
    kind: 'event',
    seq: row.seq,
    type: row.type as EventEnvelope['type'],
    threadId: row.thread_id,
    payload: row.payload,
    at: row.created_at.toISOString(),
  };

  if (row.component && row.version && row.props) {
    const ui = {
      component: row.component,
      version: row.version,
      props: row.props,
    };
    if (row.actions) {
      Object.assign(ui, { actions: row.actions });
    }
    envelope.ui = ui as EventEnvelope['ui'];
  }

  if (row.fallback_text) {
    envelope.fallbackText = row.fallback_text;
  }

  return envelope;
}

function sendSSEEvent(reply: FastifyReply, event: EventEnvelope): void {
  const data = JSON.stringify(event);
  reply.raw.write(`id: ${event.seq}\n`);
  reply.raw.write(`event: ${event.type}\n`);
  reply.raw.write(`data: ${data}\n\n`);
}
