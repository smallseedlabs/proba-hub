// Vendored from smallseedlabs/proba-audit @ 038d63f (Apache-2.0). See vendor/proba-audit/README.md.
/**
 * The publishing half of proba-audit's EventBus port (packages/core/src/ports/event-bus.ts).
 *
 * Hub-local reduction: the Hub only ever PUBLISHES audit events (the relay calls
 * publishBatch); subscribe/read/ack/dead-letter belong to the audit consumer.
 * proba-audit's full `EventBus` is structurally assignable to this interface, so
 * it can replace the Hub's publisher unchanged.
 */

export interface PublishOptions {
  /** Optional partition/ordering hint. Adapters may ignore it. */
  key?: string;
}

export interface EventBus {
  publish(topic: string, payload: unknown, options?: PublishOptions): Promise<string>;
  /** Publishes in order; returns ids in the same order. */
  publishBatch(topic: string, payloads: unknown[], options?: PublishOptions): Promise<string[]>;
}
