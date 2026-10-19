import { transaction } from '../db/client.js';
import { redisPub, redisSub } from './redis.js';
import { sseManager } from './sse-manager.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { buildEventEnvelope } from './event-envelope.js';

export const EVENTS_CHANNEL = 'proba:events';
const CHANNEL = EVENTS_CHANNEL;
const BATCH_SIZE = 100;

let publisherTimer: NodeJS.Timeout | null = null;
let refCount = 0;
let subscribed = false;

// In-process single-flight guard: the interval tick and kicks after commits
// must never run the publisher concurrently, otherwise the same outbox rows
// are published twice and/or out of seq order.
let running: Promise<void> | null = null;
let rerunRequested = false;

/**
 * Start the outbox relay (publisher + Redis subscriber).
 * Ref-counted so multiple app instances in one process share one relay.
 * Resolves once the Redis subscription is active, so no live event is missed.
 */
export async function startOutboxRelay(): Promise<void> {
  refCount++;
  if (refCount > 1) return;

  await startSubscriber();
  publisherTimer = setInterval(() => kickOutboxRelay(), config.outbox.pollIntervalMs);
  publisherTimer.unref();
  logger.info({ pollIntervalMs: config.outbox.pollIntervalMs }, 'Outbox relay started');
}

export async function stopOutboxRelay(): Promise<void> {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0) return;

  if (publisherTimer) {
    clearInterval(publisherTimer);
    publisherTimer = null;
  }
  if (running) await running;
  if (subscribed) {
    subscribed = false;
    await redisSub.unsubscribe(CHANNEL);
  }
  logger.info('Outbox relay stopped');
}

/**
 * Trigger a relay pass now (call AFTER the producing transaction has committed).
 * Returns a promise that settles when all currently pending rows are published.
 */
export function kickOutboxRelay(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerunRequested = false;
        while ((await publishBatch()) === BATCH_SIZE) {
          // keep draining full batches
        }
      } while (rerunRequested);
    } catch (err) {
      logger.error({ err }, 'Outbox publisher error');
    } finally {
      running = null;
    }
  })();
  return running;
}

/**
 * Publish one batch of unpublished outbox rows, in (user, seq) order.
 * FOR UPDATE SKIP LOCKED makes this safe across multiple hub instances.
 * Delivery is at-least-once; SSE connections de-duplicate by seq.
 */
async function publishBatch(): Promise<number> {
  return transaction(async (client) => {
    const result = await client.query(
      `SELECT o.id AS outbox_id, o.user_id, e.id, e.seq, e.type, e.thread_id, e.payload,
              u.component, u.version, u.props, u.actions,
              e.fallback_text, e.created_at
       FROM outbox o
       JOIN events e ON o.event_id = e.id
       LEFT JOIN ui_payloads u ON e.ui_payload_id = u.id
       WHERE o.published = false
       ORDER BY o.user_id, e.seq ASC
       LIMIT ${BATCH_SIZE}
       FOR UPDATE OF o SKIP LOCKED`
    );

    for (const row of result.rows) {
      await redisPub.publish(
        CHANNEL,
        JSON.stringify({ userId: row.user_id, event: buildEventEnvelope(row) })
      );
      logger.debug({ userId: row.user_id, seq: row.seq, type: row.type }, 'Published event to Redis');
    }

    if (result.rows.length > 0) {
      await client.query(
        'UPDATE outbox SET published = true, published_at = NOW() WHERE id = ANY($1::uuid[])',
        [result.rows.map((r) => r.outbox_id)]
      );
    }

    return result.rows.length;
  });
}

async function startSubscriber(): Promise<void> {
  if (subscribed) return;
  await redisSub.subscribe(CHANNEL, (message) => {
    try {
      const { userId, event } = JSON.parse(message);
      sseManager.sendToUser(userId, event);
    } catch (error) {
      logger.error({ error, message }, 'Failed to process Redis message');
    }
  });
  subscribed = true;
  logger.info({ channel: CHANNEL }, 'Subscribed to Redis channel');
}
