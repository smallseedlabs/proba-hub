-- A goal id the Hub has pre-allocated for a create_goal command whose brain step is still running.
-- The goals row is only inserted after the brain step, but the Hub has already signed a context-reader
-- assertion for (user, goal). The context bridge asks POST /internal/authorize for live ownership; a
-- reservation lets that check answer for the pending goal of the same user, and nothing else.
-- Committed outside the command transaction so the bridge's request (another connection) can see it.
-- Deleted when the goal row is inserted; expired rows are ignored and pruned.
CREATE TABLE IF NOT EXISTS goal_reservations (
  goal_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS goal_reservations_expires_idx ON goal_reservations (expires_at);
