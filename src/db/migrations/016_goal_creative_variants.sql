-- Per-platform, versioned creative variants per Goal (v1 -> v2 A/B test or replacement).
CREATE TABLE IF NOT EXISTS goal_creative_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  parent_variant_id UUID REFERENCES goal_creative_variants(id) ON DELETE SET NULL,
  proba_campaign_id UUID,
  provider_ad_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  mode TEXT NOT NULL DEFAULT 'initial',
  change_reason TEXT,
  creative_json JSONB NOT NULL,
  targeting_json JSONB,
  metrics_json JSONB NOT NULL DEFAULT '{"spend":0,"impressions":0,"clicks":0,"conversions":0}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS goal_creative_variants_goal_idx
  ON goal_creative_variants (goal_id, platform, version DESC);
