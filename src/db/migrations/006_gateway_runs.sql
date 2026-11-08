-- Durable Hub binding for gateway runs. Resume/reject/cancel look up the original
-- command + idempotencyKey + askId by workspace/user/goal/thread/run, not "last run
-- per user". Tokens and resume payloads are never stored.
CREATE TABLE IF NOT EXISTS gateway_runs (
  workspace_id VARCHAR(256) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key UUID NOT NULL,
  run_id UUID NOT NULL,
  goal_id UUID,
  thread_id UUID,
  ask_id UUID,
  status VARCHAR(32) NOT NULL,
  request JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_runs_run_id_uq ON gateway_runs (run_id);
CREATE UNIQUE INDEX IF NOT EXISTS gateway_runs_ask_uq ON gateway_runs (workspace_id, user_id, ask_id) WHERE ask_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_runs_active_idx ON gateway_runs (workspace_id, user_id, status);
