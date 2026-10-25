// Vendored from smallseedlabs/proba-audit @ 038d63f (Apache-2.0). See vendor/proba-audit/README.md.
import type { Clock } from './ports/clock.js';
import type { EventBus, PublishOptions } from './ports/event-bus.js';

/**
 * Minimal subset of a node-redis v4 client used to publish. The Hub passes its
 * existing `redisClient`; nothing here touches pub/sub (`proba:events`).
 */
export interface StreamsClient {
  xAdd(key: string, id: string, message: Record<string, string>, options?: unknown): Promise<string>;
  multi(): {
    xAdd(key: string, id: string, message: Record<string, string>, options?: unknown): unknown;
    exec(): Promise<unknown[]>;
  };
}

export interface RedisStreamsPublisherOptions {
  client: StreamsClient;
  clock: Clock;
  /** Approximate max length per stream (XADD MAXLEN ~). Unset keeps everything. */
  maxStreamLength?: number;
}

/**
 * Publish side of proba-audit's RedisStreamsEventBus
 * (packages/adapters/src/redis/redis-streams-event-bus.ts), with the same stream
 * entry format the audit consumer reads:
 *
 *   XADD <topic> * data=<JSON event> publishedAt=<UTC ISO> [key=<partition key>]
 */
export class RedisStreamsPublisher implements EventBus {
  constructor(private readonly options: RedisStreamsPublisherOptions) {}

  async publish(topic: string, payload: unknown, options: PublishOptions = {}): Promise<string> {
    return this.options.client.xAdd(topic, '*', this.fields(payload, options), this.trim());
  }

  async publishBatch(topic: string, payloads: unknown[], options: PublishOptions = {}): Promise<string[]> {
    if (payloads.length === 0) return [];
    // MULTI keeps the batch contiguous and in order.
    const multi = this.options.client.multi();
    for (const payload of payloads) multi.xAdd(topic, '*', this.fields(payload, options), this.trim());
    const ids = await multi.exec();
    return ids.map((id) => String(id));
  }

  private fields(payload: unknown, options: PublishOptions): Record<string, string> {
    return {
      data: JSON.stringify(payload),
      publishedAt: this.options.clock.isoNow(),
      ...(options.key ? { key: options.key } : {}),
    };
  }

  private trim(): { TRIM: { strategy: 'MAXLEN'; strategyModifier: '~'; threshold: number } } | undefined {
    const max = this.options.maxStreamLength;
    return max ? { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: max } } : undefined;
  }
}
