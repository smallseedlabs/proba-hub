import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { createAuditPublisher } from './publisher.js';
import { OutboxRelay, PostgresOutboxStore, type Clock, type EventBus, type OutboxStore } from './vendor/proba-audit/index.js';
import { systemClock, toAuditLogger } from './runtime.js';

export interface AuditRelayDeps {
  outbox?: OutboxStore;
  bus?: EventBus;
  clock?: Clock;
  topic?: string;
}

/**
 * The audit relay: claims rows of `audit_outbox` and publishes them through the
 * audit publisher port (`AUDIT_PUBLISHER`; Redis Stream the audit-consumer reads by default). It is separate from the Hub's SSE relay
 * (`outbox` table, pub/sub channel `proba:events`), which it never touches.
 */
export function createAuditRelay(deps: AuditRelayDeps = {}): OutboxRelay {
  const clock = deps.clock ?? systemClock;
  return new OutboxRelay({
    outbox: deps.outbox ?? new PostgresOutboxStore({ pool }),
    bus:
      deps.bus ??
      createAuditPublisher(config.audit.publisher, {
        clock,
        logger: logger.child({ component: 'audit-publisher' }),
        maxStreamLength: config.audit.maxStreamLength,
      }),
    topic: deps.topic ?? config.audit.stream,
    logger: toAuditLogger(logger.child({ component: 'audit-relay' })),
    clock,
    batchSize: config.audit.relayBatchSize,
    pollIntervalMs: config.audit.relayPollIntervalMs,
    leaseMs: config.audit.relayLeaseMs,
    retainPublishedMs: config.audit.retainPublishedMs,
  });
}

let relay: OutboxRelay | null = null;
let refCount = 0;

/** Start the audit relay (ref-counted like the other background jobs). No-op when disabled by config. */
export function startAuditRelay(): void {
  if (!config.audit.enabled || !config.audit.relayEnabled) {
    logger.info(
      { enabled: config.audit.enabled, relayEnabled: config.audit.relayEnabled },
      'Audit relay not started (disabled by configuration); events stay in audit_outbox'
    );
    return;
  }
  refCount++;
  if (relay) return;
  relay = createAuditRelay();
  relay.start();
}

export async function stopAuditRelay(): Promise<void> {
  if (refCount === 0) return;
  refCount--;
  if (refCount === 0 && relay) {
    const stopping = relay;
    relay = null;
    await stopping.stop();
  }
}
