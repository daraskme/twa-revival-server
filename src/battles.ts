import { ApiError, canonicalJson, fields, integer, json, readJson, serializedSize, sha256Hex } from './http';
import type { Actor, Env } from './types';
import { battleAdmissionReleased } from './battle-admission';
import { requirePublicQueueRuleset, retiredPublicPve } from './native-release';
import {
  chooseMapKeyForRuleset, privateRewardPolicy, requestedRuleset, rewardPolicy, validRewardPolicy,
  type BattleMode, type BattleRuleset, type StandardRewardPolicy,
} from './battle-rules';
import { type VerifiedLoadout } from './loadouts';
import { readSelection } from './loadout-selection';
import { validPvpRosterPolicy, type PvpRosterPolicy } from './matchmaking';
import {requirePublicRosterClient, requireRosterPolicyClient, supportedRosterPolicyVersion} from './public-roster-version';
import { validPrivateBattleEntitlement, validPrivateEconomyPolicy, type PreparedMatch } from './room';
import {
  assertWithinCaps, computeSettlement, impliedWinnerTeam, isBattleResult, parseRewardAmounts, rewardCaps,
  type BattleResult, type RewardAmounts, type Settlement,
} from './settlement';

export const BATTLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Reports are accepted for two hours; after that the battle can never settle. */
export const BATTLE_LIFETIME_SECONDS = 2 * 60 * 60;
/** Opaque per-battle client rows (score screen detail), stored but not parsed. */
export const RESULT_ROWS_LIMIT = 64 * 1024;
export const RESULT_BODY_LIMIT = RESULT_ROWS_LIMIT + 32 * 1024;
/** A relay ticket must outlive a CAReconn resume (assignment lifetime plus the
 * relay's 180 s reconnect grace) without lasting the whole battle window.
 * A participant can always request a fresh ticket.
 */
export const RELAY_TICKET_LIFETIME_MS = 15 * 60_000;
const REPORT_HASH = /^[A-Za-z0-9+/=_-]{16,128}$/;

type StoredStatus = 'created' | 'settled' | 'disputed';
export type BattleStatus = StoredStatus | 'expired';

interface BattleRow {
  id: string;
  created_by: string;
  mode: BattleMode;
  ruleset: BattleRuleset;
  map_key: string;
  status: StoredStatus;
  assignment_id: string | null;
  reward_policy: string;
  roster_policy: string | null;
  origin: 'public' | 'private';
  room_id: string | null;
  room_match_id: string | null;
  private_economy_policy: string | null;
  battle_entitlement: string | null;
  private_cpu_policy: string | null;
  room_config: string | null;
  winner_team: number | null;
  winner_decided: number;
  created_at: number;
  expires_at: number;
}

interface ParticipantRow {
  battle_id: string;
  user_id: string;
  team: number;
  player_id: number;
  seat: number;
  display_name: string;
  loadout: string;
}

interface SettlementRow {
  battle_id: string;
  user_id: string;
  result: BattleResult;
  was_afk: number;
  base: string;
  awarded: string;
  report_hash: string;
  request_hash: string;
  implied_winner_team: number | null;
  settled_at: number;
}

export interface BattleParticipantSeat {
  userId: string;
  displayName: string;
  team: 0 | 1;
  playerId: number;
  seat: number;
  loadout: VerifiedLoadout;
}

function parsePolicy(row: BattleRow): StandardRewardPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(row.reward_policy); } catch { throw new ApiError(503, 'battle_unreadable'); }
  if (!validRewardPolicy(parsed, row.mode)) throw new ApiError(503, 'battle_unreadable');
  return parsed;
}

function parseRosterPolicy(row: BattleRow): PvpRosterPolicy | null {
  if (row.roster_policy === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.roster_policy); } catch { throw new ApiError(503, 'battle_unreadable'); }
  if (!validPvpRosterPolicy(parsed, row.mode)) throw new ApiError(503, 'battle_unreadable');
  return parsed;
}

function parsePrivateFields(row: BattleRow) {
  if (!row.room_id || !row.room_match_id || !row.private_economy_policy || !row.battle_entitlement ||
      !row.private_cpu_policy || !row.room_config) throw new ApiError(503, 'battle_unreadable');
  let economyPolicy: unknown, battleEntitlement: unknown, cpuRosterPolicy: unknown, roomConfig: unknown;
  try {
    economyPolicy = JSON.parse(row.private_economy_policy);
    battleEntitlement = JSON.parse(row.battle_entitlement);
    cpuRosterPolicy = JSON.parse(row.private_cpu_policy);
    roomConfig = JSON.parse(row.room_config);
  } catch { throw new ApiError(503, 'battle_unreadable'); }
  if (!validPrivateEconomyPolicy(economyPolicy) || !validPrivateBattleEntitlement(battleEntitlement) ||
      !cpuRosterPolicy || typeof cpuRosterPolicy !== 'object' || Array.isArray(cpuRosterPolicy)) {
    throw new ApiError(503, 'battle_unreadable');
  }
  if (!roomConfig || typeof roomConfig !== 'object' || Array.isArray(roomConfig) || Object.keys(roomConfig).length !== 2) {
    throw new ApiError(503, 'battle_unreadable');
  }
  const config = roomConfig as Record<string, unknown>;
  if (typeof config.title !== 'string' || config.title !== config.title.trim() || config.title.length < 1 ||
      config.title.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(config.title) ||
      !integer(config.length, 1, 7200)) throw new ApiError(503, 'battle_unreadable');
  const cpu = cpuRosterPolicy as Record<string, unknown>;
  if (Object.keys(cpu).length !== 4 || cpu.version !== 1 ||
      cpu.seed !== `private-roster-v1:${row.room_match_id}` || !integer(cpu.aiOpponents, 0, 10) ||
      (cpu.aiTeam !== null && cpu.aiTeam !== 1)) throw new ApiError(503, 'battle_unreadable');
  if ((row.mode === 'pve' && (cpu.aiTeam !== 1 || !integer(cpu.aiOpponents, 1, 10))) ||
      (row.mode === 'pvp' && (cpu.aiTeam !== null || cpu.aiOpponents !== 0))) {
    throw new ApiError(503, 'battle_unreadable');
  }
  return { roomId: row.room_id, roomMatchId: row.room_match_id, roomConfig, economyPolicy, battleEntitlement, cpuRosterPolicy };
}

function cpuSeatsByTeam(row: BattleRow, seats: BattleParticipantSeat[]): [number, number] {
  const policy = parseRosterPolicy(row);
  if (policy === null) return [0, 0];
  const humans: [number, number] = [0, 0];
  for (const seat of seats) humans[seat.team]++;
  const remaining: [number, number] = [
    policy.seatsPerTeam - humans[0], policy.seatsPerTeam - humans[1],
  ];
  if (remaining.some(count => !Number.isSafeInteger(count) || count < 0)) {
    throw new ApiError(503, 'battle_unreadable');
  }
  return remaining;
}

function parseSeats(rows: ParticipantRow[]): BattleParticipantSeat[] {
  return rows.map(row => {
    let loadout: unknown;
    try { loadout = JSON.parse(row.loadout); } catch { throw new ApiError(503, 'battle_unreadable'); }
    if (row.team !== 0 && row.team !== 1) throw new ApiError(503, 'battle_unreadable');
    const team: 0 | 1 = row.team === 1 ? 1 : 0;
    return { userId: row.user_id, displayName: row.display_name, team, playerId: row.player_id,
      seat: row.seat, loadout: loadout as VerifiedLoadout };
  }).sort((left, right) => left.playerId - right.playerId);
}

function derivedStatus(row: BattleRow, seats: BattleParticipantSeat[], settled: number, nowSeconds: number): BattleStatus {
  if (row.status === 'disputed') return 'disputed';
  if (row.status === 'settled' || settled >= seats.length) return 'settled';
  return nowSeconds >= row.expires_at ? 'expired' : 'created';
}

async function loadBattle(env: Env, battleId: string): Promise<{
  row: BattleRow; seats: BattleParticipantSeat[]; settlements: SettlementRow[];
} | null> {
  const [battle, participants, settlements] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM battles WHERE id = ?').bind(battleId),
    env.DB.prepare('SELECT * FROM battle_participants WHERE battle_id = ? ORDER BY player_id').bind(battleId),
    env.DB.prepare('SELECT * FROM battle_settlements WHERE battle_id = ?').bind(battleId),
  ]);
  const row = (battle.results as BattleRow[])[0];
  if (!row) return null;
  return { row, seats: parseSeats(participants.results as ParticipantRow[]), settlements: settlements.results as SettlementRow[] };
}

function battleView(row: BattleRow, seats: BattleParticipantSeat[], settlements: SettlementRow[], nowSeconds: number) {
  const settledBy = new Map(settlements.map(entry => [entry.user_id, entry]));
  const privateFields = row.origin === 'private' ? parsePrivateFields(row) : null;
  return {
    battleId: row.id,
    origin: row.origin,
    mode: row.mode,
    ruleset: row.ruleset,
    mapKey: row.map_key,
    status: derivedStatus(row, seats, settlements.length, nowSeconds),
    assignmentId: row.assignment_id,
    rewardPolicy: parsePolicy(row),
    rosterPolicy: parseRosterPolicy(row),
    cpuSeatsByTeam: cpuSeatsByTeam(row, seats),
    ...(privateFields ?? {}),
    winnerTeam: row.winner_decided === 1 ? row.winner_team : null,
    winnerDecided: row.winner_decided === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    participants: seats.map(seat => ({
      userId: seat.userId, displayName: seat.displayName, team: seat.team, playerId: seat.playerId,
      seat: seat.seat, loadout: seat.loadout,
      // Other players' outcomes are visible; their reward amounts are not.
      settled: settledBy.has(seat.userId),
      result: settledBy.get(seat.userId)?.result ?? null,
    })),
  };
}

function settlementView(entry: SettlementRow) {
  return {
    battleId: entry.battle_id,
    userId: entry.user_id,
    result: entry.result,
    wasAfk: entry.was_afk === 1,
    base: JSON.parse(entry.base) as RewardAmounts,
    settlement: JSON.parse(entry.awarded) as Settlement,
    reportHash: entry.report_hash,
    settledAt: entry.settled_at,
  };
}

function insertBattleStatements(env: Env, battle: {
  id: string; createdBy: string; mode: BattleMode; ruleset: BattleRuleset; mapKey: string;
  assignmentId: string | null; policy: StandardRewardPolicy; createdAt: number; expiresAt: number;
  rosterPolicy: PvpRosterPolicy | null;
  seats: BattleParticipantSeat[];
}): D1PreparedStatement[] {
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO battles
      (id, created_by, mode, ruleset, map_key, status, assignment_id, reward_policy, roster_policy,
       winner_team, winner_decided, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, NULL, 0, ?, ?)`)
      .bind(battle.id, battle.createdBy, battle.mode, battle.ruleset, battle.mapKey, battle.assignmentId,
        JSON.stringify(battle.policy), battle.rosterPolicy === null ? null : canonicalJson(battle.rosterPolicy),
        battle.createdAt, battle.expiresAt),
    ...battle.seats.map(seat => env.DB.prepare(`INSERT OR IGNORE INTO battle_participants
      (battle_id, user_id, team, player_id, seat, display_name, loadout) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(battle.id, seat.userId, seat.team, seat.playerId, seat.seat, seat.displayName, JSON.stringify(seat.loadout))),
  ];
}

/** PvE battle creation. The commander/unit selection is re-resolved from the
 * bundled catalog, so a client cannot grant itself a unit or a Tier: the Tier
 * it declares must equal the one the server derives.
 */
export async function createBattle(actor: Actor, request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  // A local PvE allocator may already have frozen a validated map.  When it
  // is omitted the Worker chooses and persists one map from the ruleset pool;
  // PvP never enters this endpoint.
  fields(body, ['mode', 'ruleset', 'mapKey', 'loadout']);
  if (body.mode !== 'pve' && body.mode !== 'pvp') throw new ApiError(400, 'invalid_mode');
  // PvP battles are only created from a confirmed matchmaking assignment so that
  // both clients share one battle ID, one frozen roster and one reward policy.
  if (body.mode === 'pvp') throw new ApiError(409, 'pvp_requires_assignment', { route: '/v1/battles/from-assignment' });
  const ruleset = requestedRuleset(body.ruleset, body.mapKey);
  requirePublicQueueRuleset(env, ruleset, body.mode);
  const mapKey = body.mapKey === undefined ? chooseMapKeyForRuleset(ruleset) : body.mapKey;
  const requested = body.loadout;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw new ApiError(400, 'invalid_loadout');
  const loadoutBody = requested as Record<string, unknown>;
  if (Object.keys(loadoutBody).some(key => !['commanderId', 'unitIds', 'tier'].includes(key))) {
    throw new ApiError(400, 'unknown_field');
  }
  if (typeof loadoutBody.commanderId !== 'string') throw new ApiError(400, 'invalid_commander');
  if (!actor.commanderId) throw new ApiError(409, 'commander_selection_required');
  if (loadoutBody.commanderId !== actor.commanderId) throw new ApiError(409, 'loadout_commander_mismatch');
  if (!Array.isArray(loadoutBody.unitIds) || loadoutBody.unitIds.length !== 3) throw new ApiError(400, 'invalid_loadout');
  if (!integer(loadoutBody.tier, 1, 10)) throw new ApiError(400, 'invalid_loadout_tier');
  const loadout = (await readSelection(actor.id, actor.commanderId, env)).loadout;
  if ((loadoutBody.unitIds as unknown[]).some((itemId, slot) => itemId !== loadout.units[slot].itemId)) {
    throw new ApiError(409, 'loadout_selection_mismatch');
  }
  if (loadout.maxTier !== loadoutBody.tier) throw new ApiError(409, 'loadout_tier_mismatch', { tier: loadout.maxTier });

  const id = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  const policy = rewardPolicy('pve');
  const seats: BattleParticipantSeat[] = [
    { userId: actor.id, displayName: actor.displayName, team: 0, playerId: 1, seat: 0, loadout },
  ];
  await env.DB.batch(insertBattleStatements(env, {
    id, createdBy: actor.id, mode: 'pve', ruleset, mapKey: mapKey as string, assignmentId: null,
    policy, createdAt, expiresAt: createdAt + BATTLE_LIFETIME_SECONDS, seats,
    rosterPolicy: null,
  }));
  const loaded = await loadBattle(env, id);
  if (!loaded) throw new ApiError(503, 'battle_creation_failed');
  return json(battleView(loaded.row, loaded.seats, loaded.settlements, createdAt), 201);
}

/** PvP battle creation from a confirmed queue assignment. Either assigned
 * player may call it; the Matchmaker fixes one battle ID for the pair, so the
 * second caller and every retry converge on the same battle.
 */
export async function createBattleFromAssignment(actor: Actor, request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  fields(body, ['assignmentId']);
  if (typeof body.assignmentId !== 'string' || !BATTLE_ID.test(body.assignmentId)) {
    throw new ApiError(400, 'invalid_assignment_id');
  }
  const claimed = await env.MATCHMAKER.getByName('standard-v1').claim(actor.id, body.assignmentId, crypto.randomUUID(), supportedRosterPolicyVersion(request));
  if (!('claim' in claimed) && claimed.status === 426)
    requirePublicRosterClient(request, supportedRosterPolicyVersion(request) < 3 ? 3 :
      supportedRosterPolicyVersion(request) < 4 ? 4 : 5);
  if (!('claim' in claimed)) throw new ApiError(claimed.status, claimed.error);
  const claim = claimed.claim;
  requireRosterPolicyClient(request, claim.rosterPolicy);
  const createdAt = Math.floor(claim.claimedAt / 1000);
  const existing = await loadBattle(env, claim.battleId);
  // A claim can have committed before its D1 battle write. After retirement,
  // only battles already present in D1 remain retryable.
  if (!existing && retiredPublicPve(env, claim.mode)) throw new ApiError(409, 'battle_mode_removed');
  if (!existing) {
    // Also the self-heal path when a previous claim's D1 write was lost: the
    // claim already fixed the battle ID, so re-inserting is idempotent.
    await env.DB.batch(insertBattleStatements(env, {
      id: claim.battleId, createdBy: claim.participants[0]?.userId ?? actor.id, mode: claim.mode,
      ruleset: claim.ruleset, mapKey: claim.mapKey, assignmentId: claim.assignmentId, policy: claim.rewardPolicy,
      createdAt, expiresAt: createdAt + BATTLE_LIFETIME_SECONDS, seats: claim.participants,
      rosterPolicy: claim.rosterPolicy ?? null,
    }));
  }
  const loaded = await loadBattle(env, claim.battleId);
  if (!loaded) throw new ApiError(503, 'battle_creation_failed');
  if (loaded.row.id !== claim.battleId || loaded.row.assignment_id !== claim.assignmentId ||
      loaded.row.mode !== claim.mode || loaded.row.ruleset !== claim.ruleset ||
      loaded.row.map_key !== claim.mapKey) {
    throw new ApiError(409, 'battle_assignment_conflict');
  }
  const storedRosterPolicy = parseRosterPolicy(loaded.row);
  if (canonicalJson(storedRosterPolicy) !== canonicalJson(claim.rosterPolicy ?? null)) {
    throw new ApiError(409, 'battle_roster_policy_mismatch');
  }
  if (!loaded.seats.some(seat => seat.userId === actor.id)) throw new ApiError(404, 'battle_not_found');
  // Both callers and every retry install the same frozen roster; the relay
  // treats an identical manifest as a no-op.
  await installRelayManifest(env, claim.battleId, loaded.seats);
  return json(battleView(loaded.row, loaded.seats, loaded.settlements, Math.floor(Date.now() / 1000)),
    claimed.status === 201 && !existing ? 201 : 200);
}

export async function createBattleFromRoomClaim(actor: Actor, claim: {
  roomId: string; ownerId: string; match: PreparedMatch;
}, env: Env): Promise<Response> {
  const match = claim.match;
  if (!match.battleId || !BATTLE_ID.test(match.battleId) || !BATTLE_ID.test(match.matchId) ||
      !match.members.some(member => member.userId === actor.id)) throw new ApiError(404, 'room_not_found');
  const policy = privateRewardPolicy();
  const seats: BattleParticipantSeat[] = match.members.map((member, index) => ({
    userId: member.userId, displayName: member.displayName, team: member.team,
    playerId: index + 1, seat: index, loadout: member.loadout,
  }));
  let loaded = await loadBattle(env, match.battleId);
  if (!loaded && retiredPublicPve(env, match.mode)) throw new ApiError(409, 'battle_mode_removed');
  const createdAt = Math.floor(match.preparedAt / 1000);
  if (!loaded) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO battles
        (id, created_by, mode, ruleset, map_key, status, assignment_id, reward_policy, roster_policy,
         winner_team, winner_decided, created_at, expires_at, origin, room_id, room_match_id,
         private_economy_policy, battle_entitlement, private_cpu_policy, room_config)
        VALUES (?, ?, ?, ?, ?, 'created', NULL, ?, NULL, NULL, 0, ?, ?, 'private', ?, ?, ?, ?, ?, ?)`)
        .bind(match.battleId, claim.ownerId, match.mode, match.ruleset, match.mapKey, JSON.stringify(policy),
          createdAt, match.battleExpiresAt, claim.roomId, match.matchId,
          canonicalJson(match.economyPolicy), canonicalJson(match.battleEntitlement),
          canonicalJson(match.cpuRosterPolicy), canonicalJson(match.roomConfig)),
      ...seats.map(seat => env.DB.prepare(`INSERT OR IGNORE INTO battle_participants
        (battle_id, user_id, team, player_id, seat, display_name, loadout) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(match.battleId, seat.userId, seat.team, seat.playerId, seat.seat, seat.displayName,
          JSON.stringify(seat.loadout))),
    ]);
    loaded = await loadBattle(env, match.battleId);
  }
  if (!loaded) throw new ApiError(503, 'battle_creation_failed');
  const expected = { id: match.battleId, origin: 'private', assignmentId: null, rosterPolicy: null,
    createdBy: claim.ownerId, mode: match.mode, ruleset: match.ruleset,
    mapKey: match.mapKey, roomId: claim.roomId, roomMatchId: match.matchId, rewardPolicy: policy,
    roomConfig: match.roomConfig,
    economyPolicy: match.economyPolicy, battleEntitlement: match.battleEntitlement,
    cpuRosterPolicy: match.cpuRosterPolicy, createdAt, expiresAt: match.battleExpiresAt, seats };
  const privateFields = parsePrivateFields(loaded.row);
  const actual = { id: loaded.row.id, origin: loaded.row.origin, assignmentId: loaded.row.assignment_id,
    rosterPolicy: parseRosterPolicy(loaded.row), createdBy: loaded.row.created_by, mode: loaded.row.mode,
    ruleset: loaded.row.ruleset, mapKey: loaded.row.map_key, roomId: privateFields.roomId,
    roomConfig: privateFields.roomConfig,
    roomMatchId: privateFields.roomMatchId, rewardPolicy: parsePolicy(loaded.row),
    economyPolicy: privateFields.economyPolicy, battleEntitlement: privateFields.battleEntitlement,
    cpuRosterPolicy: privateFields.cpuRosterPolicy, createdAt: loaded.row.created_at,
    expiresAt: loaded.row.expires_at, seats: loaded.seats };
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new ApiError(409, 'private_battle_conflict');
  await installRelayManifest(env, match.battleId, loaded.seats,
    loaded.seats.length + match.cpuRosterPolicy.aiOpponents, claim.roomId);
  return json(battleView(loaded.row, loaded.seats, loaded.settlements, Math.floor(Date.now() / 1000)), 200);
}

export async function privateBattleReturnable(env: Env, roomId: string, battleId: string): Promise<boolean> {
  const loaded = await loadBattle(env, battleId);
  if (!loaded || loaded.row.origin !== 'private' || loaded.row.room_id !== roomId) return false;
  const now = Math.floor(Date.now() / 1000);
  // A dispute remains immutable battle history, but cannot strand the Room
  // after the independently stored server deadline has elapsed.
  if (now >= loaded.row.expires_at) return true;
  return derivedStatus(loaded.row, loaded.seats, loaded.settlements.length, now) === 'settled' ||
    (loaded.row.status !== 'disputed' && await battleAdmissionReleased(env, battleId, loaded.row.created_at));
}

/** A restart may recover only this authenticated participant's unfinished seat. */
export async function getActiveBattle(actor: Actor, env: Env, request?: Request): Promise<Response> {
  const now = Math.floor(Date.now() / 1000);
  const candidates = await env.DB.prepare(`SELECT b.id, p.player_id AS playerId FROM battles b
    INNER JOIN battle_participants p ON p.battle_id = b.id AND p.user_id = ?
    WHERE b.origin = 'public' AND b.assignment_id IS NOT NULL
      AND b.status = 'created' AND b.winner_decided = 0
      AND b.expires_at > ? AND NOT EXISTS (
        SELECT 1 FROM battle_settlements s WHERE s.battle_id = b.id AND s.user_id = ?)
    ORDER BY b.created_at DESC, b.id DESC LIMIT 16`).bind(actor.id, now, actor.id).all<{id: string; playerId: number}>();
  const resumable: string[] = [];
  for (const candidate of candidates.results) {
    const response = await env.BATTLE_RELAY.getByName(candidate.id).fetch(
      `https://relay/restart-status?playerId=${candidate.playerId}`);
    if (!response.ok) throw new ApiError(503, 'active_battle_unavailable');
    const state = await response.json() as {battleId?: unknown; canRestart?: unknown};
    if (state.battleId !== candidate.id || typeof state.canRestart !== 'boolean') throw new ApiError(503, 'active_battle_unavailable');
    if (state.canRestart) resumable.push(candidate.id);
  }
  if (resumable.length > 1 || candidates.results.length === 16) throw new ApiError(409, 'active_battle_ambiguous');
  if (!resumable.length) return json({ battle: null });
  return getBattle(actor, resumable[0], env, false, request);
}

export async function getBattle(actor: Actor, battleId: string, env: Env, includeAdmission = false, request?: Request): Promise<Response> {
  const loaded = await loadBattle(env, battleId);
  // A non-participant learns nothing about whether the battle exists.
  if (!loaded || !loaded.seats.some(seat => seat.userId === actor.id)) throw new ApiError(404, 'battle_not_found');
  requireRosterPolicyClient(request, parseRosterPolicy(loaded.row));
  const own = loaded.settlements.find(entry => entry.user_id === actor.id);
  const now = Math.floor(Date.now() / 1000);
  const admissionReleased = includeAdmission && ((loaded.row.origin === 'public' && Boolean(own)) || loaded.row.expires_at <= now || loaded.row.status === 'settled' ||
    (loaded.row.status !== 'disputed' && await battleAdmissionReleased(env, battleId, loaded.row.created_at,
      loaded.row.origin === 'public' ? [actor.id] : undefined)));
  return json({
    battle: battleView(loaded.row, loaded.seats, loaded.settlements, now),
    settlement: own ? settlementView(own) : null,
    ...(includeAdmission ? {admissionReleased} : {}),
  });
}

/** Server-authoritative settlement of one participant's own report. */
export async function reportBattleResult(actor: Actor, battleId: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, RESULT_BODY_LIMIT);
  fields(body, ['result', 'wasAfk', 'base', 'resultRows', 'reportHash']);
  if (!isBattleResult(body.result)) throw new ApiError(400, 'invalid_result');
  if (typeof body.wasAfk !== 'boolean') throw new ApiError(400, 'invalid_was_afk');
  if (typeof body.reportHash !== 'string' || !REPORT_HASH.test(body.reportHash)) throw new ApiError(400, 'invalid_report_hash');
  if (!Array.isArray(body.resultRows)) throw new ApiError(400, 'invalid_result_rows');
  if (serializedSize(body.resultRows) > RESULT_ROWS_LIMIT) {
    throw new ApiError(413, 'result_rows_too_large', { limit: RESULT_ROWS_LIMIT });
  }
  const base = parseRewardAmounts(body.base);
  // One fingerprint over the whole submission: a retry must be byte-identical
  // in meaning, not merely reuse the same reportHash.
  const requestHash = await sha256Hex(canonicalJson({
    result: body.result, wasAfk: body.wasAfk, base, resultRows: body.resultRows, reportHash: body.reportHash,
  }));

  const loaded = await loadBattle(env, battleId);
  if (!loaded) throw new ApiError(404, 'battle_not_found');
  const seat = loaded.seats.find(entry => entry.userId === actor.id);
  if (!seat) throw new ApiError(404, 'battle_not_found');
  const own = loaded.settlements.find(entry => entry.user_id === actor.id);
  if (own) {
    // Exactly once per participant: an identical retry replays the settlement.
    if (own.request_hash !== requestHash) throw new ApiError(409, 'settlement_conflict', { settledAt: own.settled_at });
    return json(settlementView(own), 200);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= loaded.row.expires_at) throw new ApiError(410, 'battle_expired');
  // XP may only be credited to the units frozen into this participant's seat.
  const known = new Set(seat.loadout.units.map(unit => unit.itemId));
  if (base.unitXp.some(unit => !known.has(unit.unitId))) throw new ApiError(409, 'unit_not_in_battle');
  const policy = parsePolicy(loaded.row);
  assertWithinCaps(base, rewardCaps(env));
  const implied = impliedWinnerTeam(body.result, seat.team);
  if (loaded.row.winner_decided === 1 && loaded.row.winner_team !== implied) {
    // A contradictory report is never settled; the battle is flagged for review.
    await env.DB.prepare("UPDATE battles SET status = 'disputed' WHERE id = ?").bind(battleId).run();
    throw new ApiError(409, 'result_disagreement', { winnerTeam: loaded.row.winner_team });
  }
  const settlement = computeSettlement(policy, { result: body.result, wasAfk: body.wasAfk, base });

  const written = await env.DB.batch([
    // The guard repeats every precondition so a concurrent duplicate submission
    // or a contradicting opponent cannot slip a second winner past the check.
    env.DB.prepare(`INSERT OR IGNORE INTO battle_settlements
      (battle_id, user_id, result, was_afk, base, awarded, result_rows, report_hash, request_hash, implied_winner_team, settled_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM battles b WHERE b.id = ? AND b.expires_at > ? AND b.status IN ('created', 'disputed')
        AND (b.winner_decided = 0 OR b.winner_team IS ?)
      RETURNING user_id`)
      .bind(battleId, actor.id, body.result, body.wasAfk ? 1 : 0, JSON.stringify(base), JSON.stringify(settlement),
        JSON.stringify(body.resultRows), body.reportHash, requestHash, implied, nowSeconds,
        battleId, nowSeconds, implied),
    env.DB.prepare(`UPDATE battles SET winner_team = ?, winner_decided = 1
      WHERE id = ? AND winner_decided = 0
        AND EXISTS(SELECT 1 FROM battle_settlements WHERE battle_id = ? AND user_id = ?)`)
      .bind(implied, battleId, battleId, actor.id),
    env.DB.prepare(`UPDATE battles SET status = 'settled' WHERE id = ? AND status = 'created'
      AND (SELECT COUNT(*) FROM battle_settlements WHERE battle_id = ?)
        = (SELECT COUNT(*) FROM battle_participants WHERE battle_id = ?)`)
      .bind(battleId, battleId, battleId),
    env.DB.prepare('SELECT * FROM battle_settlements WHERE battle_id = ? AND user_id = ?').bind(battleId, actor.id),
  ]);
  const stored = (written.at(-1)!.results as SettlementRow[])[0];
  if (!stored) throw new ApiError(409, 'settlement_conflict');
  if (stored.request_hash !== requestHash) throw new ApiError(409, 'settlement_conflict', { settledAt: stored.settled_at });
  return json(settlementView(stored), 201);
}

export const SQUAD_ROWS_LIMIT = 64 * 1024;

interface SquadRow { user_id: string; native_squad: string | null }

async function squadRows(env: Env, battleId: string): Promise<SquadRow[]> {
  const rows = await env.DB.prepare(
    'SELECT user_id, native_squad FROM battle_participants WHERE battle_id = ? ORDER BY player_id').bind(battleId).all<SquadRow>();
  return rows.results;
}

/** A participant uploads its own trusted native `full_squad_setup` rows. The
 * Worker never interprets them; it only caps their size and hands them to the
 * other seats through the roster so each companion can answer `/check`.
 */
export async function putSquad(actor: Actor, battleId: string, request: Request, env: Env): Promise<Response> {
  const body = await readJson(request, SQUAD_ROWS_LIMIT + 16 * 1024);
  fields(body, ['rowsJson']);
  // The rows are carried as a JSON string and stored verbatim: native uint64
  // ids exceed 2^53, so parsing them into Numbers and re-serializing would
  // silently corrupt them. JSON.parse here is validation only.
  if (typeof body.rowsJson !== 'string' || body.rowsJson.length === 0) throw new ApiError(400, 'invalid_squad_rows');
  if (new TextEncoder().encode(body.rowsJson).length > SQUAD_ROWS_LIMIT) {
    throw new ApiError(413, 'squad_too_large', { limit: SQUAD_ROWS_LIMIT });
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body.rowsJson); } catch { throw new ApiError(400, 'invalid_squad_rows'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new ApiError(400, 'invalid_squad_rows');
  const loaded = await loadBattle(env, battleId);
  if (!loaded || !loaded.seats.some(seat => seat.userId === actor.id)) throw new ApiError(404, 'battle_not_found');
  requireRosterPolicyClient(request, parseRosterPolicy(loaded.row));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds >= loaded.row.expires_at) throw new ApiError(410, 'battle_expired');
  if (loaded.settlements.length > 0) throw new ApiError(409, 'battle_already_reported');
  // First accepted bytes win. The SQL precondition, rather than a preceding
  // read, is the serialization boundary for simultaneous PUTs.
  const written = await env.DB.prepare(`UPDATE battle_participants SET native_squad = ?
    WHERE battle_id = ? AND user_id = ? AND native_squad IS NULL
      AND EXISTS(SELECT 1 FROM battles b WHERE b.id = ? AND b.expires_at > ?)
      AND NOT EXISTS(SELECT 1 FROM battle_settlements s WHERE s.battle_id = ?)`)
    .bind(body.rowsJson, battleId, actor.id, battleId, nowSeconds, battleId).run();
  const current = await env.DB.prepare(
    'SELECT native_squad FROM battle_participants WHERE battle_id = ? AND user_id = ?')
    .bind(battleId, actor.id).first<{ native_squad: string | null }>();
  if (!current) throw new ApiError(404, 'battle_not_found');
  if (written.meta.changes === 0) {
    // Re-check lifecycle after losing the guarded write so a concurrent result
    // or expiry is never mislabeled as a mutable-roster conflict.
    const latest = await loadBattle(env, battleId);
    if (!latest || !latest.seats.some(seat => seat.userId === actor.id)) throw new ApiError(404, 'battle_not_found');
    if (Math.floor(Date.now() / 1000) >= latest.row.expires_at) throw new ApiError(410, 'battle_expired');
    if (latest.settlements.length > 0) throw new ApiError(409, 'battle_already_reported');
    if (current.native_squad !== body.rowsJson) throw new ApiError(409, 'native_squad_conflict');
  }
  const missing = (await squadRows(env, battleId)).filter(row => row.native_squad === null).map(row => row.user_id);
  return json({ ok: true, ready: missing.length === 0, missing });
}

/** The frozen roster with every participant's squad rows, available only once
 * all seats have uploaded; before that 409 lists who is still missing.
 */
export async function getRoster(actor: Actor, battleId: string, env: Env, request?: Request): Promise<Response> {
  const loaded = await loadBattle(env, battleId);
  if (!loaded || !loaded.seats.some(seat => seat.userId === actor.id)) throw new ApiError(404, 'battle_not_found');
  requireRosterPolicyClient(request, parseRosterPolicy(loaded.row));
  const rows = await squadRows(env, battleId);
  const missing = rows.filter(row => row.native_squad === null).map(row => row.user_id);
  if (missing.length > 0) throw new ApiError(409, 'roster_incomplete', { missing });
  const squads = new Map(rows.map(row => [row.user_id, row.native_squad as string]));
  let partyGroups: string[][] = [];
  if (loaded.row.origin === 'public' && loaded.row.assignment_id !== null) {
    const frozen = await env.MATCHMAKER.getByName('standard-v1').battlePartyGroups(actor.id, battleId);
    if (!frozen || canonicalJson(frozen.participants) !== canonicalJson(loaded.seats.map(seat => seat.userId))) {
      throw new ApiError(503, 'battle_party_roster_unavailable');
    }
    const teams = new Map(loaded.seats.map(seat => [seat.userId, seat.team]));
    const seen = new Set<string>();
    for (const group of frozen.groups) {
      if (!Array.isArray(group) || group.length < 2 || group.length > 4 ||
          group.some(id => typeof id !== 'string' || !teams.has(id) || seen.has(id)) ||
          new Set(group).size !== group.length || new Set(group.map(id => teams.get(id))).size !== 1) {
        throw new ApiError(503, 'battle_party_roster_unavailable');
      }
      for (const id of group) seen.add(id);
    }
    partyGroups = frozen.groups;
  }
  // `rowsJson` is returned as the stored string so uint64 ids survive intact;
  // the companion parses it with an integer-preserving JSON decoder.
  return json({
    battleId, origin: loaded.row.origin, mode: loaded.row.mode, ruleset: loaded.row.ruleset, mapKey: loaded.row.map_key,
    rosterPolicy: parseRosterPolicy(loaded.row), partyGroups,
    cpuSeatsByTeam: cpuSeatsByTeam(loaded.row, loaded.seats),
    ...(loaded.row.origin === 'private' ? parsePrivateFields(loaded.row) : {}),
    participants: loaded.seats.map(seat => ({
      userId: seat.userId, displayName: seat.displayName, seat: seat.seat, playerId: seat.playerId, team: seat.team,
      rowsJson: squads.get(seat.userId) ?? '[]',
    })),
  });
}

function relaySecret(env: Env): string | null {
  const secret = env.RELAY_TICKET_SECRET;
  if (typeof secret !== 'string' || secret.length < 16 || /REPLACE_ME/i.test(secret)) return null;
  return secret;
}

/** The shared 64-bit native battle key: derived from the relay secret and the
 * battle id so both participants and the relay agree without storing it.
 * Canonical lowercase hex without leading zeros, as the native `/check`
 * `battle_key` and the relay manifest expect.
 */
export async function deriveBattleKeyHex(secret: string, battleId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`battle-key:${battleId}`)));
  let value = 0n;
  for (const byte of digest.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  const hex = value.toString(16);
  return hex === '0' ? '1' : hex;
}

/** Install the frozen roster in the battle's relay Durable Object (idempotent
 * for identical content). Skipped when the relay secret is not configured,
 * in which case relay tickets fail closed with 503 as well.
 */
async function installRelayManifest(env: Env, battleId: string, seats: BattleParticipantSeat[],
  wireExpectedPlayers = seats.length, wireBattleId?: string): Promise<void> {
  const secret = relaySecret(env);
  if (!secret) return;
  const manifest = {
    battleId,
    ...(wireBattleId === undefined ? {} : { wireBattleId }),
    battleKeyHex: await deriveBattleKeyHex(secret, battleId),
    // Authentication remains human-only. Native GAME_JOIN byte 89 describes
    // the full rendered population, including frozen private PvE CPUs.
    expectedPlayers: wireExpectedPlayers,
    seats: [...seats].sort((a, b) => a.seat - b.seat)
      .map(seat => ({ seat: seat.seat, userId: seat.userId, playerId: seat.playerId, team: seat.team })),
  };
  const response = await env.BATTLE_RELAY.getByName(battleId).fetch('https://relay/manifest', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest),
  });
  // Finish the internal response even though this endpoint only needs its
  // status. An unread response keeps the relay request alive across eviction.
  await response.body?.cancel();
  if (!response.ok) throw new ApiError(503, 'relay_manifest_failed');
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Short-lived proof of one seat in one battle, for the separate relay service.
 * Format (verified by src/relay/ticket.ts, never by this module):
 *   base64url(JSON.stringify({battleId,userId,seat,playerId,team,exp}))
 *   + "." + base64url(HMAC-SHA256(RELAY_TICKET_SECRET, that first part))
 * `exp` and the response's `expiresAt` are Unix **milliseconds**, matching the
 * relay's verifier; every other timestamp in this API is in seconds.
 */
export async function issueRelayTicket(actor: Actor, battleId: string, env: Env, request?: Request): Promise<Response> {
  const secret = relaySecret(env);
  if (!secret) throw new ApiError(503, 'relay_ticket_not_configured');
  const loaded = await loadBattle(env, battleId);
  if (!loaded) throw new ApiError(404, 'battle_not_found');
  const seat = loaded.seats.find(entry => entry.userId === actor.id);
  if (!seat) throw new ApiError(404, 'battle_not_found');
  requireRosterPolicyClient(request, parseRosterPolicy(loaded.row));
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds >= loaded.row.expires_at) throw new ApiError(410, 'battle_expired');
  if (derivedStatus(loaded.row, loaded.seats, loaded.settlements.length, nowSeconds) === 'settled') {
    throw new ApiError(409, 'battle_already_settled');
  }
  const exp = Math.min(loaded.row.expires_at * 1000, now + RELAY_TICKET_LIFETIME_MS);
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    battleId, userId: actor.id, seat: seat.seat, playerId: seat.playerId, team: seat.team, exp,
  })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return json({ ticket: `${payload}.${base64Url(new Uint8Array(signature))}`,
    relayUrl: `/v1/relay/${battleId}`, expiresAt: exp,
    // The native battle credentials both participants must present in GAME_JOIN.
    battleId, battleKeyHex: await deriveBattleKeyHex(secret, battleId),
    seat: seat.seat, playerId: seat.playerId, team: seat.team });
}
