-- Password sign-in. Reuses the existing users and sessions tables.
-- password_hash is nullable: accounts created through the development-only
-- /dev/login have no password and cannot sign in with one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Sessions now store a SHA-256 of the bearer token. Rows written by earlier
-- versions stored raw tokens and can never match a hash, so drop them.
DELETE FROM sessions WHERE token_hash !~ '^[0-9a-f]{64}$';

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_sessions_token_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);

-- Case-insensitive lookups for sign-in.
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));
