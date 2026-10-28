import { validateContextPacket, type ContextPacket, type ContextRequest } from '@smallseedlabs/proba-protocol';
import {
  ContextClientError,
  type ContextClient,
  type ContextClientBuildOptions,
} from './context-client.js';

export interface HttpContextClientOptions {
  /** Base URL of the context bridge (no trailing slash). Empty disables the client. */
  baseUrl: string;
  timeoutMs?: number;
  /** Failures in a row before the circuit opens. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open (ms). Default 30_000. */
  openMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * HTTP adapter for POST /v1/context/build. No in-process builder: the bridge is
 * the only implementation behind ContextClient.
 */
export class HttpContextClient implements ContextClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private failures = 0;
  private openedAt: number | null = null;

  constructor(options: HttpContextClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async build(request: ContextRequest, options: ContextClientBuildOptions): Promise<ContextPacket> {
    if (!this.baseUrl) {
      throw new ContextClientError('unreachable', 'CONTEXT_BRIDGE_URL is not configured');
    }
    this.assertCircuitClosed();

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/context/build`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.assertion}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.recordFailure();
        const code = response.status >= 500 ? 'http_error' : 'rejected';
        throw new ContextClientError(code, `Context bridge returned HTTP ${response.status}`, undefined, response.status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        this.recordFailure();
        throw new ContextClientError('invalid_packet', 'Context bridge returned non-JSON', err);
      }
      const parsed = validateContextPacket(body);
      if (!parsed.success) {
        this.recordFailure();
        throw new ContextClientError('invalid_packet', 'Context bridge returned an invalid packet');
      }
      this.recordSuccess();
      return parsed.data;
    } catch (err) {
      if (err instanceof ContextClientError) throw err;
      if ((err as Error)?.name === 'AbortError') {
        this.recordFailure();
        throw new ContextClientError('timeout', `Context bridge timed out after ${timeoutMs}ms`, err);
      }
      this.recordFailure();
      throw new ContextClientError('unreachable', 'Context bridge is unreachable', err);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private assertCircuitClosed(): void {
    if (this.openedAt === null) return;
    if (this.now() - this.openedAt >= this.openMs) {
      // Half-open: allow one probe.
      this.openedAt = null;
      return;
    }
    throw new ContextClientError('circuit_open', 'Context bridge circuit is open');
  }

  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.failures = 0;
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }
}

/** Null client used when CONTEXT_BRIDGE_URL is unset. */
export class DisabledContextClient implements ContextClient {
  async build(): Promise<ContextPacket> {
    throw new ContextClientError('unreachable', 'CONTEXT_BRIDGE_URL is not configured');
  }
}

export function createContextClient(options: HttpContextClientOptions): ContextClient {
  if (!options.baseUrl.trim()) return new DisabledContextClient();
  return new HttpContextClient(options);
}
