CREATE TABLE user_loadouts (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  commander_id TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_at INTEGER NOT NULL
);
