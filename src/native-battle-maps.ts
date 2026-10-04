import { ApiError } from './http';
import mapManifest from '../data/native_battle_maps.json';

export type BattleRuleset = 'territory' | 'annihilation';
export type NativeBattleMapKey = string;
export interface NativeBattleMapRecord {
  key: NativeBattleMapKey;
  ruleset: BattleRuleset;
  terrain: string;
}

type Manifest = { schema_version: 1; maps: NativeBattleMapRecord[];
  legacy_defaults: Record<BattleRuleset, NativeBattleMapKey> };

function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_battle_map_manifest');
  const document = value as Record<string, unknown>;
  if (document.schema_version !== 1 || !Array.isArray(document.maps) || document.maps.length === 0) {
    throw new Error('invalid_battle_map_manifest');
  }
  const seen = new Set<string>();
  const maps = document.maps.map((row): NativeBattleMapRecord => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid_battle_map_manifest');
    const candidate = row as Record<string, unknown>;
    if (Object.keys(candidate).length !== 3 || typeof candidate.key !== 'string' ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(candidate.key) || seen.has(candidate.key) ||
        (candidate.ruleset !== 'territory' && candidate.ruleset !== 'annihilation') ||
        typeof candidate.terrain !== 'string' || !candidate.terrain) {
      throw new Error('invalid_battle_map_manifest');
    }
    seen.add(candidate.key);
    return { key: candidate.key, ruleset: candidate.ruleset, terrain: candidate.terrain };
  });
  const defaults = document.legacy_defaults;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('invalid_battle_map_manifest');
  const values = defaults as Record<string, unknown>;
  if (Object.keys(values).length !== 2) throw new Error('invalid_battle_map_manifest');
  for (const ruleset of ['territory', 'annihilation'] as const) {
    const key = values[ruleset];
    if (typeof key !== 'string' || !maps.some(map => map.ruleset === ruleset && map.key === key)) {
      throw new Error('invalid_battle_map_manifest');
    }
  }
  return { schema_version: 1, maps, legacy_defaults: {
    territory: values.territory as string, annihilation: values.annihilation as string,
  } };
}

const MANIFEST = parseManifest(mapManifest);
const LEGACY_DEFAULTS = MANIFEST.legacy_defaults;

export function mapsForRuleset(ruleset: BattleRuleset): readonly NativeBattleMapRecord[] {
  return MANIFEST.maps.filter(map => map.ruleset === ruleset);
}

export function isNativeBattleMapKey(value: unknown): value is NativeBattleMapKey {
  return typeof value === 'string' && MANIFEST.maps.some(map => map.key === value);
}

export function isMapKeyForRuleset(value: unknown, ruleset: BattleRuleset): value is NativeBattleMapKey {
  return isNativeBattleMapKey(value) && mapsForRuleset(ruleset).some(map => map.key === value);
}

export function rulesetForMapKey(value: unknown): BattleRuleset | null {
  const map = MANIFEST.maps.find(candidate => candidate.key === value);
  return map?.ruleset ?? null;
}

/** Historic deterministic map for old allocations and omitted legacy fields. */
export function mapKeyForRuleset(ruleset: BattleRuleset): NativeBattleMapKey {
  const key = LEGACY_DEFAULTS[ruleset];
  if (!isMapKeyForRuleset(key, ruleset)) throw new Error('invalid_battle_map_manifest');
  return key;
}

/** Uniformly choose once; callers must persist this exact key. */
export function chooseMapKeyForRuleset(ruleset: BattleRuleset, randomUint32?: () => number): NativeBattleMapKey {
  const pool = mapsForRuleset(ruleset);
  if (pool.length === 0) throw new ApiError(503, 'battle_map_pool_unavailable');
  const next = randomUint32 ?? (() => {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return bytes[0];
  });
  const limit = Math.floor(0x1_0000_0000 / pool.length) * pool.length;
  let value: number;
  do { value = next() >>> 0; } while (value >= limit);
  return pool[value % pool.length].key;
}
