-- Each participant uploads its own trusted native `full_squad_setup` rows for
-- a PvP battle. The Worker stores them opaquely (size-capped JSON) so the
-- other companion can build the native `/check` roster; NULL until uploaded.
ALTER TABLE battle_participants ADD COLUMN native_squad TEXT;
