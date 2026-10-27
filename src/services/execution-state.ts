import type { PoolClient } from 'pg';
import type { ControlAction } from '@smallseedlabs/proba-protocol';
import { query } from '../db/client.js';

/**
 * Whether a workspace may act. `paused` (control: pause) and `stopped` (control: kill, the emergency stop)
 * refuse every command except `control` until `control: resume`. The Hub has one workspace per user.
 */
export type ExecutionState = 'running' | 'paused' | 'stopped';

/** The state a control action leads to. A pause never lifts an emergency stop: only resume does. */
export function nextExecutionState(current: ExecutionState, action: ControlAction): ExecutionState {
  switch (action) {
    case 'kill':
      return 'stopped';
    case 'pause':
      return current === 'stopped' ? 'stopped' : 'paused';
    case 'resume':
      return 'running';
    default:
      return current;
  }
}

/**
 * Read the state and lock its row for the rest of the transaction. Commands take a shared lock, control commands
 * an exclusive one: a command that passed the gate finishes before a pause/kill applies, and a command that starts
 * after one sees it. The row is created first, otherwise there would be nothing to lock for a workspace that never
 * paused.
 */
export async function lockExecutionState(
  client: PoolClient,
  userId: string,
  mode: 'share' | 'update'
): Promise<ExecutionState> {
  await client.query('INSERT INTO execution_state (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const result = await client.query<{ state: ExecutionState }>(
    `SELECT state FROM execution_state WHERE user_id = $1 FOR ${mode === 'update' ? 'UPDATE' : 'SHARE'}`,
    [userId]
  );
  return result.rows[0]?.state ?? 'running';
}

/** Persist the state (the caller holds the exclusive lock from lockExecutionState). */
export async function saveExecutionState(
  client: PoolClient,
  userId: string,
  state: ExecutionState,
  commandId: string
): Promise<void> {
  await client.query(
    'UPDATE execution_state SET state = $1, changed_by_command = $2, updated_at = NOW() WHERE user_id = $3',
    [state, commandId, userId]
  );
}

/** Current state of a workspace outside any transaction (no row means running). */
export async function getExecutionState(userId: string): Promise<ExecutionState> {
  const result = await query<{ state: ExecutionState }>('SELECT state FROM execution_state WHERE user_id = $1', [userId]);
  return result.rows[0]?.state ?? 'running';
}
