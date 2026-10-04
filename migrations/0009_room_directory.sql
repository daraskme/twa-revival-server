CREATE TABLE room_directory (
  room_id TEXT PRIMARY KEY,
  owner_display_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('pve', 'pvp')),
  ruleset TEXT NOT NULL CHECK(ruleset IN ('territory', 'annihilation')),
  visibility TEXT NOT NULL CHECK(visibility IN ('listed', 'unlisted')),
  status TEXT NOT NULL,
  members INTEGER NOT NULL CHECK(members >= 0 AND members <= 20),
  max_players INTEGER NOT NULL CHECK(max_players >= 1 AND max_players <= 20),
  ai_opponents INTEGER NOT NULL CHECK(ai_opponents >= 0 AND ai_opponents <= 10),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX room_directory_listing ON room_directory(visibility, status, expires_at, created_at, room_id);
