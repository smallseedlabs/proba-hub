ALTER TABLE creative_assets
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS visual_style TEXT,
  ADD COLUMN IF NOT EXISTS brand_elements TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS use_cases TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS curation_status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (curation_status IN ('approved', 'candidate', 'do_not_use')),
  ADD COLUMN IF NOT EXISTS parent_asset_id TEXT,
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS times_used INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS performance_summary JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS creative_assets_tags_gin_idx
  ON creative_assets USING GIN (tags);

CREATE INDEX IF NOT EXISTS creative_assets_use_cases_gin_idx
  ON creative_assets USING GIN (use_cases);

CREATE INDEX IF NOT EXISTS creative_assets_curation_idx
  ON creative_assets (workspace_id, curation_status, created_at DESC);
