import type { GatewayRunRequest, GatewayRunSnapshot } from './gateway-client.js';

const CANCELLABLE = new Set(['accepted', 'running', 'awaiting_approval']);

export interface GatewayRunRecord {
  workspaceId: string;
  userId: string;
  idempotencyKey: string;
  runId: string;
  goalId?: string;
  threadId?: string;
  askId?: string;
  status: GatewayRunSnapshot['status'];
  request: GatewayRunRequest;
}

export interface GatewayRunScope {
  workspaceId: string;
  userId: string;
}

export interface GatewayRunStore {
  getByAsk(scope: GatewayRunScope & { askId: string }): Promise<GatewayRunRecord | undefined>;
  getByIdempotency(scope: GatewayRunScope & { idempotencyKey: string }): Promise<GatewayRunRecord | undefined>;
  listCancellable(scope: GatewayRunScope): Promise<GatewayRunRecord[]>;
  upsert(record: GatewayRunRecord): Promise<void>;
}

/** Drop tokens and resume so a durable row cannot replay a caller-spoofed grant. */
export function durableGatewayRequest(request: GatewayRunRequest): GatewayRunRequest {
  const { actAsAssertion: _assertion, resume: _resume, ...rest } = request;
  return rest;
}

export function isCancellableStatus(status: GatewayRunSnapshot['status']): boolean {
  return CANCELLABLE.has(status);
}

/** In-memory store for tests. Restart = a new GatewayBrain sharing this instance. */
export class MemoryGatewayRunStore implements GatewayRunStore {
  private readonly byIdempotency = new Map<string, GatewayRunRecord>();

  async getByAsk(scope: GatewayRunScope & { askId: string }): Promise<GatewayRunRecord | undefined> {
    for (const row of this.byIdempotency.values()) {
      if (
        row.workspaceId === scope.workspaceId &&
        row.userId === scope.userId &&
        row.askId === scope.askId
      ) {
        return clone(row);
      }
    }
    return undefined;
  }

  async getByIdempotency(
    scope: GatewayRunScope & { idempotencyKey: string }
  ): Promise<GatewayRunRecord | undefined> {
    const row = this.byIdempotency.get(idempotencyKey(scope));
    return row ? clone(row) : undefined;
  }

  async listCancellable(scope: GatewayRunScope): Promise<GatewayRunRecord[]> {
    return [...this.byIdempotency.values()]
      .filter(
        (row) =>
          row.workspaceId === scope.workspaceId &&
          row.userId === scope.userId &&
          isCancellableStatus(row.status)
      )
      .map(clone);
  }

  async upsert(record: GatewayRunRecord): Promise<void> {
    this.byIdempotency.set(idempotencyKey(record), clone({ ...record, request: durableGatewayRequest(record.request) }));
  }
}

function idempotencyKey(scope: GatewayRunScope & { idempotencyKey: string }): string {
  return `${scope.workspaceId}\0${scope.userId}\0${scope.idempotencyKey}`;
}

function clone(row: GatewayRunRecord): GatewayRunRecord {
  return {
    ...row,
    request: { ...row.request },
  };
}
