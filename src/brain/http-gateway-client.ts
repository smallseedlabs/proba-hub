import {
  GatewayClientError,
  redactGatewayDetails,
  redactSecretText,
  type GatewayClient,
  type GatewayRunRequest,
  type GatewayRunSnapshot,
} from './gateway-client.js';

export interface HttpGatewayClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const RUN_STATUSES = new Set([
  'accepted',
  'running',
  'awaiting_approval',
  'paused',
  'stopped',
  'completed',
  'failed',
  'cancelled',
  'ambiguous',
  'blocked',
]);

export class DisabledGatewayClient implements GatewayClient {
  async createRun(): Promise<GatewayRunSnapshot> {
    throw new GatewayClientError('unconfigured', 'GATEWAY_URL is not configured');
  }
  async getRun(): Promise<GatewayRunSnapshot> {
    throw new GatewayClientError('unconfigured', 'GATEWAY_URL is not configured');
  }
  async cancelRun(): Promise<GatewayRunSnapshot> {
    throw new GatewayClientError('unconfigured', 'GATEWAY_URL is not configured');
  }
}

export class HttpGatewayClient implements GatewayClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  createRun(request: GatewayRunRequest, serviceToken: string, signal?: AbortSignal): Promise<GatewayRunSnapshot> {
    return this.send('POST', '/v1/runs', serviceToken, request, signal);
  }

  getRun(runId: string, serviceToken: string, signal?: AbortSignal): Promise<GatewayRunSnapshot> {
    return this.send('GET', `/v1/runs/${encodeURIComponent(runId)}`, serviceToken, undefined, signal);
  }

  cancelRun(
    runId: string,
    reason: 'hub_cancel' | 'hub_pause' | 'emergency_stop',
    serviceToken: string,
    signal?: AbortSignal
  ): Promise<GatewayRunSnapshot> {
    return this.send('POST', `/v1/runs/${encodeURIComponent(runId)}/cancel`, serviceToken, { reason }, signal);
  }

  private async send(
    method: string,
    path: string,
    serviceToken: string,
    body: unknown,
    outer?: AbortSignal
  ): Promise<GatewayRunSnapshot> {
    if (!this.baseUrl) throw new GatewayClientError('unconfigured', 'GATEWAY_URL is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onOuter = () => controller.abort();
    outer?.addEventListener('abort', onOuter, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${serviceToken}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }

      if (!response.ok) {
        throw mapHttpError(response.status, parsed);
      }
      return parseSnapshot(parsed);
    } catch (err) {
      if (err instanceof GatewayClientError) throw err;
      if ((err as Error)?.name === 'AbortError') {
        throw new GatewayClientError('timeout', `gateway timed out after ${this.timeoutMs}ms`, undefined, true);
      }
      throw new GatewayClientError('unreachable', 'gateway is unreachable');
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
  }
}

function mapHttpError(status: number, body: unknown): GatewayClientError {
  const safe = redactGatewayDetails(body) as { error?: unknown; message?: unknown } | undefined;
  const code = typeof safe?.error === 'string' ? safe.error : status === 401 ? 'unauthorized' : status === 403 ? 'workspace_mismatch' : 'gateway_error';
  const message =
    typeof safe?.message === 'string' && safe.message.length > 0 && !looksSecret(safe.message)
      ? safe.message
      : `gateway returned HTTP ${status}`;
  const retryable = status === 429 || status >= 500;
  if (status === 401) return new GatewayClientError(code === 'token_expired' ? 'token_expired' : 'unauthorized', message, status, false);
  if (status === 403) return new GatewayClientError(code === 'workspace_mismatch' ? 'workspace_mismatch' : code, message, status, false);
  if (status === 404) return new GatewayClientError('not_found', message, status, false);
  if (status === 409) return new GatewayClientError(typeof safe?.error === 'string' ? safe.error : 'conflict', message, status, false);
  if (status === 504) return new GatewayClientError('ambiguous', message, status, false);
  return new GatewayClientError(code, message, status, retryable);
}

function looksSecret(value: string): boolean {
  return /bearer\s+\S+/i.test(value) || /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value);
}

function redactSnapshotMessage(value: string): string {
  const redacted = redactSecretText(value).slice(0, 500);
  return looksSecret(redacted) ? 'gateway error' : redacted;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSnapshot(body: unknown): GatewayRunSnapshot {
  if (!body || typeof body !== 'object') {
    throw new GatewayClientError('invalid_response', 'gateway returned a non-object body');
  }
  const row = body as Record<string, unknown>;
  if (typeof row.runId !== 'string' || typeof row.status !== 'string' || !RUN_STATUSES.has(row.status)) {
    throw new GatewayClientError('invalid_response', 'gateway returned an invalid run snapshot');
  }
  return {
    runId: row.runId,
    status: row.status as GatewayRunSnapshot['status'],
    iteration: typeof row.iteration === 'number' ? row.iteration : 0,
    ...(Array.isArray(row.outputs) ? { outputs: row.outputs } : {}),
    ...(Array.isArray(row.needs) ? { needs: row.needs } : {}),
    ...(row.usage !== undefined ? { usage: row.usage } : {}),
    ...(isPlainObject(row.analytics) ? { analytics: row.analytics } : {}),
    ...(isPlainObject(row.actionOutcome) ? { actionOutcome: row.actionOutcome } : {}),
    ...(row.error && typeof row.error === 'object'
      ? {
          error: {
            code: String((row.error as { code?: unknown }).code ?? 'gateway_error'),
            message: redactSnapshotMessage(String((row.error as { message?: unknown }).message ?? 'gateway error')),
            retryable: Boolean((row.error as { retryable?: unknown }).retryable),
          },
        }
      : {}),
  };
}

export function createGatewayClient(options: HttpGatewayClientOptions): GatewayClient {
  if (!options.baseUrl.trim()) return new DisabledGatewayClient();
  return new HttpGatewayClient(options);
}
