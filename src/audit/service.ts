import type { PoolClient } from 'pg';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  AUDIT_ACTIONS,
  AuditValidationError,
  PostgresOutboxStore,
  createOutboxAuditEmitter,
  type AuditActor,
  type AuditEmitter,
  type AuditEvent,
  type AuditTarget,
  type Clock,
  type IdGenerator,
  type Logger,
  type OutboxStore,
  type PgQueryable,
} from './vendor/proba-audit/index.js';
import { redactDetails, redactString } from './redact.js';
import { currentTrace } from './trace.js';
import { systemClock, systemIds, toAuditLogger } from './runtime.js';

/** Every action name the protocol lists in AUDIT_ACTIONS. The Hub never invents its own. */
export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS][number];
export type AuditCategoryName = keyof typeof AUDIT_ACTIONS;

const ALL_ACTIONS = new Set<string>(Object.values(AUDIT_ACTIONS).flat());

export interface HubAuditDraft {
  /** Dotted action from AUDIT_ACTIONS. The category is its prefix. */
  action: AuditActionName;
  outcome: AuditEvent['outcome'];
  /** Defaults to the authenticated user, else the Hub itself (system). */
  actor?: AuditActor;
  userId?: string;
  workspaceId?: string;
  threadId?: string;
  goalId?: string;
  target?: AuditTarget;
  errorCode?: string;
  errorMessage?: string;
  riskLevel?: AuditEvent['riskLevel'];
  cost?: AuditEvent['cost'];
  durationMs?: number;
  details?: Record<string, unknown>;
  tags?: string[];
  /**
   * Use the request's root span as this event's span (and no parent). Exactly one
   * event per request should do this: the first thing the request audits.
   */
  root?: boolean;
  /** Explicit span (see startSpan) so children can point at it. */
  spanId?: string;
  parentSpanId?: string;
}

export interface HubEmitOptions {
  /**
   * The caller's open transaction: the event commits or rolls back with the
   * business change. Omit it for an event that stands alone (it is then its own
   * single-statement transaction).
   */
  tx?: PoolClient | PgQueryable;
  /**
   * Never throw: log and carry on when the event cannot be written. For events
   * about observation rather than a change (SSE connect, background errors).
   */
  bestEffort?: boolean;
}

export interface HubAudit {
  /**
   * Build, redact, validate and enqueue one event in the audit outbox.
   *
   * Failure policy:
   * - the database refuses the insert: throws, so a business transaction that
   *   passed `tx` rolls back (fail closed: no unaudited action), unless `bestEffort`;
   * - the event fails protocol validation: a programming error, logged at error
   *   level and swallowed (fail open: a bad audit event must not take the Hub down).
   */
  emit(draft: HubAuditDraft, options?: HubEmitOptions): Promise<AuditEvent | null>;
  readonly enabled: boolean;
}

export interface HubAuditDeps {
  outbox: OutboxStore<PgQueryable>;
  enabled?: boolean;
  service?: string;
  defaultWorkspaceId?: string;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

export function createHubAudit(deps: HubAuditDeps): HubAudit {
  const enabled = deps.enabled ?? config.audit.enabled;
  const log = deps.logger ?? toAuditLogger(logger);
  const emitter: AuditEmitter = createOutboxAuditEmitter<PgQueryable>({
    outbox: deps.outbox,
    service: deps.service ?? config.audit.service,
    defaultWorkspaceId: deps.defaultWorkspaceId ?? config.audit.workspaceId,
    clock: deps.clock ?? systemClock,
    ids: deps.ids ?? systemIds,
    logger: log,
    failureMode: 'throw',
  });

  return {
    enabled,
    async emit(draft, options = {}) {
      if (!enabled) return null;
      if (!ALL_ACTIONS.has(draft.action)) {
        log.error('audit event with an action that is not in AUDIT_ACTIONS', { action: draft.action });
        return null;
      }
      const ctx = currentTrace();
      const category = draft.action.slice(0, draft.action.indexOf('.')) as AuditCategoryName;
      const userId = draft.userId ?? ctx?.userId;
      const details: Record<string, unknown> = { ...(draft.details ?? {}) };
      // A client message id that could not become the traceId is kept for correlation.
      if (ctx?.clientMsgId && details.clientMsgId === undefined) details.clientMsgId = ctx.clientMsgId;

      const root = draft.root === true && ctx !== undefined;
      try {
        return await emitter.emit(
          {
            action: draft.action,
            category,
            outcome: draft.outcome,
            actor: draft.actor ?? (userId ? { type: 'user', id: userId } : { type: 'system', id: 'hub' }),
            ...(userId ? { userId } : {}),
            ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
            ...(draft.threadId ? { threadId: draft.threadId } : {}),
            ...(draft.goalId ? { goalId: draft.goalId } : {}),
            ...(draft.target ? { target: draft.target } : {}),
            ...(draft.errorCode ? { errorCode: draft.errorCode } : {}),
            ...(draft.errorMessage ? { errorMessage: redactString(draft.errorMessage) } : {}),
            ...(draft.riskLevel ? { riskLevel: draft.riskLevel } : {}),
            ...(draft.cost ? { cost: draft.cost } : {}),
            ...(draft.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(draft.durationMs)) } : {}),
            ...(draft.tags?.length ? { tags: draft.tags } : {}),
            details: redactDetails(details),
            ...(ctx ? { traceId: ctx.traceId } : {}),
            ...(draft.spanId
              ? { spanId: draft.spanId }
              : root
                ? { spanId: ctx.rootSpanId }
                : {}),
            ...(root
              ? {}
              : draft.parentSpanId || ctx
                ? { parentSpanId: draft.parentSpanId ?? ctx?.spanId }
                : {}),
          },
          { tx: options.tx }
        );
      } catch (err) {
        if (err instanceof AuditValidationError) return null; // already logged by the emitter
        if (options.bestEffort) {
          log.error('audit event could not be written (best effort, continuing)', { err, action: draft.action });
          return null;
        }
        throw err;
      }
    },
  };
}

let instance: HubAudit | undefined;

/** The process-wide emitter, backed by the Hub's pool and the `audit_outbox` table. */
export function getAudit(): HubAudit {
  instance ??= createHubAudit({ outbox: new PostgresOutboxStore({ pool }) });
  return instance;
}

/** Replace the process-wide emitter (tests). Pass undefined to reset. */
export function setAuditForTests(audit: HubAudit | undefined): void {
  instance = audit;
}
