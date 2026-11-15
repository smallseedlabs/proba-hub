CREATE TABLE IF NOT EXISTS creative_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  goal_id UUID REFERENCES goals(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  url TEXT NOT NULL,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds NUMERIC,
  aspect_ratio TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  prompt TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS creative_assets_workspace_created_idx
  ON creative_assets (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS creative_assets_goal_created_idx
  ON creative_assets (goal_id, created_at DESC);
