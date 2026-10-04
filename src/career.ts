import native from '../data/native-loadouts.json';
import { ApiError, canonicalJson, integer, json, sha256Hex } from './http';
import type { Actor, Env } from './types';

/** Read-only projection of completed D1 settlements. Neither totals nor result
 * rows are accepted by this API. Stored native counters remain client reports;
 * the server validates their binding, not the simulation that produced them. */
export const CAREER_SOURCE = 'cloudflare-d1-settled-native-reports';
export const MAX_CAREER_BATTLES = 10_000;
export const MAX_CAREER_READ_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 200;
const MAX_COUNTER = 2 ** 31 - 1;
const MAX_CURRENCY = 2n ** 64n - 1n;
const REWARD_FIELDS = ['free_xp_cents', 'unit_xp_cents', 'silver_cents'] as const;
type RewardField = typeof REWARD_FIELDS[number];
type Rewards = Record<RewardField, string | null>;
type Outcome = 'victory' | 'defeat' | 'draw';
type Mode = 'pve' | 'pvp';
const commanders = new Map(native.commanders.map(value => [value.id, value]));
const unitsById = new Map(native.units.map(value => [value.id, value]));
const unitsByKey = new Map(native.units.map(value => [value.key, value]));
const nativeOutcomes: Record<string, Outcome> = {
  result_close_victory: 'victory', result_decisive_victory: 'victory',
  result_heroic_victory: 'victory', result_pyrrhic_victory: 'victory', result_victory: 'victory',
  result_close_defeat: 'defeat', result_crushing_defeat: 'defeat',
  result_decisive_defeat: 'defeat', result_valiant_defeat: 'defeat', result_draw: 'draw',
};

export interface CareerRow {
  battle_id: string; user_id: string; mode: string; origin: string; status: string;
  map_key: string; loadout: string; result: string; was_afk: number;
  awarded: string; result_rows: string; settled_at: number;
  team: number; winner_decided: number; winner_team: number | null; implied_winner_team: number | null;
}
interface UnitResult { unit_key: string; kills: number | null }
interface AggregateRecord { outcome: Outcome; kills: number | null; rewards: Rewards }
export interface CareerRecord extends AggregateRecord {
  battleId: string; userId: string; mode: Mode; commander: string; settledAt: number;
  units: UnitResult[];
}

function unreadable(): never { throw new ApiError(503, 'career_unreadable'); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parse(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}
function emptyRewards(): Rewards {
  return { free_xp_cents: null, unit_xp_cents: null, silver_cents: null };
}
function currency(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    value = String(value);
  }
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return null;
  return BigInt(value) <= MAX_CURRENCY ? value : null;
}
function sumCurrency(values: (string | null)[]): string | null {
  if (values.some(value => value === null)) return null;
  const total = values.reduce<bigint>((sum, value) => sum + BigInt(value!), 0n);
  return total <= MAX_CURRENCY ? total.toString() : null;
}

function rewards(awarded: string, frozenItems: string[]): Rewards {
  const receipt = parse(awarded);
  if (!record(receipt) || receipt.authority !== 'server' || !record(receipt.awarded)) return emptyRewards();
  const amounts = receipt.awarded;
  let unitXp: string | null = null;
  if (Array.isArray(amounts.unitXp) && amounts.unitXp.length <= 3) {
    const seen = new Set<string>();
    const amountsByUnit: (string | null)[] = [];
    let valid = true;
    for (const entry of amounts.unitXp) {
      if (!record(entry) || typeof entry.unitId !== 'string' || !frozenItems.includes(entry.unitId)
          || seen.has(entry.unitId)) { valid = false; break; }
      seen.add(entry.unitId);
      amountsByUnit.push(currency(entry.xp));
    }
    if (valid) unitXp = sumCurrency(amountsByUnit);
  }
  return { free_xp_cents: currency(amounts.freeXp), unit_xp_cents: unitXp,
    silver_cents: currency(amounts.silver) };
}

/** The exact item binding comes from the key/catalog/frozen multiset. Old D1
 * rows have already passed through JSON.parse and may have rounded a uint64
 * numeric unit_id. That rounded Number is never used to identify a unit. */
function compatibleReportedItem(value: unknown, itemId: string): boolean {
  if (typeof value === 'string') return /^[1-9][0-9]{0,19}$/.test(value) && value === itemId;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0
      || value > Number(MAX_CURRENCY)) return false;
  return Number.isSafeInteger(value) ? BigInt(value).toString() === itemId : value === Number(itemId);
}

function reportedUnits(row: CareerRow, userId: string, commander: string,
                       frozenItems: string[]): UnitResult[] {
  const unknown = () => frozenItems.map(itemId => ({ unit_key: unitsById.get(itemId)!.key, kills: null }));
  const rows = parse(row.result_rows);
  if (!Array.isArray(rows) || rows.length > 20) return unknown();
  const own = rows.filter(value => record(value) && value.user_id === userId);
  if (own.length !== 1 || !record(own[0]) || own[0].type !== 'results'
      || !record(own[0].result_details)) return unknown();
  const details = own[0].result_details;
  if (details.battle_map_key !== row.map_key || details.character_key !== commander
      || typeof details.result !== 'string' || nativeOutcomes[details.result] !== row.result
      || details.was_afk !== false || !Array.isArray(details.unit_results)
      || details.unit_results.length > 3) return unknown();
  const remaining = new Map<string, number>();
  for (const item of frozenItems) remaining.set(item, (remaining.get(item) ?? 0) + 1);
  const seenSlots = new Set<number>();
  const normalized: UnitResult[] = [];
  for (const unit of details.unit_results) {
    if (!record(unit) || !integer(unit.merge_idx, 0, 2) || seenSlots.has(unit.merge_idx)
        || typeof unit.unit_record_key !== 'string') return unknown();
    const catalog = unitsByKey.get(unit.unit_record_key);
    if (!catalog || (remaining.get(catalog.id) ?? 0) < 1
        || !compatibleReportedItem(unit.unit_id, catalog.id)) return unknown();
    if (unit.kills !== undefined && !integer(unit.kills, 0, MAX_COUNTER)) return unknown();
    seenSlots.add(unit.merge_idx);
    remaining.set(catalog.id, remaining.get(catalog.id)! - 1);
    normalized.push({ unit_key: catalog.key, kills: unit.kills === undefined ? null : unit.kills as number });
  }
  for (const [itemId, count] of remaining) {
    for (let index = 0; index < count; index++) normalized.push({ unit_key: unitsById.get(itemId)!.key, kills: null });
  }
  return normalized;
}

/** A corrupt native score never removes an otherwise settled battle. Its
 * counters stay unknown. Corrupt frozen identity/loadout data cannot be safely
 * attributed and therefore refuses the complete projection instead. */
export function buildCareerRecord(row: CareerRow, userId: string): CareerRecord | null {
  if (row.user_id !== userId || row.origin !== 'public' || !['created', 'settled'].includes(row.status)
      || row.was_afk !== 0 || !['victory', 'defeat', 'draw'].includes(row.result)) return null;
  // A receipt is durable before all opponents report. Battle expiry closes
  // new submissions; it never revokes a participant's accepted settlement.
  // Later disputes are deliberately excluded on every fresh cloud snapshot.
  const implied = row.result === 'draw' ? null : row.result === 'victory' ? row.team : 1 - row.team;
  if (!integer(row.team, 0, 1) || row.winner_decided !== 1
      || row.winner_team !== implied || row.implied_winner_team !== implied) return null;
  if (!['pve', 'pvp'].includes(row.mode) || typeof row.battle_id !== 'string' || !row.battle_id
      || typeof row.map_key !== 'string' || !row.map_key
      || !integer(row.settled_at, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000))) unreadable();
  const frozen = parse(row.loadout);
  if (!record(frozen) || typeof frozen.commanderId !== 'string'
      || !Array.isArray(frozen.units) || frozen.units.length !== 3) unreadable();
  const commander = commanders.get(frozen.commanderId);
  if (!commander || frozen.faction !== commander.faction) unreadable();
  const frozenItems: string[] = [];
  const instances = new Set<string>();
  for (const unit of frozen.units) {
    if (!record(unit) || typeof unit.itemId !== 'string' || typeof unit.instanceId !== 'string'
        || !unit.instanceId || instances.has(unit.instanceId)) unreadable();
    const catalog = unitsById.get(unit.itemId);
    if (!catalog || unit.key !== catalog.key || catalog.faction !== commander.faction
        || unit.faction !== catalog.faction || !integer(unit.tier, 1, 10)) unreadable();
    instances.add(unit.instanceId); frozenItems.push(unit.itemId);
  }
  const units = reportedUnits(row, userId, commander.key, frozenItems);
  const kills = units.every(unit => unit.kills !== null)
    ? units.reduce((sum, unit) => sum + unit.kills!, 0) : null;
  return { battleId: row.battle_id, userId, mode: row.mode as Mode, commander: commander.key,
    outcome: row.result as Outcome, settledAt: row.settled_at * 1000, units, kills,
    rewards: rewards(row.awarded, frozenItems) };
}

export function aggregateCareerRows(records: AggregateRecord[]) {
  const battles = records.length;
  const wins = records.filter(value => value.outcome === 'victory').length;
  const losses = records.filter(value => value.outcome === 'defeat').length;
  const draws = records.filter(value => value.outcome === 'draw').length;
  const known = records.filter(value => value.kills !== null);
  const kills = known.reduce((sum, value) => sum + value.kills!, 0);
  if (!Number.isSafeInteger(kills)) unreadable();
  const amounts = Object.fromEntries(REWARD_FIELDS.map(field =>
    [field, sumCurrency(records.map(value => value.rewards[field]))])) as Rewards;
  return { battles, wins, losses, draws, win_percent: battles ? wins * 100 / battles : null,
    kills: battles && known.length === battles ? kills : null, known_kills: kills,
    kill_sample_battles: known.length, unknown_kill_battles: battles - known.length,
    kills_known: !!battles && known.length === battles,
    max_kills: known.length ? Math.max(...known.map(value => value.kills!)) : null,
    ...amounts, max_unit_xp_cents: amounts.unit_xp_cents === '0' ? '0' : null,
    average_kills: known.length ? kills / known.length : null };
}

export function aggregateCareer(input: CareerRecord[]) {
  const unique = new Map<string, CareerRecord>();
  let userId: string | undefined;
  for (const value of input) {
    if (userId !== undefined && userId !== value.userId) unreadable();
    userId = value.userId;
    const old = unique.get(value.battleId);
    if (old && canonicalJson(old) !== canonicalJson(value)) unreadable();
    unique.set(value.battleId, value);
  }
  const records = [...unique.values()];
  const commanderGroups = new Map<string, AggregateRecord[]>();
  const unitGroups = new Map<string, AggregateRecord[]>();
  const commanderUnitGroups = new Map<string, Map<string, AggregateRecord[]>>();
  const add = (map: Map<string, AggregateRecord[]>, key: string, value: AggregateRecord) => {
    const group = map.get(key) ?? []; group.push(value); map.set(key, group);
  };
  for (const value of records) {
    add(commanderGroups, value.commander, value);
    const unitKills = new Map<string, number | null>();
    for (const unit of value.units) {
      const old = unitKills.get(unit.unit_key) ?? (unitKills.has(unit.unit_key) ? null : 0);
      unitKills.set(unit.unit_key, old !== null && unit.kills !== null ? old + unit.kills : null);
    }
    const unitRewards = Object.fromEntries(REWARD_FIELDS.map(field =>
      [field, value.rewards[field] === '0' ? '0' : null])) as Rewards;
    for (const [key, kills] of unitKills) {
      const unitRecord = { outcome: value.outcome, kills, rewards: unitRewards };
      add(unitGroups, key, unitRecord);
      const group = commanderUnitGroups.get(value.commander) ?? new Map<string, AggregateRecord[]>();
      add(group, key, unitRecord); commanderUnitGroups.set(value.commander, group);
    }
  }
  const aggregateMap = (groups: Map<string, AggregateRecord[]>) => Object.fromEntries(
    [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, aggregateCareerRows(values)]));
  return { schema_version: 1, kill_measure: 'soldiers', source: CAREER_SOURCE,
    kills_provenance: 'stored-client-report-not-independently-verified',
    last_updated: Math.max(0, ...records.map(value => value.settledAt)),
    overall: aggregateCareerRows(records), commanders: aggregateMap(commanderGroups), units: aggregateMap(unitGroups),
    commander_units: Object.fromEntries([...commanderUnitGroups].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, groups]) => [key, aggregateMap(groups)])),
    modes: Object.fromEntries(['pve', 'pvp'].map(mode =>
      [mode, aggregateCareerRows(records.filter(value => value.mode === mode))])) };
}

const FROM = `FROM battle_settlements s JOIN battles b ON b.id = s.battle_id
  JOIN battle_participants p ON p.battle_id = s.battle_id AND p.user_id = s.user_id
  WHERE s.user_id = ? AND b.origin = 'public' AND b.status IN ('created', 'settled')
    AND s.was_afk = 0 AND s.result IN ('victory', 'defeat', 'draw')
    AND b.winner_decided = 1 AND s.implied_winner_team IS b.winner_team
    AND ((s.result = 'victory' AND b.winner_team = p.team)
      OR (s.result = 'defeat' AND b.winner_team = 1 - p.team)
      OR (s.result = 'draw' AND b.winner_team IS NULL))`;

async function readCareer(actor: Actor, env: Env): Promise<Response> {
  const snapshot = await env.DB.prepare(`SELECT COUNT(*) AS n, MAX(s.settled_at) AS last ${FROM}`)
    .bind(actor.id).first<{ n: number; last: number | null }>();
  if (!snapshot || !integer(snapshot.n, 0, Number.MAX_SAFE_INTEGER)) unreadable();
  if (snapshot.n > MAX_CAREER_BATTLES) throw new ApiError(503, 'career_history_too_large');
  if (snapshot.n === 0) {
    const summary = aggregateCareer([]);
    return json({ ...summary, snapshot_revision: await sha256Hex(canonicalJson(summary)) });
  }
  if (!integer(snapshot.last, 0, Math.floor(Number.MAX_SAFE_INTEGER / 1000))) unreadable();
  // The preliminary read determines only the resource budget and time bound.
  // A single D1 batch is one transaction: its count and fixed ordered pages
  // observe the same eligibility even when a dispute replaces another result
  // without changing COUNT/MAX. One extra page tolerates bounded concurrent
  // arrivals in that second; anything beyond the budget fails closed.
  const pageCount = Math.ceil(snapshot.n / PAGE_SIZE) + 1;
  const statements = [env.DB.prepare(`SELECT COUNT(*) AS n ${FROM} AND s.settled_at <= ?`)
    .bind(actor.id, snapshot.last)];
  for (let page = 0; page < pageCount; page++) {
    statements.push(env.DB.prepare(`SELECT s.battle_id, s.user_id, b.mode, b.origin, b.status,
      b.map_key, p.loadout, s.result, s.was_afk, s.awarded, s.result_rows, s.settled_at,
      p.team, b.winner_decided, b.winner_team, s.implied_winner_team ${FROM}
      AND s.settled_at <= ? ORDER BY s.settled_at, s.battle_id LIMIT ? OFFSET ?`)
      .bind(actor.id, snapshot.last, PAGE_SIZE, page * PAGE_SIZE));
  }
  const batch = await env.DB.batch(statements);
  if (batch.length !== statements.length || batch.some(value => !value.success || !Array.isArray(value.results))) unreadable();
  const count = batch[0].results[0] as { n?: unknown } | undefined;
  if (!count || !integer(count.n, 0, Number.MAX_SAFE_INTEGER)) unreadable();
  if (count.n > MAX_CAREER_BATTLES) throw new ApiError(503, 'career_history_too_large');
  const records: CareerRecord[] = [];
  let afterTime = -1, afterId = '', readBytes = 0;
  const seen = new Set<string>();
  for (const page of batch.slice(1)) {
    if (page.results.length > PAGE_SIZE) unreadable();
    for (const row of page.results as unknown as CareerRow[]) {
      if (row.settled_at < afterTime || (row.settled_at === afterTime && row.battle_id <= afterId)
          || row.settled_at > snapshot.last || seen.has(row.battle_id)) unreadable();
      readBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength;
      if (seen.size >= MAX_CAREER_BATTLES || readBytes > MAX_CAREER_READ_BYTES) {
        throw new ApiError(503, 'career_history_too_large');
      }
      const value = buildCareerRecord(row, actor.id);
      if (!value) unreadable();
      seen.add(row.battle_id); records.push(value);
      afterTime = row.settled_at; afterId = row.battle_id;
    }
  }
  if (records.length !== count.n) {
    throw new ApiError(503, 'career_snapshot_changed');
  }
  const summary = aggregateCareer(records);
  return json({ ...summary, snapshot_revision: await sha256Hex(canonicalJson(summary)) });
}

export async function getCareer(actor: Actor, env: Env): Promise<Response> {
  try { return await readCareer(actor, env); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    // Database exceptions may contain account ids or SQL values. Expose only
    // a retryable status so clients retain their last successful cloud cache.
    throw new ApiError(503, 'career_unavailable');
  }
}
