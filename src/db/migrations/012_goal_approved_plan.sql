-- Operator-approved plan from the plan card: success metric + target, platform, duration and the reasons
-- Proba chose them. Read by checkpoint reports and the campaign reviewer to judge progress against the goal.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS approved_plan JSONB;
COMMENT ON COLUMN goals.approved_plan IS
  'Approved plan card defaults {platform, successMetric, successTarget?, durationDays?, reasons}. Written only on operator approval.';
