ALTER TABLE battles ADD COLUMN origin TEXT NOT NULL DEFAULT 'public';
ALTER TABLE battles ADD COLUMN room_id TEXT;
ALTER TABLE battles ADD COLUMN room_match_id TEXT;
ALTER TABLE battles ADD COLUMN private_economy_policy TEXT;
ALTER TABLE battles ADD COLUMN battle_entitlement TEXT;
ALTER TABLE battles ADD COLUMN private_cpu_policy TEXT;
CREATE UNIQUE INDEX battles_by_room_match ON battles(room_match_id) WHERE room_match_id IS NOT NULL;
