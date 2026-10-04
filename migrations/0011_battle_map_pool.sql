-- Replace the Alps-only map column without rebuilding the parent table.  The
-- old column is renamed only long enough to copy its values into an
-- unconstrained column, then dropped.  Child tables and all existing indexes
-- therefore remain attached to the same battles table throughout the D1
-- migration; foreign-key enforcement stays enabled.
ALTER TABLE battles RENAME COLUMN map_key TO legacy_map_key;
ALTER TABLE battles ADD COLUMN map_key TEXT NOT NULL DEFAULT 'alps';
UPDATE battles SET map_key = legacy_map_key;
ALTER TABLE battles DROP COLUMN legacy_map_key;
