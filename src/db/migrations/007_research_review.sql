-- Operator-entered landing URL (create_goal.userSuppliedInput) and the
-- displayed research_review artifact bound to an ask. Hub copies these onto
-- gateway runs; it never takes a URL from model/tool text. No default URL.

ALTER TABLE goals
  ADD COLUMN IF NOT EXISTS user_supplied_input JSONB,
  ADD COLUMN IF NOT EXISTS input_revision VARCHAR(128);

ALTER TABLE asks
  ADD COLUMN IF NOT EXISTS research JSONB;

COMMENT ON COLUMN goals.user_supplied_input IS
  'Original operator userSuppliedInput {landingPageUrl}; never a model-invented URL';
COMMENT ON COLUMN goals.input_revision IS
  'Opaque gateway artifact inputRevision for the current operator URL; cleared on edit';
COMMENT ON COLUMN asks.research IS
  'Displayed research_review payload (findings/sources/assumptions/unknowns + artifact binding)';
