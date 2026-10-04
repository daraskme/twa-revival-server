import { DurableObject } from 'cloudflare:workers';
import { ApiError, fields } from './http';
import {channelChat} from './social-chat';
import type { Actor, Env } from './types';
import { opponentTier, sameLoadout, starterLoadout, type VerifiedLoadout } from './loadouts';
import { readSelection, resolveSelectionRow } from './loadout-selection';
import { isBattleRuleset, mapKeyForRuleset, requestedRuleset, type BattleRuleset } from './battle-rules';
import { isMapKeyForRuleset, type NativeBattleMapKey } from './native-battle-maps';
import {retiredPublicPve} from './native-release';

const LIFETIME_MS = 2 * 60 * 60 * 1000;
const PRIVATE_BATTLE_LIFETIME_SECONDS = 2 * 60 * 60;
const TERMINAL_CLEANUP_WINDOW_MS = 15 * 60 * 1000;
const STORAGE_KEY = 'room';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Mode = 'pvp' | 'pve';
type Status = 'open' | 'awaiting_gameplay_adapter' | 'closed' | 'expired';

function isMode(value: unknown): value is Mode { return value === 'pvp' || value === 'pve'; }

export interface PrivateEconomyPolicy {
  policyId: 'private-zero-economy-v1';
  authority: 'server';
  roomCreationCost: 0;
  rewardMultiplier: 0;
  battleCosts: {
    commanders: 0;
    units: 0;
    abilities: 0;
    equipment: 0;
    consumables: 0;
  };
}

export interface PrivateBattleEntitlement {
  policyId: 'private-all-content-v1';
  authority: 'server';
  scope: 'private_battle_only';
  allContentUnlocked: true;
  persistToProfile: false;
}

export function privateEconomyPolicy(): PrivateEconomyPolicy {
  return {
    policyId: 'private-zero-economy-v1', authority: 'server', roomCreationCost: 0, rewardMultiplier: 0,
    battleCosts: { commanders: 0, units: 0, abilities: 0, equipment: 0, consumables: 0 },
  };
}

export function privateBattleEntitlement(): PrivateBattleEntitlement {
  return {
    policyId: 'private-all-content-v1', authority: 'server', scope: 'private_battle_only',
    allContentUnlocked: true, persistToProfile: false,
  };
}

export function validPrivateEconomyPolicy(value: unknown): value is PrivateEconomyPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) return false;
  const policy = value as Partial<PrivateEconomyPolicy>;
  const costs = policy.battleCosts;
  return policy.policyId === 'private-zero-economy-v1' && policy.authority === 'server' &&
    policy.roomCreationCost === 0 && policy.rewardMultiplier === 0 && !!costs && typeof costs === 'object' &&
    !Array.isArray(costs) &&
    Object.keys(costs).length === 5 && costs.commanders === 0 && costs.units === 0 && costs.abilities === 0 &&
    costs.equipment === 0 && costs.consumables === 0;
}

export function validPrivateBattleEntitlement(value: unknown): value is PrivateBattleEntitlement {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) return false;
  const entitlement = value as Partial<PrivateBattleEntitlement>;
  return entitlement.policyId === 'private-all-content-v1' && entitlement.authority === 'server' &&
    entitlement.scope === 'private_battle_only' && entitlement.allContentUnlocked === true &&
    entitlement.persistToProfile === false;
}

export interface Member {
  userId: string;
  displayName: string;
  commanderId: string;
  faction: string;
  loadout: VerifiedLoadout;
  team: 0 | 1;
  ready: boolean;
  joinedAt: number;
}

export interface PreparedMatch {
  matchId: string;
  battleId: string | null;
  createdBy: string;
  battleExpiresAt: number;
  roomConfig: { title: string; length: number };
  preparedAt: number;
  mode: Mode;
  ruleset: BattleRuleset;
  mapKey: NativeBattleMapKey;
  members: Member[];
  aiOpponents: number;
  aiTeam: 1 | null;
  enemyTier: number | null;
  tierPolicy: 'highest_deployed_unit' | null;
  economyPolicy: PrivateEconomyPolicy;
  battleEntitlement: PrivateBattleEntitlement;
  cpuRosterPolicy: { version: 1; seed: string; aiOpponents: number; aiTeam: 1 | null };
}

interface State {
  version: 5;
  ownerId: string;
  mode: Mode;
  ruleset: BattleRuleset;
  mapKey: NativeBattleMapKey;
  maxPlayers: number;
  aiOpponents: number;
  visibility: 'listed' | 'unlisted';
  roomConfig: { title: string; length: number };
  status: Status;
  createdAt: number;
  expiresAt: number;
  members: Member[];
  preparedMatch: PreparedMatch | null;
  lastReturn: { battleId: string; matchId: string; returnedBy: string } | null;
  terminalCleanup: { ownerId: string; battleId: string; matchId: string;
    battleExpiresAt: number; cleanupUntil: number; completed: boolean } | null;
}

type LegacyV4PreparedMatch = Omit<PreparedMatch, 'matchId' | 'battleId' | 'createdBy' | 'battleExpiresAt' | 'roomConfig' | 'cpuRosterPolicy'>;
type LegacyV4State = Omit<State, 'version' | 'preparedMatch' | 'lastReturn' | 'terminalCleanup' | 'visibility' | 'roomConfig'> & { version: 4; preparedMatch: LegacyV4PreparedMatch | null };

type LegacyV3PreparedMatch = Omit<PreparedMatch, 'economyPolicy' | 'battleEntitlement'>;
type LegacyV3State = Omit<State, 'version' | 'preparedMatch'> & {
  version: 3;
  preparedMatch: LegacyV3PreparedMatch | null;
};

type LegacyMember = Omit<Member, 'loadout'> & { loadout?: VerifiedLoadout };
type LegacyPreparedMatch = Omit<PreparedMatch,
  'ruleset' | 'mapKey' | 'members' | 'economyPolicy' | 'battleEntitlement'> & {
  mapKey: string;
  members: LegacyMember[];
};
interface LegacyState {
  version: 1 | 2;
  ownerId: string;
  mode: Mode;
  mapKey: string;
  maxPlayers: number;
  aiOpponents: number;
  status: Status;
  createdAt: number;
  expiresAt: number;
  members: LegacyMember[];
  preparedMatch: LegacyPreparedMatch | null;
}

// A concrete wire type also satisfies Cloudflare RPC's Serializable constraint.
interface Result {
  status: number;
  body: State | { error: string } | { left: boolean; status: Status } |
    { terminal: true; status: 'expired'; battleId: string; matchId: string; cleaned: true };
}

function coherentPrepared(room: { mode: Mode; ruleset: BattleRuleset; mapKey: string; maxPlayers: number;
  aiOpponents: number; status: Status }, prepared: LegacyV4PreparedMatch | PreparedMatch | null): boolean {
  if (!prepared) return room.status !== 'awaiting_gameplay_adapter';
  const ids = prepared.members.map(member => member.userId);
  const teams = prepared.members.map(member => member.team);
  return room.status === 'awaiting_gameplay_adapter' && prepared.mode === room.mode &&
    prepared.ruleset === room.ruleset && prepared.mapKey === room.mapKey &&
    prepared.members.length >= 1 && prepared.members.length <= room.maxPlayers && new Set(ids).size === ids.length &&
    teams.every(team => team === 0 || team === 1) &&
    (room.mode === 'pve' ? teams.every(team => team === 0) && prepared.aiTeam === 1 &&
      prepared.aiOpponents === room.aiOpponents : prepared.aiTeam === null && prepared.aiOpponents === 0 &&
      teams.includes(0) && teams.includes(1)) && validPrivateEconomyPolicy(prepared.economyPolicy) &&
    validPrivateBattleEntitlement(prepared.battleEntitlement);
}

function validCurrentPrepared(room: State): boolean {
  if (!validRoomConfig(room.roomConfig)) return false;
  if (room.terminalCleanup) {
    const terminal = room.terminalCleanup;
    if (room.status !== 'expired' || room.ownerId !== '' || room.members.length !== 0 || room.preparedMatch !== null ||
        !UUID.test(terminal.battleId) || !UUID.test(terminal.matchId) || !Number.isInteger(terminal.battleExpiresAt) ||
        terminal.cleanupUntil !== terminal.battleExpiresAt * 1000 + TERMINAL_CLEANUP_WINDOW_MS ||
        typeof terminal.completed !== 'boolean') return false;
  }
  const prepared = room.preparedMatch;
  if (!coherentPrepared(room, prepared)) return false;
  if (!prepared) return true;
  return UUID.test(prepared.matchId) && (prepared.battleId === null || UUID.test(prepared.battleId)) &&
    JSON.stringify(prepared.roomConfig) === JSON.stringify(room.roomConfig) &&
    prepared.battleExpiresAt === Math.floor(prepared.preparedAt / 1000) + PRIVATE_BATTLE_LIFETIME_SECONDS &&
    prepared.members.some(member => member.userId === prepared.createdBy) &&
    Object.keys(prepared.cpuRosterPolicy).length === 4 && prepared.cpuRosterPolicy.version === 1 &&
    prepared.cpuRosterPolicy.seed === `private-roster-v1:${prepared.matchId}` &&
    prepared.cpuRosterPolicy.aiOpponents === prepared.aiOpponents && prepared.cpuRosterPolicy.aiTeam === prepared.aiTeam;
}

function validRoomConfig(value: unknown): value is { title: string; length: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return false;
  const config = value as { title?: unknown; length?: unknown };
  return typeof config.title === 'string' && config.title === config.title.trim() && config.title.length >= 1 &&
    config.title.length <= 80 && !/[\u0000-\u001f\u007f-\u009f]/.test(config.title) &&
    typeof config.length === 'number' && Number.isInteger(config.length) && config.length >= 1 && config.length <= 7200;
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, code);
  }
  return value;
}

async function selected(actor: Actor, env: Env): Promise<{ commanderId: string; faction: string; loadout: VerifiedLoadout }> {
  if (!actor.commanderId || !actor.faction) throw new ApiError(409, 'commander_selection_required');
  // Ignore Actor.loadout supplied over an RPC boundary and resolve D1 state.
  const loadout = (await readSelection(actor.id, actor.commanderId, env)).loadout;
  if (actor.faction !== loadout.faction) throw new ApiError(409, 'loadout_faction_mismatch');
  return { commanderId: loadout.commanderId, faction: loadout.faction, loadout };
}

/** Room coordination only. No native battle, simulation, or rewards are claimed here. */
export class Room extends DurableObject<Env> {
  private room: State | null = null;

  async chat(actor: Actor, action: 'chat' | 'messages', body: Record<string, unknown>) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.expireIfDue();
        const room = this.room;
        if (!room || room.status === 'expired' || room.status === 'closed') throw new ApiError(410, 'room_expired');
        if (!room.members.some(member => member.userId === actor.id)) throw new ApiError(403, 'room_membership_required');
        return {status: 200, body: await channelChat(actor, action, body, 'chat:room', this.ctx.storage)};
      } catch (error) {
        if (error instanceof ApiError) return {status: error.status, body: {error: error.code}};
        throw error;
      }
    });
  }

  async directorySummary() {
    return this.ctx.blockConcurrencyWhile(async () => {
      const room = this.room;
      if (!room || room.visibility !== 'listed' || room.status !== 'open' || room.expiresAt <= Date.now()) return null;
      const owner = room.members.find(member => member.userId === room.ownerId);
      if (!owner) return null;
      return { ownerDisplayName: owner.displayName, mode: room.mode, ruleset: room.ruleset,
        mapKey: room.mapKey, members: room.members.length, maxPlayers: room.maxPlayers,
        aiOpponents: room.aiOpponents, roomConfig: structuredClone(room.roomConfig),
        expiresAt: Math.floor(room.expiresAt / 1000) };
    });
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<State | LegacyV4State | LegacyV3State | LegacyState>(STORAGE_KEY);
      if (!stored) return;
      if (!isMode(stored.mode)) throw new Error('invalid_room_state');
      if (stored.version === 5) {
        if ((stored.visibility !== 'listed' && stored.visibility !== 'unlisted') || !isBattleRuleset(stored.ruleset) ||
            !isMapKeyForRuleset(stored.mapKey, stored.ruleset) ||
            !validCurrentPrepared(stored)) {
          throw new Error('invalid_room_state');
        }
        this.room = stored;
        return;
      }
      if (stored.version === 4) {
        if (!isBattleRuleset(stored.ruleset) || !isMapKeyForRuleset(stored.mapKey, stored.ruleset) ||
            !coherentPrepared(stored, stored.preparedMatch)) throw new Error('invalid_room_state');
        const roomConfig = { title: 'Private Battle', length: 3600 };
        const prepared = stored.preparedMatch ? { ...stored.preparedMatch, matchId: crypto.randomUUID(), battleId: null,
          createdBy: stored.ownerId,
          battleExpiresAt: Math.floor(stored.preparedMatch.preparedAt / 1000) + PRIVATE_BATTLE_LIFETIME_SECONDS,
          roomConfig,
          cpuRosterPolicy: { version: 1 as const, seed: '', aiOpponents: stored.preparedMatch.aiOpponents,
            aiTeam: stored.preparedMatch.aiTeam } } : null;
        if (prepared) prepared.cpuRosterPolicy.seed = `private-roster-v1:${prepared.matchId}`;
        this.room = { ...stored, version: 5, visibility: 'unlisted', roomConfig, preparedMatch: prepared,
          lastReturn: null, terminalCleanup: null };
        await this.save();
        return;
      }
      if (stored.version === 3) {
        if (!isBattleRuleset(stored.ruleset) || !isMapKeyForRuleset(stored.mapKey, stored.ruleset) ||
            (stored.preparedMatch && (stored.preparedMatch.mode !== stored.mode ||
              stored.preparedMatch.ruleset !== stored.ruleset || stored.preparedMatch.mapKey !== stored.mapKey))) {
          throw new Error('invalid_room_state');
        }
        // Version 3 prepared rosters predate the battle-only entitlement contract.
        // Require a fresh ready/prepare cycle rather than silently blessing an
        // old admission manifest with broader private-match rights.
        const resetPreparation = stored.preparedMatch !== null || stored.status === 'awaiting_gameplay_adapter';
        this.room = {
          ...stored, version: 5, visibility: 'unlisted', roomConfig: { title: 'Private Battle', length: 3600 },
          lastReturn: null, terminalCleanup: null,
          members: resetPreparation ? stored.members.map(member => ({ ...member, ready: false })) : stored.members,
          preparedMatch: null,
          status: stored.status === 'awaiting_gameplay_adapter' ? 'open' : stored.status,
        };
        await this.save();
        return;
      }
      if (stored.version !== 1 && stored.version !== 2) throw new Error('unsupported_room_state');
      // Legacy rooms accepted arbitrary client map keys and v1 did not have a
      // verified unit roster. Migrate them to the conservative territory
      // ruleset, rebuild selections, and require everyone to ready again.
      this.room = {
        ...stored,
        version: 5, visibility: 'unlisted', roomConfig: { title: 'Private Battle', length: 3600 },
        ruleset: 'territory',
        mapKey: mapKeyForRuleset('territory'),
        members: stored.members.map(member => ({ ...member,
          loadout: starterLoadout(member.userId, member.commanderId), ready: false })),
        preparedMatch: null,
        lastReturn: null, terminalCleanup: null,
        status: stored.status === 'awaiting_gameplay_adapter' ? 'open' : stored.status,
      };
      await this.save();
    });
  }

  async command(actor: Actor, action: string, body: Record<string, unknown>): Promise<Result> {
    // Awaited writes must not let two simultaneous joins both consume the last slot.
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.expireIfDue();
        if (this.room?.status === 'expired') throw new ApiError(410, 'room_expired');
        if (action === 'create') return await this.create(actor, body);
        const room = this.room;
        if (!room) throw new ApiError(404, 'room_not_found');
        if (action === 'join') return await this.join(room, actor, body);
        const member = room.members.find(entry => entry.userId === actor.id);
        if (!member) throw new ApiError(403, 'room_membership_required');

        switch (action) {
          case 'get':
            fields(body, []);
            // Keep an open room's displayed roster current even before ready.
            // Prepared/closed manifests must never follow later profile edits.
            if (room.status === 'open') await this.synchronizeParticipants(room);
            return this.result();
          case 'leave':
            fields(body, []);
            if (room.preparedMatch?.battleId) {
              room.members = room.members.filter(entry => entry.userId !== actor.id);
              if (room.ownerId === actor.id && room.members.length) room.ownerId = room.members[0].userId;
              await this.save();
              return { status: 200, body: { left: true, status: room.status } };
            }
            room.members = room.members.filter(entry => entry.userId !== actor.id);
            if (room.members.length === 0) {
              room.status = 'closed';
              room.ownerId = '';
              room.preparedMatch = null;
            } else {
              if (room.ownerId === actor.id) room.ownerId = room.members[0].userId;
              // A prepared roster cannot survive the departure of one of its players.
              room.status = 'open';
              room.preparedMatch = null;
            }
            this.clearReadiness(room);
            await this.save();
            // A former member must not receive the remaining private roster.
            return { status: 200, body: { left: true, status: room.status } };
          case 'ready': {
            fields(body, ['ready']);
            this.requireOpen(room);
            if (typeof body.ready !== 'boolean') throw new ApiError(400, 'invalid_ready');
            const selection = await selected(actor, this.env);
            if (member.commanderId !== selection.commanderId || member.faction !== selection.faction ||
                !sameLoadout(member.loadout, selection.loadout)) {
              Object.assign(member, selection);
              this.clearReadiness(room);
              // The changed roster must be reviewed before anyone readies it.
            } else {
              member.ready = body.ready;
            }
            await this.save();
            return this.result();
          }
          case 'team': {
            fields(body, ['team']);
            this.requireOpen(room);
            const team = integer(body.team, 0, room.mode === 'pve' ? 0 : 1, 'invalid_team') as 0 | 1;
            if (team !== member.team) {
              if (room.members.filter(entry => entry.team === team).length >= 10) {
                throw new ApiError(409, 'team_full');
              }
              member.team = team;
              this.clearReadiness(room);
              await this.save();
            }
            return this.result();
          }
          case 'settings': {
            fields(body, ['mapKey', 'ruleset', 'maxPlayers', 'visibility', 'roomConfig']);
            if (room.ownerId !== actor.id) throw new ApiError(403, 'room_owner_required');
            this.requireOpen(room);
            if (!Object.keys(body).length) throw new ApiError(400, 'invalid_room_settings');
            const mapKey = body.mapKey === undefined ? room.mapKey : body.mapKey;
            const ruleset = requestedRuleset(body.ruleset === undefined ? room.ruleset : body.ruleset, mapKey);
            const maxPlayers = body.maxPlayers === undefined ? room.maxPlayers :
              integer(body.maxPlayers, room.mode === 'pvp' ? 2 : 1, room.mode === 'pvp' ? 20 : 10, 'invalid_max_players');
            if (maxPlayers < room.members.length) throw new ApiError(409, 'room_capacity_below_members');
            const visibility = body.visibility === undefined ? room.visibility : body.visibility;
            if (visibility !== 'listed' && visibility !== 'unlisted') throw new ApiError(400, 'invalid_visibility');
            const roomConfig = body.roomConfig === undefined ? room.roomConfig : body.roomConfig;
            if (!validRoomConfig(roomConfig)) throw new ApiError(400, 'invalid_room_config');
            if (room.mapKey !== mapKey || room.ruleset !== ruleset || room.maxPlayers !== maxPlayers ||
                room.visibility !== visibility || room.roomConfig.title !== roomConfig.title ||
                room.roomConfig.length !== roomConfig.length) {
              Object.assign(room, { mapKey, ruleset, maxPlayers, visibility, roomConfig });
              this.clearReadiness(room);
              await this.save();
            }
            return this.result();
          }
          case 'prepare': {
            fields(body, []);
            if (retiredPublicPve(this.env, room.mode)) throw new ApiError(409, 'battle_mode_removed');
            if (room.ownerId !== actor.id) throw new ApiError(403, 'room_owner_required');
            this.requireOpen(room);
            const synchronized = await this.synchronizeParticipants(room);
            if (synchronized.error) throw synchronized.error;
            if (synchronized.changed) throw new ApiError(409, 'loadout_changed');
            if (!room.members.every(entry => entry.ready)) throw new ApiError(409, 'players_not_ready');
            if (room.mode === 'pvp' && (room.members.length < 2 ||
              !room.members.some(entry => entry.team === 0) || !room.members.some(entry => entry.team === 1))) {
              throw new ApiError(409, 'both_teams_required');
            }
            const preparedAt = Date.now();
            room.preparedMatch = {
              matchId: crypto.randomUUID(), battleId: null, createdBy: room.ownerId,
              battleExpiresAt: Math.floor(preparedAt / 1000) + PRIVATE_BATTLE_LIFETIME_SECONDS,
              roomConfig: structuredClone(room.roomConfig),
              // This contains the revalidated roster and stays immutable after
              // preparation, including throughout later CPU control/reconnect.
              preparedAt, mode: room.mode, ruleset: room.ruleset, mapKey: room.mapKey,
              members: structuredClone(room.members), aiOpponents: room.aiOpponents,
              aiTeam: room.mode === 'pve' ? 1 : null,
              enemyTier: opponentTier(room.mode, room.members.map(member => member.loadout)),
              tierPolicy: room.mode === 'pve' ? 'highest_deployed_unit' : null,
              economyPolicy: privateEconomyPolicy(),
              battleEntitlement: privateBattleEntitlement(),
              cpuRosterPolicy: { version: 1, seed: '', aiOpponents: room.aiOpponents,
                aiTeam: room.mode === 'pve' ? 1 : null },
            };
            room.preparedMatch.cpuRosterPolicy.seed = `private-roster-v1:${room.preparedMatch.matchId}`;
            room.status = 'awaiting_gameplay_adapter';
            await this.save();
            return this.result();
          }
          case 'start':
            fields(body, []);
            throw new ApiError(409, 'use_room_start_route');
          default:
            throw new ApiError(404, 'room_action_not_found');
        }
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, body: { error: error.code } };
        throw error;
      }
    });
  }

  async claimStart(actorId: string, roomId: string, candidateBattleId: string): Promise<{
    status: number; claim?: { roomId: string; ownerId: string; match: PreparedMatch }; error?: string
  }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.expireIfDue();
      const room = this.room;
      if (!room || room.status === 'expired') return { status: 404, error: 'room_not_found' };
      const prepared = room.preparedMatch;
      if (!prepared || room.status !== 'awaiting_gameplay_adapter') return { status: 409, error: 'room_not_prepared' };
      // Retain idempotent access to already allocated battles, but never
      // allocate a fresh battle ID for a legacy PvE room.
      if (prepared.battleId === null && retiredPublicPve(this.env, prepared.mode)) {
        return { status: 409, error: 'battle_mode_removed' };
      }
      if (!prepared.members.some(member => member.userId === actorId)) return { status: 404, error: 'room_not_found' };
      if (prepared.battleId === null && room.ownerId !== actorId) return { status: 403, error: 'room_owner_required' };
      const now = Math.floor(Date.now() / 1000);
      const ids = prepared.members.map(member => member.userId);
      const active = await this.env.DB.prepare(`SELECT u.id FROM users u WHERE u.status = 'active'
        AND u.id IN (${ids.map(() => '?').join(',')}) AND EXISTS
        (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?)`)
        .bind(...ids, now).all<{ id: string }>();
      if (active.results.length !== ids.length) return { status: 409, error: 'private_participant_inactive' };
      if (prepared.battleId === null) {
        prepared.battleId = candidateBattleId;
        await this.save();
      }
      return { status: 200, claim: { roomId, ownerId: prepared.createdBy, match: structuredClone(prepared) } };
    });
  }

  async returnFromBattle(actorId: string, battleId: string): Promise<Result> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.expireIfDue();
      await this.cleanupTerminalIfDue();
      const room = this.room;
      if (!room) return { status: 404, body: { error: 'room_not_found' } };
      if (room.status === 'expired') {
        const terminal = room.terminalCleanup;
        if (!terminal || terminal.battleId !== battleId) return { status: 404, body: { error: 'room_not_found' } };
        if (terminal.ownerId !== actorId) return { status: 403, body: { error: 'room_owner_required' } };
        if (Date.now() < terminal.battleExpiresAt * 1000) {
          return { status: 409, body: { error: 'private_battle_not_returnable' } };
        }
        terminal.completed = true;
        await this.save();
        return { status: 200, body: { terminal: true, status: 'expired', battleId: terminal.battleId,
          matchId: terminal.matchId, cleaned: true } };
      }
      if (room.ownerId !== actorId) return { status: 403, body: { error: 'room_owner_required' } };
      if (room.lastReturn?.battleId === battleId && room.lastReturn.returnedBy === actorId) return this.result();
      if (!room.preparedMatch?.battleId || room.preparedMatch.battleId !== battleId) {
        return { status: 409, body: { error: 'private_battle_mismatch' } };
      }
      room.lastReturn = { battleId, matchId: room.preparedMatch.matchId, returnedBy: actorId };
      room.preparedMatch = null;
      room.status = 'open';
      if (!room.members.some(member => member.userId === room.ownerId) && room.members.length) {
        room.ownerId = room.members[0].userId;
      }
      this.clearReadiness(room);
      await this.save();
      return this.result();
    });
  }

  async authorizeReturn(actorId: string, battleId: string): Promise<{
    status: number; error?: string; matchId?: string
  }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.expireIfDue();
      await this.cleanupTerminalIfDue();
      const room = this.room;
      if (!room) return { status: 404, error: 'room_not_found' };
      if (room.status === 'expired') {
        const terminal = room.terminalCleanup;
        if (!terminal || terminal.battleId !== battleId) return { status: 404, error: 'room_not_found' };
        if (terminal.ownerId !== actorId) return { status: 403, error: 'room_owner_required' };
        return Date.now() >= terminal.battleExpiresAt * 1000 ?
          { status: 200, matchId: terminal.matchId } :
          { status: 409, error: 'private_battle_not_returnable' };
      }
      if (room.ownerId !== actorId) return { status: 403, error: 'room_owner_required' };
      if (room.lastReturn?.battleId === battleId && room.lastReturn.returnedBy === actorId) {
        return { status: 200, matchId: room.lastReturn.matchId };
      }
      if (!room.preparedMatch?.battleId || room.preparedMatch.battleId !== battleId) {
        return { status: 409, error: 'private_battle_mismatch' };
      }
      return { status: 200, matchId: room.preparedMatch.matchId };
    });
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.expireIfDue();
      await this.cleanupTerminalIfDue();
      // Alarm delivery may be early or retried; always enforce the stored deadline.
      if (this.room && this.room.status !== 'expired' && this.room.expiresAt > Date.now()) {
        await this.ctx.storage.setAlarm(this.room.expiresAt);
      } else if (this.room?.terminalCleanup) {
        await this.ctx.storage.setAlarm(this.room.terminalCleanup.cleanupUntil);
      }
    });
  }

  private async create(actor: Actor, body: Record<string, unknown>): Promise<Result> {
    fields(body, ['mode', 'ruleset', 'mapKey', 'maxPlayers', 'aiOpponents', 'visibility', 'roomConfig']);
    if (this.room) throw new ApiError(409, 'room_already_exists');
    const selection = await selected(actor, this.env);
    if (!isMode(body.mode)) throw new ApiError(400, 'invalid_mode');
    const ruleset = requestedRuleset(body.ruleset, body.mapKey);
    const mode = body.mode;
    const maxPlayers = integer(body.maxPlayers, mode === 'pvp' ? 2 : 1, mode === 'pvp' ? 20 : 10, 'invalid_max_players');
    const aiOpponents = integer(body.aiOpponents, mode === 'pve' ? 1 : 0, mode === 'pve' ? 10 : 0, 'invalid_ai_opponents');
    const visibility = body.visibility ?? 'unlisted';
    if (visibility !== 'listed' && visibility !== 'unlisted') throw new ApiError(400, 'invalid_visibility');
    const roomConfig = body.roomConfig ?? { title: 'Private Battle', length: 3600 };
    if (!validRoomConfig(roomConfig)) throw new ApiError(400, 'invalid_room_config');
    const now = Date.now();
    this.room = {
      version: 5, ownerId: actor.id, mode, ruleset,
      mapKey: (body.mapKey === undefined ? mapKeyForRuleset(ruleset) : body.mapKey) as NativeBattleMapKey,
      maxPlayers, aiOpponents,
      visibility, roomConfig,
      status: 'open', createdAt: now, expiresAt: now + LIFETIME_MS,
      members: [{ userId: actor.id, displayName: actor.displayName, ...selection, team: 0, ready: false, joinedAt: now }],
      preparedMatch: null, lastReturn: null, terminalCleanup: null,
    };
    await this.save();
    await this.ctx.storage.setAlarm(this.room.expiresAt);
    return this.result(201);
  }

  private async join(room: State, actor: Actor, body: Record<string, unknown>): Promise<Result> {
    fields(body, []);
    this.requireOpen(room);
    const selection = await selected(actor, this.env);
    if (room.members.some(entry => entry.userId === actor.id)) return this.result();
    if (room.members.length >= room.maxPlayers) throw new ApiError(409, 'room_full');
    const count0 = room.members.filter(entry => entry.team === 0).length;
    const count1 = room.members.length - count0;
    const team: 0 | 1 = room.mode === 'pve' || count0 <= count1 ? 0 : 1;
    if ((team === 0 ? count0 : count1) >= 10) throw new ApiError(409, 'team_full');
    room.members.push({ userId: actor.id, displayName: actor.displayName, ...selection, team, ready: false, joinedAt: Date.now() });
    this.clearReadiness(room);
    await this.save();
    return this.result();
  }

  private requireOpen(room: State): void {
    if (room.status !== 'open') throw new ApiError(409, room.status === 'closed' ? 'room_closed' : 'room_prepared');
  }

  private clearReadiness(room: State): void {
    for (const entry of room.members) entry.ready = false;
  }

  private async synchronizeParticipants(room: State): Promise<{ changed: boolean; error: ApiError | null }> {
    // The roster is bounded to 20 by create/join. IDs remain bound SQL values.
    const ids = room.members.map(member => member.userId);
    const rows = await this.env.DB.prepare(
      `SELECT u.id, u.commander_id, ul.commander_id AS loadout_commander_id,
        ul.item_ids AS loadout_item_ids, ul.revision AS loadout_revision
        FROM users u LEFT JOIN user_loadouts ul ON ul.user_id = u.id
        WHERE u.status = 'active' AND u.id IN (${ids.map(() => '?').join(',')})`,
    ).bind(...ids).all<{ id: string; commander_id: string | null; loadout_commander_id: string | null;
      loadout_item_ids: string | null; loadout_revision: number | null }>();
    const profiles = new Map(rows.results.map(row => [row.id, row]));
    let changed = false;
    let validationError: ApiError | null = null;
    try {
      if (ids.some(id => !profiles.has(id))) throw new ApiError(403, 'participant_inactive');
      // Re-resolve the complete roster from one D1 read, including other users.
      // No request field or stale ready snapshot can override catalog Tier.
      const loadouts = room.members.map(member => {
        const commanderId = profiles.get(member.userId)!.commander_id;
        if (!commanderId) throw new ApiError(409, 'participant_loadout_invalid');
        const profile = profiles.get(member.userId)!;
        return profile.loadout_revision != null && profile.loadout_commander_id && profile.loadout_item_ids ?
          resolveSelectionRow(member.userId, commanderId, { commander_id: profile.loadout_commander_id,
            item_ids: profile.loadout_item_ids, revision: profile.loadout_revision }).loadout :
          starterLoadout(member.userId, commanderId);
      });
      room.members.forEach((member, index) => {
        const loadout = loadouts[index];
        if (member.commanderId !== loadout.commanderId || member.faction !== loadout.faction ||
            !sameLoadout(member.loadout, loadout)) {
          Object.assign(member, { commanderId: loadout.commanderId, faction: loadout.faction, loadout });
          changed = true;
        }
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      validationError = error.code === 'participant_inactive' ? error : new ApiError(409, 'participant_loadout_invalid');
    }
    if (changed || validationError) {
      const needsSave = changed || room.members.some(member => member.ready);
      this.clearReadiness(room);
      if (needsSave) await this.save();
    }
    // A future native adapter must recheck bans/ownership at admission, then
    // retain the prepared unit/Tier snapshot throughout CPU control/reconnect.
    // GET still permits members to inspect a room with an invalid participant;
    // prepare consumes this error and refuses to freeze its last valid roster.
    return { changed, error: validationError };
  }

  private async expireIfDue(): Promise<void> {
    if (!this.room || this.room.status === 'expired' || this.room.expiresAt > Date.now()) return;
    this.room.status = 'expired';
    if (this.room.preparedMatch?.battleId) {
      this.room.terminalCleanup = { ownerId: this.room.ownerId, battleId: this.room.preparedMatch.battleId,
        matchId: this.room.preparedMatch.matchId, battleExpiresAt: this.room.preparedMatch.battleExpiresAt,
        cleanupUntil: this.room.preparedMatch.battleExpiresAt * 1000 + TERMINAL_CLEANUP_WINDOW_MS, completed: false };
    }
    this.room.ownerId = '';
    this.room.members = [];
    this.room.preparedMatch = null;
    await this.save();
    if (this.room.terminalCleanup) await this.ctx.storage.setAlarm(this.room.terminalCleanup.cleanupUntil);
    else await this.ctx.storage.deleteAlarm();
  }

  private async cleanupTerminalIfDue(): Promise<void> {
    const terminal = this.room?.terminalCleanup;
    if (!terminal || Date.now() < terminal.cleanupUntil) return;
    this.room!.terminalCleanup = null;
    await this.save();
    await this.ctx.storage.deleteAlarm();
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, this.room);
  }

  private result(status = 200): Result {
    // Do not let an in-process caller hold mutable references to Durable Object state.
    if (!this.room) throw new ApiError(404, 'room_not_found');
    return { status, body: structuredClone(this.room) };
  }
}
