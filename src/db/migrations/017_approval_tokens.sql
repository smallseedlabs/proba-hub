-- Single-use, short-lived (10-minute) approval tokens minted on explicit user
-- spend-approval gestures and consumed atomically on answer_ask approve.
CREATE TABLE IF NOT EXISTS approval_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ask_id UUID NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  gesture_at TIMESTAMPTZ NOT NULL,
  nonce VARCHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_tokens_ask_user
  ON approval_tokens(ask_id, user_id);
