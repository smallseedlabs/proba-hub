import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAudit } from '../audit/service.js';
import { currentTrace, runWithTrace } from '../audit/trace.js';
import { sseManager } from '../services/sse-manager.js';
import { buildEventEnvelope, EVENT_SELECT, type EventRow } from '../services/event-envelope.js';
import type { SSEConnection } from '../types.js';
import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

interface EventsQuery {
  after?: string;
  token?: string;
}

interface PollingResponse {
  events: EventEnvelope[];
  nextSeq: number;
  hasMore: boolean;
}

export interface EventRoutesOptions {
  heartbeatIntervalMs?: number;
}

const POLL_LIMIT = 50;
const REPLAY_BATCH = 500;

function parseSeq(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return NaN;
  return parseInt(raw.trim(), 10);
}

async function fetchEvents(userId: string, afterSeq: number, limit: number, upToSeq?: number): Promise<EventRow[]> {
  const params: unknown[] = [userId, afterSeq, limit];
  let bound = '';
  if (upToSeq !== undefined) {
    params.push(upToSeq);
    bound = 'AND e.seq <= $4';
  }
  const result = await pool.query<EventRow>(
    `${EVENT_SELECT}
     WHERE e.user_id = $1 AND e.seq > $2 ${bound}
     ORDER BY e.seq ASC
     LIMIT $3`,
    params
  );
  return result.rows;
}

export async function eventRoutes(fastify: FastifyInstance, opts: EventRoutesOptions) {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? config.sse.heartbeatIntervalMs;

  // Connections opened through this app instance; ended on close so that
  // fastify.close() does not hang on long-lived streams.
  const openStreams = new Set<() => void>();
  fastify.addHook('preClose', async () => {
    for (const end of [...openStreams]) end();
  });

  fastify.get<{ Querystring: EventsQuery }>(
    '/events',
    {
      onRequest: [fastify.authenticate],
    },
    async (request, reply) => {
      const userId = request.user!.id;

      if (request.query.after !== undefined) {
        const afterSeq = parseSeq(request.query.after);
        if (afterSeq === null || Number.isNaN(afterSeq)) {
          return reply.code(400).send({ error: 'invalid_after' });
        }
        return handlePolling(userId, afterSeq, reply);
      }

      const lastEventId = parseSeq(request.headers['last-event-id']);
      if (Number.isNaN(lastEventId)) {
        return reply.code(400).send({ error: 'invalid_last_event_id' });
      }

      handleSSE(userId, lastEventId ?? 0, request, reply, heartbeatIntervalMs, openStreams);
    }
  );
}

async function handlePolling(
  userId: string,
  afterSeq: number,
  reply: FastifyReply
): Promise<void> {
  const rows = await fetchEvents(userId, afterSeq, POLL_LIMIT + 1);

  const hasMore = rows.length > POLL_LIMIT;
  const events = rows.slice(0, POLL_LIMIT);
  const envelopes = events.map(buildEventEnvelope);
  const nextSeq = events.length > 0 ? events[events.length - 1].seq : afterSeq;

  reply.send({
    events: envelopes,
    nextSeq,
    hasMore,
  } as PollingResponse);
}

/**
 * SSE delivery with exactly-once, in-order semantics per connection:
 *
 * 1. Register the live listener BEFORE reading the replay, so events
 *    committed while the replay query runs are not lost.
 * 2. All writes go through a per-connection serial queue; the replay runs
 *    first and live events queue behind it.
 * 3. Each write is filtered by `lastSeq`: seq <= lastSeq is a duplicate
 *    (already replayed / re-published) and is dropped; seq > lastSeq + 1
 *    means we missed something (out-of-order publish, Redis hiccup), so the
 *    gap is filled from Postgres, which is the source of truth.
 */
function handleSSE(
  userId: string,
  initialSeq: number,
  request: FastifyRequest,
  reply: FastifyReply,
  heartbeatIntervalMs: number,
  openStreams: Set<() => void>
): void {
  reply.hijack();
  const res = reply.raw;
  const openedAt = Date.now();
  // Socket 'close' callbacks run outside the request's async context, so keep the
  // trace to stamp the disconnect event with the same traceId as the connect.
  const trace = currentTrace();

  let lastSeq = initialSeq;
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  const write = (chunk: string) => {
    if (closed || res.destroyed || res.writableEnded) return;
    res.write(chunk);
  };

  const writeEvent = (event: EventEnvelope) => {
    if (event.seq <= lastSeq) return; // duplicate
    lastSeq = event.seq;
    write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(async () => {
      if (closed) return;
      try {
        await task();
      } catch (err) {
        logger.error({ err, userId }, 'SSE delivery error; closing stream so the client resumes');
        cleanup();
      }
    });
  };

  const replayFrom = async (upToSeq?: number) => {
    for (;;) {
      const rows = await fetchEvents(userId, lastSeq, REPLAY_BATCH, upToSeq);
      for (const row of rows) writeEvent(buildEventEnvelope(row));
      if (rows.length < REPLAY_BATCH) return;
    }
  };

  const connection: SSEConnection = {
    userId,
    send: (event: EventEnvelope) => {
      enqueue(async () => {
        if (event.seq <= lastSeq) return;
        if (event.seq > lastSeq + 1) {
          await replayFrom(event.seq);
        }
        writeEvent(event);
      });
    },
    close: () => cleanup(),
  };

  let heartbeat: NodeJS.Timeout | null = null;

  function cleanup() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    sseManager.removeConnection(connection);
    openStreams.delete(cleanup);
    if (!res.writableEnded) res.end();
    const log = () => logger.info({ userId, lastSeq }, 'SSE connection closed');
    if (trace) {
      runWithTrace(trace, () => {
        log();
        void getAudit().emit(
          {
            action: 'data_access.read',
            outcome: 'success',
            userId,
            target: { type: 'event_stream', id: userId },
            riskLevel: 'low',
            durationMs: Date.now() - openedAt,
            tags: ['sse'],
            details: { phase: 'disconnect', lastSeq },
          },
          { bestEffort: true }
        );
      });
    } else {
      log();
    }
  }

  // 1. Listen first, then replay.
  sseManager.addConnection(connection);
  openStreams.add(cleanup);
  res.on('close', cleanup);
  request.raw.on('aborted', cleanup);

  res.writeHead(200, {
    // keep headers already set by hooks (e.g. CORS) - hijack bypasses reply.send
    ...(reply.getHeaders() as Record<string, string>),
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  // Initial comment: lets clients/proxies know the stream is live.
  write(': connected\n\n');

  enqueue(() => replayFrom());

  heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      cleanup();
      return;
    }
    write(': heartbeat\n\n');
  }, heartbeatIntervalMs);

  logger.info({ userId, lastSeq: initialSeq }, 'SSE connection established');
  void getAudit().emit(
    {
      action: 'data_access.read',
      outcome: 'success',
      root: true,
      userId,
      target: { type: 'event_stream', id: userId },
      riskLevel: 'low',
      tags: ['sse'],
      details: { phase: 'connect', resumeFromSeq: initialSeq },
    },
    { bestEffort: true }
  );
}
