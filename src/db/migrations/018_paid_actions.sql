-- H3-05: Persist paid gateway actions (media generation, paid research, LLM calls)
-- with spend-gate justification and evidence for per-goal cost accounting.
CREATE TABLE IF NOT EXISTS paid_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id VARCHAR(128) NOT NULL,
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(64) NOT NULL,
  estimated_cost_usd NUMERIC(12, 4) NOT NULL DEFAULT 0,
  justification VARCHAR(64) NOT NULL,
  evidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paid_actions_goal
  ON paid_actions(goal_id, created_at DESC);
