import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { generateSpanId } from './vendor/proba-audit/protocol.js';

/**
 * Per-request trace context.
 *
 * One traceId covers everything caused by one HTTP request (or one background
 * job run): route handler, command processor, brain call, DB writes, the SSE
 * publish kick and every log line. The protocol's root is the web command's
 * `clientMsgId` (see bindTraceId); background work uses a fresh job-run UUID.
 */
export interface TraceContext {
  /** UUID shared by every audit event and log line of this request. */
  traceId: string;
  /** Span of the request itself: the root audit event of the request uses it. */
  rootSpanId: string;
  /** Span that new events are children of (the root span until runInSpan narrows it). */
  spanId: string;
  /** Authenticated user, once known (set by the authenticate hook). */
  userId?: string;
  /** The client's own message id when it could not be used as the traceId. */
  clientMsgId?: string;
}

/** Response header carrying the request's traceId (exposed to browsers via CORS). */
export const TRACE_HEADER = 'X-Trace-Id';

const storage = new AsyncLocalStorage<TraceContext>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function newTraceContext(traceId: string = randomUUID()): TraceContext {
  const rootSpanId = generateSpanId();
  return { traceId, rootSpanId, spanId: rootSpanId };
}

/** The current context, or undefined outside a request/job. */
export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `ctx` as the trace context (an existing context is replaced). */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Run `fn` as a new root: a background job run gets its own traceId. */
export function runAsJob<T>(fn: () => T): T {
  return storage.run(newTraceContext(), fn);
}

/**
 * Root the current request's trace in the client's message id.
 *
 * `clientMsgId` is a UUID in the protocol, so it becomes the traceId as is
 * (lower-cased, so the id is stable regardless of how the client wrote it). A
 * value that is not a UUID is never used as a traceId: the generated one stays
 * and the raw id is kept (truncated) on the context so events can record it in
 * their details. Mutates the context in place so hooks that run later (response
 * headers, logging) see the final value.
 */
export function bindTraceId(clientMsgId: unknown): void {
  const ctx = storage.getStore();
  if (!ctx) return;
  if (isUuid(clientMsgId)) {
    ctx.traceId = clientMsgId.toLowerCase();
  } else if (typeof clientMsgId === 'string' && clientMsgId.length > 0) {
    ctx.clientMsgId = clientMsgId.slice(0, 128);
  }
}

export function setTraceUser(userId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
}

export interface Span {
  spanId: string;
  /** The span that was current when this one started (undefined only for a root). */
  parentSpanId: string | undefined;
}

/** Create a child span (of `parentSpanId`, default the current span) without entering it. */
export function startSpan(parentSpanId?: string): Span {
  return { spanId: generateSpanId(), parentSpanId: parentSpanId ?? storage.getStore()?.spanId };
}

/** Run `fn` with `span` as the current span, so events inside become its children. */
export function runInSpan<T>(span: Span, fn: () => T): T {
  const ctx = storage.getStore();
  if (!ctx) return fn();
  return storage.run({ ...ctx, spanId: span.spanId }, fn);
}

/** pino mixin: `{ traceId }` for every log line written inside a request or job. */
export function traceMixin(): { traceId?: string } {
  const trace = storage.getStore();
  return trace ? { traceId: trace.traceId } : {};
}
