-- Campaign reviewer: the brain picks when to look again (next_check_at + reason), within tighten-only bounds.
ALTER TABLE analytics_campaigns ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;
ALTER TABLE analytics_campaigns ADD COLUMN IF NOT EXISTS next_check_reason TEXT;
ALTER TABLE analytics_campaigns ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ;
ALTER TABLE analytics_campaigns ADD COLUMN IF NOT EXISTS checkpoints_done TEXT[] NOT NULL DEFAULT '{}';
-- Wake reason waiting for the next tick (metrics anomaly, disapproval, spend pace, budget nearly gone, off track).
ALTER TABLE analytics_campaigns ADD COLUMN IF NOT EXISTS wake_event VARCHAR(64);

CREATE INDEX IF NOT EXISTS analytics_campaigns_next_check_idx
  ON analytics_campaigns (workspace_id, next_check_at) WHERE review_enabled = TRUE;
