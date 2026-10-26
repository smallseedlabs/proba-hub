import type { PoolClient } from 'pg';
import { pool } from '../db/client.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  AUDIT_ACTION_INFO,
  buildAuditContent,
  type AuditActionName as CatalogActionName,
  type AuditCategory,
} from '@smallseedlabs/proba-protocol/audit';
import {
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
import { maskSecretsInText, redactDetails, redactString } from './redact.js';
import { currentTrace } from './trace.js';
import { systemClock, systemIds, toAuditLogger } from './runtime.js';

/** Catalog actions that are `generic` or `alias` in v0.3.1. The Hub never emits them (a unit test keeps this list equal to the catalog). */
export type DeprecatedAuditAction =
  | 'brain.clarify_requested'
  | 'tool.called'
  | 'tool.completed'
  | 'policy.evaluated'
  | 'policy.denied'
  | 'data_access.read'
  | 'data_access.write'
  | 'memory.read'
  | 'memory.write'
  | 'metrics.observation_stored'
  | 'config.changed';

/** Every specific action name in the protocol catalog (AUDIT_ACTION_INFO). The Hub never invents its own, and never uses a generic or alias name. */
export type AuditActionName = Exclude<CatalogActionName, DeprecatedAuditAction>;
/** The coarse `category` field of an event. It is NOT the action prefix: it comes from AUDIT_ACTION_INFO. */
export type AuditCategoryName = AuditCategory;

/** Catalog actions the Hub may emit: those whose status is `specific`. */
const SPECIFIC_ACTIONS = new Set<string>(
  (Object.keys(AUDIT_ACTION_INFO) as CatalogActionName[]).filter((a) => AUDIT_ACTION_INFO[a].status === 'specific')
);

/** Kinds of raw text the Hub sets (a subset of AUDIT_CONTENT_KINDS). */
export type AuditContentKind = 'user_message' | 'brain_reply' | 'brain_clarification' | 'explanation';

export interface HubAuditDraft {
  /** Specific action from the catalog. Category and default risk come from AUDIT_ACTION_INFO. */
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
   * Raw text behind the event (a message, a reply, an explanation). Only written when
   * AUDIT_CONTENT_ENABLED is on: secrets are masked, long text is truncated and flagged
   * (AuditEvent.content). `details` keeps the length either way.
   */
  content?: { kind: AuditContentKind; text: string };
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
  /** Write AuditEvent.content (default: config.audit.contentEnabled). */
  contentEnabled?: boolean;
  service?: string;
  defaultWorkspaceId?: string;
  clock?: Clock;
  ids?: IdGenerator;
  logger?: Logger;
}

export function createHubAudit(deps: HubAuditDeps): HubAudit {
  const enabled = deps.enabled ?? config.audit.enabled;
  const contentEnabled = deps.contentEnabled ?? config.audit.contentEnabled;
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
      const info = AUDIT_ACTION_INFO[draft.action as CatalogActionName] as
        | (typeof AUDIT_ACTION_INFO)[CatalogActionName]
        | undefined;
      if (!info) {
        log.error('audit event with an action that is not in AUDIT_ACTION_INFO', { action: draft.action });
        return null;
      }
      if (!SPECIFIC_ACTIONS.has(draft.action)) {
        log.error('audit event with a generic or alias action; use the preferred one', {
          action: draft.action,
          preferred: info.preferred,
        });
        return null;
      }
      const ctx = currentTrace();
      const category: AuditCategoryName = info.category;
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
            riskLevel: draft.riskLevel ?? info.riskLevel,
            ...(draft.cost ? { cost: draft.cost } : {}),
            ...(draft.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(draft.durationMs)) } : {}),
            ...(draft.tags?.length ? { tags: draft.tags } : {}),
            details: redactDetails(details),
            ...(contentEnabled && draft.content && draft.content.text.length > 0
              ? (() => {
                  const masked = maskSecretsInText(draft.content.text);
                  return { content: buildAuditContent(draft.content.kind, masked.text, { redactions: masked.redactions }) };
                })()
              : {}),
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
