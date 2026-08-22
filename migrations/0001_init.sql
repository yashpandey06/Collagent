-- Collagent control-plane schema. Events are the source of truth; rooms.meta
-- carries the durable room state (participants, agent sessions, join key) as
-- one document, with agent_sessions denormalized for queryability.

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  added_at     BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS rooms (
  code         TEXT PRIMARY KEY,
  workspace_id TEXT,
  meta         JSONB NOT NULL,
  updated_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_by_workspace ON rooms (workspace_id);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id                TEXT PRIMARY KEY,
  room_code         TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  runtime           TEXT,
  adapter_type      TEXT,
  status            TEXT,
  host_id           TEXT,
  native_session_id TEXT,
  created_at        BIGINT,
  attached_at       BIGINT,
  detached_at       BIGINT
);
CREATE INDEX IF NOT EXISTS agent_sessions_by_room ON agent_sessions (room_code);

CREATE TABLE IF NOT EXISTS events (
  code           TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  ts             BIGINT,
  kind           TEXT,
  agent_id       TEXT,
  turn_id        TEXT,
  participant_id TEXT,
  json           JSONB NOT NULL,
  PRIMARY KEY (code, seq)
);
CREATE INDEX IF NOT EXISTS events_by_kind        ON events (code, kind);
CREATE INDEX IF NOT EXISTS events_by_turn        ON events (code, turn_id);
CREATE INDEX IF NOT EXISTS events_by_agent       ON events (code, agent_id);
CREATE INDEX IF NOT EXISTS events_by_participant ON events (code, participant_id);
CREATE INDEX IF NOT EXISTS events_by_ts          ON events (ts);

CREATE TABLE IF NOT EXISTS turns (
  room_code          TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  agent_session_id   TEXT,
  agent_id           TEXT,
  ok                 BOOLEAN,
  duration_ms        BIGINT,
  tool_calls         INTEGER,
  provider           TEXT,
  runtime            TEXT,
  model              TEXT,
  input_tokens       BIGINT,
  output_tokens      BIGINT,
  cache_read_tokens  BIGINT,
  cache_write_tokens BIGINT,
  provider_cost      DOUBLE PRECISION,
  currency           TEXT,
  completed_at       BIGINT,
  PRIMARY KEY (room_code, turn_id)
);
CREATE INDEX IF NOT EXISTS turns_by_agent ON turns (room_code, agent_id);
