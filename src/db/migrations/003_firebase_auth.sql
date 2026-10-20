-- Sign-in moves to Firebase Authentication. Users are keyed by their Firebase
-- uid; the Hub keeps issuing its own revocable session tokens (sessions table).
ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sign_in_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);

-- Hub-managed passwords are gone. Sign out every session that came from a
-- password sign-in, then drop the hashes. Existing users keep their data and
-- are linked to Firebase on their first sign-in with a verified email.
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE password_hash IS NOT NULL);
ALTER TABLE users DROP COLUMN IF EXISTS password_hash;
