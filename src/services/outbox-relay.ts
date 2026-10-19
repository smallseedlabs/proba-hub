import { pool } from '../db/client.js';
import { redisPub, redisSub } from './redis.js';
import { sseManager } from './sse-manager.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import type { EventEnvelope } from '@smallseedlabs/proba-protocol';

const CHANNEL = 'proba:events';
let publisherInterval: NodeJS.Timeout | null = null;

export function startOutboxRelay(): void {
  startPublisher();
  startSubscriber();
  logger.info({ pollIntervalMs: config.outbox.pollIntervalMs }, 'Outbox relay started');
}

// Trigger immediate relay check (called after command commits)
export function kickOutboxRelay(): void {
  // Run publisher immediately without waiting for next interval
  publishPendingEvents().catch(err => {
    logger.error({ err }, 'Error in kicked relay');
  });
}

async function publishPendingEvents(): Promise<void> {
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
}

function startPublisher(): void {
  publisherInterval = setInterval(() => {
    publishPendingEvents();
  }, config.outbox.pollIntervalMs);
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
