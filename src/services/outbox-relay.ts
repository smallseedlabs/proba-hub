import { pool } from '../db/client.js';
import { redisPub, redisSub } from './redis.js';
import { sseManager } from './sse-manager.js';
import { logger } from '../logger.js';
import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

const CHANNEL = 'proba:events';
const POLL_INTERVAL_MS = 1000;

export function startOutboxRelay(): void {
  startPublisher();
  startSubscriber();
  logger.info('Outbox relay started');
}

function startPublisher(): void {
  setInterval(async () => {
    try {
      const result = await pool.query(
        `SELECT o.id, o.user_id, o.event_id,
                e.seq, e.type, e.thread_id, e.payload,
                u.component, u.version, u.props, u.actions,
                e.fallback_text, e.created_at
         FROM outbox o
         JOIN events e ON o.event_id = e.id
         LEFT JOIN ui_payloads u ON e.ui_payload_id = u.id
         WHERE o.published = false
         ORDER BY o.created_at ASC
         LIMIT 100`
      );

      for (const row of result.rows) {
        const envelope: EventEnvelope = {
          kind: 'event',
          seq: row.seq,
          type: row.type,
          threadId: row.thread_id,
          payload: row.payload,
          at: row.created_at.toISOString(),
        };

        if (row.component) {
          envelope.ui = {
            component: row.component,
            version: row.version,
            props: row.props,
          };
          if (row.actions) {
            (envelope.ui as any).actions = row.actions;
          }
        }

        if (row.fallback_text) {
          envelope.fallbackText = row.fallback_text;
        }

        const message = JSON.stringify({
          userId: row.user_id,
          event: envelope,
        });

        await redisPub.publish(CHANNEL, message);

        await pool.query(
          'UPDATE outbox SET published = true, published_at = NOW() WHERE id = $1',
          [row.id]
        );

        logger.debug(
          { userId: row.user_id, seq: row.seq, type: row.type },
          'Published event to Redis'
        );
      }
    } catch (error) {
      logger.error({ error }, 'Outbox publisher error');
    }
  }, POLL_INTERVAL_MS);
}

function startSubscriber(): void {
  redisSub.subscribe(CHANNEL, (message) => {
    try {
      const { userId, event } = JSON.parse(message);
      
      const sent = sseManager.sendToUser(userId, event);
      
      if (sent) {
        logger.debug(
          { userId, seq: event.seq, type: event.type },
          'Sent event via SSE'
        );
      }
    } catch (error) {
      logger.error({ error, message }, 'Failed to process Redis message');
    }
  });

  logger.info({ channel: CHANNEL }, 'Subscribed to Redis channel');
}
