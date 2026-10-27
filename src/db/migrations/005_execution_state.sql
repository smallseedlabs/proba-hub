-- Execution state of a workspace (the Hub models one workspace per user): running, paused (control: pause)
-- or stopped (control: kill, the emergency stop). Paused and stopped refuse every command except `control`
-- until `control: resume`. No row means running.
CREATE TABLE IF NOT EXISTS execution_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state VARCHAR(16) NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'paused', 'stopped')),
  changed_by_command UUID REFERENCES commands(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
