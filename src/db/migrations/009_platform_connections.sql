-- Platform connections (credential broker). One connection per workspace and provider
-- (reddit first; meta/google/microsoft/linkedin later as adapters). The provider refresh
-- token is stored ONLY here, encrypted at rest (AES-256-GCM, key from a mounted file,
-- additional data binds it to workspace/provider/connection). Access tokens are never
-- stored; they are minted on demand and cached in memory until shortly before expiry.

CREATE TABLE IF NOT EXISTS platform_connections (
  id UUID PRIMARY KEY,
  workspace_id VARCHAR(256) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  -- pending_account: OAuth done, the owner has not picked an ad account yet
  -- connected: ready; needs_reconnect: the provider refused the refresh token
  status VARCHAR(24) NOT NULL,
  connected_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_account_id VARCHAR(128),
  provider_account_name VARCHAR(256),
  available_accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  refresh_token_enc TEXT NOT NULL,
  key_id VARCHAR(64) NOT NULL,
  last_error_code VARCHAR(64),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account_selected_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_connections_status CHECK (status IN ('pending_account', 'connected', 'needs_reconnect'))
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_connections_workspace_provider
  ON platform_connections (workspace_id, provider);

-- OAuth CSRF state: only a SHA-256 of the random state is stored; single use, short-lived,
-- bound to the signed-in user, the workspace and the provider.
CREATE TABLE IF NOT EXISTS platform_oauth_states (
  state_hash CHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(256) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS platform_oauth_states_expiry ON platform_oauth_states (expires_at);
