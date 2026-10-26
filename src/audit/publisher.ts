import type { AuditPublisherKind } from '../config.js';
import {
  RedisStreamsPublisher,
  type Clock,
  type EventBus,
  type PublishOptions,
  type StreamsClient,
} from './vendor/proba-audit/index.js';

/**
 * The audit publisher port is the publish half of proba-audit's `EventBus`
 * (`vendor/proba-audit/ports/event-bus.ts`). The relay only depends on that
 * interface; `AUDIT_PUBLISHER` picks the adapter:
 *
 * - `redis` (default): XADD to the Redis Stream the audit-consumer reads.
 * - `log`: writes the id of each event to the Hub log and publishes nothing
 *   else. For local diagnostics without a broker.
 *
 * To add an adapter: implement `EventBus`, add its name to `AUDIT_PUBLISHERS`
 * in `src/config.ts`, and add a case to `createAuditPublisher`.
 */
export type AuditPublisher = EventBus;

/** Minimal logger the publishers need (pino's child logger satisfies it). */
export interface PublisherLogger {
  info(fields: Record<string, unknown>, msg: string): void;
}

export interface AuditPublisherDeps {
  clock: Clock;
  logger: PublisherLogger;
  /** Approximate XADD MAXLEN for the Redis stream. 0 or undefined = unbounded. */
  maxStreamLength?: number;
}

export function createAuditPublisher(kind: AuditPublisherKind, deps: AuditPublisherDeps): AuditPublisher {
  switch (kind) {
    case 'redis':
      return new LazyRedisPublisher(deps);
    case 'log':
      return new LogPublisher(deps.logger);
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown audit publisher: ${String(unreachable)}`);
    }
  }
}

/**
 * Redis adapter. The Redis connection (`services/redis.ts`, which connects on
 * import) is loaded on first publish, so choosing another adapter never touches Redis.
 */
class LazyRedisPublisher implements AuditPublisher {
  private inner?: Promise<RedisStreamsPublisher>;

  constructor(private readonly deps: AuditPublisherDeps) {}

  private publisher(): Promise<RedisStreamsPublisher> {
    this.inner ??= import('../services/redis.js').then(
      ({ redisClient }) =>
        new RedisStreamsPublisher({
          client: redisClient as unknown as StreamsClient,
          clock: this.deps.clock,
          ...(this.deps.maxStreamLength && this.deps.maxStreamLength > 0 ? { maxStreamLength: this.deps.maxStreamLength } : {}),
        })
    );
    return this.inner;
  }

  async publish(topic: string, payload: unknown, options?: PublishOptions): Promise<string> {
    return (await this.publisher()).publish(topic, payload, options);
  }

  async publishBatch(topic: string, payloads: unknown[], options?: PublishOptions): Promise<string[]> {
    return (await this.publisher()).publishBatch(topic, payloads, options);
  }
}

/** Logs ids only (never `details` or `content`) and returns a local sequence as the message id. */
class LogPublisher implements AuditPublisher {
  private seq = 0;

  constructor(private readonly logger: PublisherLogger) {}

  async publish(topic: string, payload: unknown): Promise<string> {
    const id = `log-${++this.seq}`;
    const event = payload as { eventId?: unknown; traceId?: unknown; action?: unknown } | null;
    this.logger.info(
      { topic, messageId: id, eventId: event?.eventId, traceId: event?.traceId, action: event?.action },
      'Audit event published (log adapter)'
    );
    return id;
  }

  async publishBatch(topic: string, payloads: unknown[]): Promise<string[]> {
    const ids: string[] = [];
    for (const payload of payloads) ids.push(await this.publish(topic, payload));
    return ids;
  }
}
