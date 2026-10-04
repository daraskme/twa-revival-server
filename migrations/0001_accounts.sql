CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'banned')),
  commander_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE invitations (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER,
  CHECK ((used_by IS NULL) = (used_at IS NULL))
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
-- Tracks the creator's room lease, not ownership received through a transfer.
CREATE TABLE room_ownership (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  room_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
