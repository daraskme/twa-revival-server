ALTER TABLE battles ADD COLUMN room_config TEXT;
ALTER TABLE room_directory ADD COLUMN room_title TEXT NOT NULL DEFAULT 'Private Battle';
ALTER TABLE room_directory ADD COLUMN battle_length INTEGER NOT NULL DEFAULT 3600;
