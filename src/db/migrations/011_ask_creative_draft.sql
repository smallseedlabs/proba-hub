-- Brain-drafted Reddit post shown on an action_approval ask (gateway verb creative.draft_post).
-- Approving the ask (optionally with edits) copies it into goals.approved_creative; nothing else reads it.
ALTER TABLE asks ADD COLUMN IF NOT EXISTS creative_draft JSONB;
COMMENT ON COLUMN asks.creative_draft IS
  'Gateway-checked creative.draft_post draft for this approval card. Saved to goals.approved_creative only on operator approve.';
