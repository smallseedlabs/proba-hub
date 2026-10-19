import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { kickOutboxRelay } from './outbox-relay.js';

let expiryTimer: NodeJS.Timeout | null = null;
let refCount = 0;

/** Start the ask expiry job. Ref-counted so several app instances can share it. */
export function startAskExpiryJob(): void {
  refCount++;
  if (expiryTimer) return;

  expiryTimer = setInterval(async () => {
    try {
      await processExpiredAsks();
    } catch (error) {
      logger.error({ error }, 'Ask expiry job error');
    }
  }, config.ask.expiryCheckIntervalMs);
  expiryTimer.unref();

  logger.info('Ask expiry job started');
}

export function stopAskExpiryJob(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
    logger.info('Ask expiry job stopped');
  }
}

async function processExpiredAsks(): Promise<void> {
  const result = await pool.query(
    `SELECT id, thread_id, on_expire, status
     FROM asks
     WHERE expires_at IS NOT NULL 
       AND expires_at < NOW()
       AND status = 'pending'`
  );

  for (const ask of result.rows) {
    await handleExpiredAsk(ask.id, ask.thread_id, ask.on_expire);
  }

  if (result.rows.length > 0) {
    logger.info({ count: result.rows.length }, 'Processed expired asks');
  }
}

async function handleExpiredAsk(
  askId: string,
  threadId: string,
  onExpire: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Guard against double expiry (concurrent job runs / answer racing expiry)
    const expired = await client.query(
      `UPDATE asks SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING id`,
      [askId]
    );
    if (expired.rowCount === 0) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      `UPDATE inbox_items SET status = 'expired' WHERE related_ask_id = $1`,
      [askId]
    );

    const userResult = await client.query(
      'SELECT t.user_id FROM asks a JOIN threads t ON t.id = a.thread_id WHERE a.id = $1',
      [askId]
    );
    const userId = userResult.rows[0].user_id;

    const seqResult = await client.query(
      'SELECT get_next_event_seq($1) as seq',
      [userId]
    );
    const seq = seqResult.rows[0].seq;

    let resolution: string;
    if (onExpire === 'deny') {
      resolution = 'denied';
    } else if (onExpire === 'escalate') {
      resolution = 'escalated';
    } else {
      resolution = 'default';
    }

    const eventResult = await client.query(
      `INSERT INTO events (user_id, seq, type, thread_id, payload)
       VALUES ($1, $2, 'ask_resolved', $3, $4)
       RETURNING id`,
      [
        userId,
        seq,
        threadId,
        JSON.stringify({
          askId,
          resolution,
          reason: 'expired',
        }),
      ]
    );

    await client.query(
      'INSERT INTO outbox (user_id, event_id) VALUES ($1, $2)',
      [userId, eventResult.rows[0].id]
    );

    await client.query('COMMIT');
    kickOutboxRelay();

    logger.info({ askId, onExpire, resolution }, 'Handled expired ask');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ error, askId }, 'Failed to handle expired ask');
    throw error;
  } finally {
    client.release();
  }
}
