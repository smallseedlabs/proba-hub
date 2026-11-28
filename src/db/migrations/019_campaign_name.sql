ALTER TABLE analytics_campaigns
  ADD COLUMN IF NOT EXISTS campaign_name VARCHAR(256);
