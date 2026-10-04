-- Immutable server-authored PvP render policy. Human participants remain the
-- only battle_participants/auth/relay/reward rows; NULL marks legacy/PvE.
ALTER TABLE battles ADD COLUMN roster_policy TEXT;
