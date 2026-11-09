import { query } from '../db/client.js';
import type { GatewayRunRequest, GatewayRunSnapshot } from './gateway-client.js';
import {
  durableGatewayRequest,
  type GatewayRunRecord,
  type GatewayRunScope,
  type GatewayRunStore,
} from './gateway-run-store.js';

interface GatewayRunRow {
  workspace_id: string;
  user_id: string;
  idempotency_key: string;
  run_id: string;
  goal_id: string | null;
  thread_id: string | null;
  ask_id: string | null;
  status: GatewayRunSnapshot['status'];
  request: GatewayRunRequest;
}

const COLUMNS = `workspace_id, user_id, idempotency_key, run_id, goal_id, thread_id, ask_id, status, request`;

export class PostgresGatewayRunStore implements GatewayRunStore {
  async getByAsk(scope: GatewayRunScope & { askId: string }): Promise<GatewayRunRecord | undefined> {
    const result = await query<GatewayRunRow>(
      `SELECT ${COLUMNS} FROM gateway_runs
       WHERE workspace_id = $1 AND user_id = $2 AND ask_id = $3`,
      [scope.workspaceId, scope.userId, scope.askId]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async getByIdempotency(
    scope: GatewayRunScope & { idempotencyKey: string }
  ): Promise<GatewayRunRecord | undefined> {
    const result = await query<GatewayRunRow>(
      `SELECT ${COLUMNS} FROM gateway_runs
       WHERE workspace_id = $1 AND user_id = $2 AND idempotency_key = $3`,
      [scope.workspaceId, scope.userId, scope.idempotencyKey]
    );
    return result.rows[0] ? fromRow(result.rows[0]) : undefined;
  }

  async listCancellable(scope: GatewayRunScope): Promise<GatewayRunRecord[]> {
    const result = await query<GatewayRunRow>(
      `SELECT ${COLUMNS} FROM gateway_runs
       WHERE workspace_id = $1 AND user_id = $2
         AND status IN ('accepted', 'running', 'awaiting_approval')`,
      [scope.workspaceId, scope.userId]
    );
    return result.rows.map(fromRow);
  }

  async upsert(record: GatewayRunRecord): Promise<void> {
    const request = durableGatewayRequest(record.request);
    await query(
      `INSERT INTO gateway_runs (
         workspace_id, user_id, idempotency_key, run_id, goal_id, thread_id, ask_id, status, request
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (workspace_id, user_id, idempotency_key) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         goal_id = COALESCE(EXCLUDED.goal_id, gateway_runs.goal_id),
         thread_id = COALESCE(EXCLUDED.thread_id, gateway_runs.thread_id),
         ask_id = COALESCE(EXCLUDED.ask_id, gateway_runs.ask_id),
         status = EXCLUDED.status,
         request = EXCLUDED.request,
         updated_at = NOW()`,
      [
        record.workspaceId,
        record.userId,
        record.idempotencyKey,
        record.runId,
        record.goalId ?? null,
        record.threadId ?? null,
        record.askId ?? null,
        record.status,
        JSON.stringify(request),
      ]
    );
  }
}

function fromRow(row: GatewayRunRow): GatewayRunRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    ...(row.goal_id ? { goalId: row.goal_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.ask_id ? { askId: row.ask_id } : {}),
    status: row.status,
    request: durableGatewayRequest(row.request),
  };
}
