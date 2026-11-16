CREATE TABLE contests (
  id text PRIMARY KEY,
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'closed'))
);

CREATE TABLE candidates (
  contest_id text NOT NULL REFERENCES contests (id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  display_name text,
  access_code_hash text NOT NULL,
  PRIMARY KEY (contest_id, candidate_id)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  contest_id text NOT NULL,
  candidate_id text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  extension_status text NOT NULL DEFAULT 'connected',
  agent_status text NOT NULL DEFAULT 'not_paired',
  extension_last_seen_at timestamptz,
  agent_last_seen_at timestamptz,
  FOREIGN KEY (contest_id, candidate_id)
    REFERENCES candidates (contest_id, candidate_id) ON DELETE CASCADE
);
CREATE INDEX sessions_contest_idx ON sessions (contest_id, started_at DESC);
CREATE INDEX sessions_candidate_idx ON sessions (contest_id, candidate_id);
CREATE INDEX sessions_active_idx ON sessions (ended_at) WHERE ended_at IS NULL;

CREATE TABLE session_tokens (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('extension', 'windows-agent')),
  expires_at timestamptz NOT NULL
);

CREATE TABLE pairing_codes (
  code_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE events (
  event_id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  contest_id text NOT NULL,
  type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('extension', 'windows-agent', 'server')),
  severity text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX events_session_time_idx ON events (session_id, occurred_at);
CREATE INDEX events_contest_time_idx ON events (contest_id, occurred_at);
CREATE INDEX events_contest_severity_idx ON events (contest_id, severity);

CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'viewer'))
);

CREATE TABLE admin_tokens (
  token_hash text PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

CREATE TABLE admin_audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_id uuid REFERENCES admin_users (id) ON DELETE SET NULL,
  action text NOT NULL,
  target text,
  at timestamptz NOT NULL
);

-- The API is the only database client. With RLS on and no policies, hosted
-- PostgreSQL roles such as Supabase's anon role cannot read these tables.
ALTER TABLE contests ENABLE ROW LEVEL SECURITY;
ALTER TABLE candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;
