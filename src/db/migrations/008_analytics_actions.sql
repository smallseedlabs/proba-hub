-- Analytics and action bot (Hub side).
-- Campaigns the owner registered for review, coalesced evaluator reviews, and
-- evaluator dry-run proposals awaiting an explicit owner decision. A proposal
-- is evidence only until the owner approves it; nothing here grants spend.
-- Also: operator-approved creative/targeting on a goal, forwarded to the
-- gateway for Reddit post creation. No default landing URL.

CREATE TABLE IF NOT EXISTS analytics_campaigns (
  workspace_id VARCHAR(256) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proba_campaign_id VARCHAR(128) NOT NULL,
  goal_id UUID NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL,
  platform VARCHAR(16) NOT NULL,
  account_id VARCHAR(128),
  provider_campaign_id VARCHAR(128),
  current_daily_budget NUMERIC,
  currency CHAR(3),
  review_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_id, proba_campaign_id)
);

CREATE TABLE IF NOT EXISTS analytics_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id VARCHAR(256) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proba_campaign_id VARCHAR(128) NOT NULL,
  window_key VARCHAR(64) NOT NULL,
  intent VARCHAR(16) NOT NULL,
  trigger VARCHAR(16) NOT NULL,
  idempotency_key UUID NOT NULL,
  run_id UUID,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  outcome VARCHAR(32),
  decision_id UUID,
  summary JSONB,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id, proba_campaign_id, window_key, intent)
);

CREATE INDEX IF NOT EXISTS analytics_reviews_campaign_idx
  ON analytics_reviews (workspace_id, user_id, proba_campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS analytics_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES analytics_reviews(id) ON DELETE CASCADE,
  workspace_id VARCHAR(256) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proba_campaign_id VARCHAR(128) NOT NULL,
  goal_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  platform VARCHAR(16) NOT NULL,
  account_id VARCHAR(128),
  decision_id UUID NOT NULL,
  verb VARCHAR(64) NOT NULL,
  args JSONB NOT NULL,
  args_hash VARCHAR(128) NOT NULL,
  reason TEXT,
  metrics JSONB,
  review_window_until TIMESTAMPTZ NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  action_run_id UUID,
  action_idempotency_key UUID,
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_proposals_user_idx
  ON analytics_proposals (workspace_id, user_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS analytics_proposals_one_pending_uq
  ON analytics_proposals (workspace_id, user_id, proba_campaign_id) WHERE status = 'pending';

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS approved_creative JSONB,
  ADD COLUMN IF NOT EXISTS approved_targeting JSONB,
  ADD COLUMN IF NOT EXISTS creative_approved_at TIMESTAMPTZ;

COMMENT ON COLUMN goals.approved_creative IS
  'Operator-approved Reddit creative {type, headline, body?, mediaUrl?, callToAction?}; never model text';
COMMENT ON COLUMN goals.approved_targeting IS
  'Operator-approved Reddit targeting forwarded to Ads (Ads validates the shape)';
