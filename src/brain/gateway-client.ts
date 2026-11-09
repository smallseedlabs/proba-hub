export type GatewayRunStatus =
  | 'accepted'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'ambiguous'
  | 'blocked';

export type ApprovedCreative =
  | { type: 'TEXT'; headline: string; body: string }
  | { type: 'IMAGE'; headline: string; body?: string; mediaUrl: string; callToAction?: string };

export interface GatewayRunSnapshot {
  runId: string;
  status: GatewayRunStatus;
  iteration: number;
  outputs?: unknown[];
  needs?: unknown[];
  usage?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  /** review_performance summary (dry-run proposal is evidence only). */
  analytics?: Record<string, unknown>;
  /** Outcome of a Hub-approved analytics action. */
  actionOutcome?: Record<string, unknown>;
}

export interface GatewayRunRequest {
  traceId: string;
  workspaceId: string;
  userId: string;
  goalId?: string;
  threadId?: string;
  stepId: string;
  stepType: string;
  command: unknown;
  actAsAssertion?: string;
  idempotencyKey: string;
  budget?: Record<string, unknown>;
  /**
   * Operator-entered landing URL from Hub session/goal persistence.
   * Never taken from model/tool text. Omitted is valid; gather/create fail closed.
   */
  userSuppliedInput?: {
    landingPageUrl: string;
    /** Operator-approved creative (copy/media) for Ads post creation. */
    creative?: ApprovedCreative;
    /** Operator-approved targeting (Ads validates the Reddit shape). */
    targeting?: Record<string, unknown>;
  };
  resume?: {
    askId: string;
    choice: 'approve' | 'reject' | 'edit';
    values?: Record<string, unknown>;
    edit?: string;
    planId?: string;
    approved?: boolean;
  };
}

export interface GatewayClient {
  createRun(request: GatewayRunRequest, serviceToken: string, signal?: AbortSignal): Promise<GatewayRunSnapshot>;
  getRun(runId: string, serviceToken: string, signal?: AbortSignal): Promise<GatewayRunSnapshot>;
  cancelRun(
    runId: string,
    reason: 'hub_cancel' | 'hub_pause' | 'emergency_stop',
    serviceToken: string,
    signal?: AbortSignal
  ): Promise<GatewayRunSnapshot>;
}

export class GatewayClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: string, message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'GatewayClientError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const SECRET_KEY = /authorization|actasassertion|token|password|api[_-]?key|secret|bearer/i;
const JWT_STRING = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_SUBSTRING = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

export function redactSecretText(value: string): string {
  if (JWT_STRING.test(value) && !/\s/.test(value) && value.length > 24) return '[redacted-jwt]';
  return value.replace(JWT_SUBSTRING, '[redacted-jwt]');
}

export function redactGatewayDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactGatewayDetails);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redactGatewayDetails(v);
    }
    return out;
  }
  if (typeof value === 'string') return redactSecretText(value);
  return value;
}
