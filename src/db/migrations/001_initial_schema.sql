-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- Threads table
CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_threads_user_id ON threads(user_id);
CREATE INDEX idx_threads_created_at ON threads(created_at DESC);

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  source VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_created_at ON messages(created_at DESC);

-- UI payloads table (normalized server UI)
CREATE TABLE IF NOT EXISTS ui_payloads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component VARCHAR(100) NOT NULL,
  version VARCHAR(20) NOT NULL,
  props JSONB NOT NULL,
  actions JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Asks table
CREATE TABLE IF NOT EXISTS asks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  ask_type VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  blocking BOOLEAN NOT NULL DEFAULT true,
  risk VARCHAR(20) NOT NULL,
  cost_effect JSONB,
  questions JSONB NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  expires_at TIMESTAMPTZ,
  on_expire VARCHAR(50),
  answered_at TIMESTAMPTZ,
  answer JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_asks_thread_id ON asks(thread_id);
CREATE INDEX idx_asks_status ON asks(status);
CREATE INDEX idx_asks_expires_at ON asks(expires_at) WHERE expires_at IS NOT NULL;

-- Ask questions table (max 3 per ask)
CREATE TABLE IF NOT EXISTS ask_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ask_id UUID NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
  question_id VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL,
  label TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  options JSONB,
  constraints JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ask_id, question_id)
);

CREATE INDEX idx_ask_questions_ask_id ON ask_questions(ask_id);

-- Ask answers table
CREATE TABLE IF NOT EXISTS ask_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ask_id UUID NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
  question_id VARCHAR(100) NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ask_id, question_id)
);

CREATE INDEX idx_ask_answers_ask_id ON ask_answers(ask_id);

-- Commands table (idempotency)
CREATE TABLE IF NOT EXISTS commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_msg_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL,
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'accepted',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, client_msg_id)
);

CREATE INDEX idx_commands_user_id ON commands(user_id);
CREATE INDEX idx_commands_client_msg_id ON commands(client_msg_id);
CREATE INDEX idx_commands_thread_id ON commands(thread_id);

-- Events table (append-only, sequential per user)
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  type VARCHAR(50) NOT NULL,
  thread_id UUID REFERENCES threads(id) ON DELETE SET NULL,
  payload JSONB NOT NULL,
  ui_payload_id UUID REFERENCES ui_payloads(id) ON DELETE SET NULL,
  fallback_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, seq)
);

CREATE INDEX idx_events_user_id_seq ON events(user_id, seq);
CREATE INDEX idx_events_thread_id ON events(thread_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_created_at ON events(created_at DESC);

-- Sequence counter for events per user
CREATE TABLE IF NOT EXISTS event_sequences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next_seq BIGINT NOT NULL DEFAULT 1
);

-- Inbox items table
CREATE TABLE IF NOT EXISTS inbox_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES threads(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  priority VARCHAR(20) NOT NULL DEFAULT 'normal',
  status VARCHAR(50) NOT NULL DEFAULT 'unread',
  related_ask_id UUID REFERENCES asks(id) ON DELETE SET NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inbox_items_user_id ON inbox_items(user_id);
CREATE INDEX idx_inbox_items_status ON inbox_items(status);
CREATE INDEX idx_inbox_items_created_at ON inbox_items(created_at DESC);

-- Thread summaries table
CREATE TABLE IF NOT EXISTS thread_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID UNIQUE NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  summary TEXT,
  last_message_at TIMESTAMPTZ,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_thread_summaries_thread_id ON thread_summaries(thread_id);

-- Read cursors table
CREATE TABLE IF NOT EXISTS read_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES threads(id) ON DELETE CASCADE,
  last_read_seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, thread_id)
);

CREATE INDEX idx_read_cursors_user_id ON read_cursors(user_id);
CREATE INDEX idx_read_cursors_thread_id ON read_cursors(thread_id);

-- Sessions table (for auth)
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Outbox table (for pub/sub relay)
CREATE TABLE IF NOT EXISTS outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  published BOOLEAN NOT NULL DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_published ON outbox(published);
CREATE INDEX idx_outbox_user_id ON outbox(user_id);
CREATE INDEX idx_outbox_created_at ON outbox(created_at);

-- Goals table
CREATE TABLE IF NOT EXISTS goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT,
  constraints JSONB,
  budget JSONB,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  progress JSONB,
  metrics JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_goals_user_id ON goals(user_id);
CREATE INDEX idx_goals_thread_id ON goals(thread_id);
CREATE INDEX idx_goals_status ON goals(status);

-- Function to get next event sequence
CREATE OR REPLACE FUNCTION get_next_event_seq(p_user_id UUID)
RETURNS BIGINT AS $$
DECLARE
  next_val BIGINT;
BEGIN
  INSERT INTO event_sequences (user_id, next_seq)
  VALUES (p_user_id, 2)
  ON CONFLICT (user_id) DO UPDATE
  SET next_seq = event_sequences.next_seq + 1
  RETURNING event_sequences.next_seq - 1 INTO next_val;
  
  RETURN next_val;
END;
$$ LANGUAGE plpgsql;

-- Update timestamps trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_threads_updated_at BEFORE UPDATE ON threads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_inbox_items_updated_at BEFORE UPDATE ON inbox_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_thread_summaries_updated_at BEFORE UPDATE ON thread_summaries
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_goals_updated_at BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_read_cursors_updated_at BEFORE UPDATE ON read_cursors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
