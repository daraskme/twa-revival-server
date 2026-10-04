-- Cloud copy of the hangar profile. `blob` is opaque JSON owned by the
-- companion; the Worker only enforces the monotonic `saved` watermark, the
-- size ceiling and per-account ownership.
CREATE TABLE profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  schema_version INTEGER NOT NULL CHECK(schema_version >= 0),
  saved INTEGER NOT NULL CHECK(saved >= 0),
  blob TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0 AND size <= 524288),
  updated_at INTEGER NOT NULL
);
