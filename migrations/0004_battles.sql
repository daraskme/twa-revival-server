-- Server-authoritative battle lifecycle. A battle freezes its roster, map and
-- reward policy at creation; settlement is per participant and exactly once.
CREATE TABLE battles (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK(mode IN ('pve', 'pvp')),
  ruleset TEXT NOT NULL CHECK(ruleset IN ('territory', 'annihilation')),
  map_key TEXT NOT NULL CHECK(map_key IN ('alps_territory', 'alps')),
  status TEXT NOT NULL CHECK(status IN ('created', 'settled', 'disputed')),
  -- One matchmaking assignment can produce at most one battle.
  assignment_id TEXT UNIQUE,
  reward_policy TEXT NOT NULL,
  winner_team INTEGER CHECK(winner_team IN (0, 1)),
  winner_decided INTEGER NOT NULL DEFAULT 0 CHECK(winner_decided IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX battles_by_created ON battles(created_at);
CREATE INDEX battles_by_creator ON battles(created_by, created_at);

-- Frozen seats. `player_id` is the 1-based native player ordinal and `seat`
-- its 0-based slot index; both are reused by relay tickets.
CREATE TABLE battle_participants (
  battle_id TEXT NOT NULL REFERENCES battles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  team INTEGER NOT NULL CHECK(team IN (0, 1)),
  player_id INTEGER NOT NULL CHECK(player_id >= 1),
  seat INTEGER NOT NULL CHECK(seat >= 0),
  display_name TEXT NOT NULL,
  loadout TEXT NOT NULL,
  PRIMARY KEY (battle_id, user_id)
);
CREATE INDEX battle_participants_by_user ON battle_participants(user_id);

-- One settlement per participant. `request_hash` makes a retry replayable and
-- a changed submission detectable without storing the raw report twice.
CREATE TABLE battle_settlements (
  battle_id TEXT NOT NULL REFERENCES battles(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK(result IN ('victory', 'defeat', 'draw', 'aborted')),
  was_afk INTEGER NOT NULL CHECK(was_afk IN (0, 1)),
  base TEXT NOT NULL,
  awarded TEXT NOT NULL,
  result_rows TEXT NOT NULL,
  report_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  implied_winner_team INTEGER CHECK(implied_winner_team IN (0, 1)),
  settled_at INTEGER NOT NULL,
  PRIMARY KEY (battle_id, user_id)
);
CREATE INDEX battle_settlements_by_user ON battle_settlements(user_id, settled_at);
