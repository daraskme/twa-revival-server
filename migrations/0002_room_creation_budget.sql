-- Durable per-account creation budget, independent of room owner transfers.
CREATE TABLE room_creation_budget (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  count INTEGER NOT NULL CHECK(count > 0 AND count <= 20),
  resets_at INTEGER NOT NULL
);
