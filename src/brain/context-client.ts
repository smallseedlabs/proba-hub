import type { ContextPacket, ContextRequest } from '@smallseedlabs/proba-protocol';

/**
 * Port the Hub uses to ask the context bridge for a packet before a brain step
 * (`POST /v1/context/build`). Wired in `context-attach.ts` / CommandProcessor.
 */
export interface ContextClient {
  build(request: ContextRequest, options?: ContextClientBuildOptions): Promise<ContextPacket>;
}

export interface ContextClientBuildOptions {
  /** Act-as assertion JWT (Authorization bearer for the bridge). */
  assertion: string;
  /** Optional abort / override timeout for this call. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ContextClientErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'circuit_open'
  | 'http_error'
  | 'invalid_packet'
  | 'rejected';

export class ContextClientError extends Error {
  constructor(
    readonly code: ContextClientErrorCode,
    message: string,
    readonly cause?: unknown,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ContextClientError';
  }
}
