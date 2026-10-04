import { DurableObject } from 'cloudflare:workers';
import { ApiError, fields } from './http';
import {
  opponentTier, sameLoadout, SANDBOX_EFFECTIVE_UNIT_TIER,
  type VerifiedLoadout,
} from './loadouts';
import { resolveSelectionRow } from './loadout-selection';
import { groupActive, groupIdentifier, GROUP_ADMISSION_RETENTION_MS, GROUP_ADMISSION_CAPACITY, type GroupAdmissionAttempt } from './group-admission';
import type { Actor, Env } from './types';
import {
  chooseMapKeyForRuleset, isBattleMode, isBattleRuleset, legacyRewardPolicy, mapKeyForRuleset, requestedRuleset, rewardPolicy, validRewardPolicy,
  type BattleMode, type BattleRuleset, type StandardRewardPolicy,
} from './battle-rules';
import { isMapKeyForRuleset, type NativeBattleMapKey } from './native-battle-maps';
import { requirePublicQueueRuleset, retiredPublicPve } from './native-release';
import { observeBattleAdmission } from './battle-admission';
import {
  activeCapuaReservation, bindCapuaReservation, CAPUA_TEST_MAP, configuredCapuaReservation,
  validCapuaReservationHistory, type BoundCapuaReservation,
} from './native-pvp-capua-reservation';

const STORAGE_KEY = 'matchmaking';
// Frozen assignment snapshots consumed by POST /v1/battles/from-assignment.
// Kept under a separate key so the versioned queue state stays untouched.
const CLAIMS_KEY = 'assignment-claims';
// v1 was briefly used by the Tier-X rollout. Its migration rewrote only the
// Matchmaker snapshot and could therefore disagree with an already-created D1
// battle. v2 is a clean boundary: every older in-flight claim is revoked
// instead of being rewritten in isolation.
const CLAIMS_VERSION = 2;
const CLAIM_LIFETIME_MS = 2 * 60 * 60_000;
// How long a claimed assignment stays visible in GET /v1/matchmaking for a
// seat without a queue ticket (assignment lifetime + roster wait, with margin).
const CLAIM_VISIBILITY_MS = 10 * 60_000;
const CLAIM_CAPACITY = 256;
// A failed relay observation is safe to share briefly: it can postpone
// release, but can never authorize a new battle for a still-active seat.
const RELAY_FAILURE_RETRY_MS = 5_000;
const CAPACITY = 64;
const QUEUE_LIFETIME_MS = 5 * 60_000;
const ASSIGNMENT_LIFETIME_MS = 2 * 60_000;
const REVALIDATE_MS = 30_000;
const COLLECTION_IDLE_MS = 2 * 60_000;
const PVE_MAX_HUMANS = 10;
const PVP_MAX_HUMANS = 20;
const PVP_SEATS_PER_TEAM = 10;
type Mode = BattleMode;

const isMode = isBattleMode;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export { validRewardPolicy };
export type { StandardRewardPolicy };

/** One frozen seat of a claimed assignment. `playerId` is the 1-based native
 * player ordinal and `seat` its 0-based slot index; both are stable for the
 * life of the battle so relay tickets and result reports agree.
 */
export interface AssignmentParticipant {
  userId: string;
  displayName: string;
  team: 0 | 1;
  playerId: number;
  seat: number;
  loadout: VerifiedLoadout;
}

export interface AssignmentClaim {
  assignmentId: string;
  battleId: string;
  mode: Mode;
  ruleset: BattleRuleset;
  mapKey: NativeBattleMapKey;
  rewardPolicy: StandardRewardPolicy;
  claimedAt: number;
  expiresAt: number;
  participants: AssignmentParticipant[];
  /** Actual multi-person admissions, frozen before queue entries are released. */
  partyGroups?: string[][];
  /** Absent on legacy claims that may already have a D1/relay manifestation. */
  rosterPolicy?: PvpRosterPolicy;
}

export interface PvpRosterPolicy {
  version: 1 | 2 | 3 | 4 | 5;
  totalSeats: 20;
  seatsPerTeam: 10;
  unitsPerSeat: 3;
  humanParticipantsOnly: true;
  cpuFill: true;
  seed: string;
}

export function validPvpRosterPolicy(value: unknown, mode: Mode = 'pvp'): value is PvpRosterPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return Object.keys(policy).length === 7 && (policy.version === 1 || policy.version === 2 || policy.version === 3 || policy.version === 4 || policy.version === 5) && policy.totalSeats === 20 &&
    policy.seatsPerTeam === 10 && policy.unitsPerSeat === 3 && policy.humanParticipantsOnly === true &&
    policy.cpuFill === true && typeof policy.seed === 'string' &&
    policy.seed.startsWith(`${mode}-roster-v${policy.version}:`) && UUID.test(policy.seed.slice(`${mode}-roster-v${policy.version}:`.length));
}

interface ClaimsState { version: 2; claims: AssignmentClaim[] }
interface LegacyVersionedClaimsState { version: 1; claims: AssignmentClaim[] }
type LegacyClaimsState = AssignmentClaim[];

function assignmentIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assignmentId = (value as { assignmentId?: unknown }).assignmentId;
  return typeof assignmentId === 'string' && UUID.test(assignmentId) ? assignmentId : null;
}

function tierXClaim(claim: unknown): claim is AssignmentClaim {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return false;
  const typedClaim = claim as { assignmentId?: unknown; mode?: unknown; rosterPolicy?: unknown; participants?: unknown };
  const participants = typedClaim.participants;
  const policy = typedClaim.rosterPolicy;
  if (!Array.isArray(participants)) return false;
  if (policy === undefined) {
    if ((typedClaim.mode === 'pve' && participants.length !== 1) ||
        (typedClaim.mode === 'pvp' && participants.length !== 2)) return false;
  } else {
    if (!isMode(typedClaim.mode) || !validPvpRosterPolicy(policy, typedClaim.mode) || participants.length < 1 ||
        participants.length > (typedClaim.mode === 'pve' ? PVE_MAX_HUMANS : PVP_MAX_HUMANS) ||
        policy.seed !== `${typedClaim.mode}-roster-v${policy.version}:${typedClaim.assignmentId}`) return false;
  }
  const userIds = new Set<string>();
  const teams = [0, 0];
  return participants.every((participant, index) => {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return false;
    const seat = participant as { userId?: unknown; team?: unknown; playerId?: unknown; seat?: unknown; loadout?: unknown };
    if (typeof seat.userId !== 'string' || userIds.has(seat.userId) || seat.seat !== index ||
        seat.playerId !== index + 1 || (seat.team !== 0 && seat.team !== 1) ||
        (typedClaim.mode === 'pve' && seat.team !== 0) ||
        ((!policy || (policy as PvpRosterPolicy).version === 1) && seat.team !== (typedClaim.mode === 'pve' ? 0 : index % 2))) return false;
    if (++teams[seat.team] > PVP_SEATS_PER_TEAM) return false;
    userIds.add(seat.userId);
    const loadout = (participant as { loadout?: unknown }).loadout;
    if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) return false;
    const typed = loadout as { maxTier?: unknown; units?: unknown };
    return typed.maxTier === SANDBOX_EFFECTIVE_UNIT_TIER && Array.isArray(typed.units) &&
      typed.units.length === 3 && typed.units.every(unit => !!unit && typeof unit === 'object' &&
        !Array.isArray(unit) && (unit as { tier?: unknown }).tier === SANDBOX_EFFECTIVE_UNIT_TIER);
  });
}

function claimsState(stored: unknown): {
  state: ClaimsState;
  migrated: boolean;
  invalidatedAssignmentIds: string[];
} {
  if (stored === undefined) {
    return { state: { version: CLAIMS_VERSION, claims: [] }, migrated: false, invalidatedAssignmentIds: [] };
  }
  if (Array.isArray(stored)) {
    // There is no transaction spanning Matchmaker storage, D1 and the relay
    // Durable Object. Rewriting only these loadouts would create a mixed-tier
    // battle, so pre-versioned claims must be retried through matchmaking.
    return {
      state: { version: CLAIMS_VERSION, claims: [] },
      migrated: true,
      invalidatedAssignmentIds: stored.map(assignmentIdOf).filter((id): id is string => id !== null),
    };
  }
  if (!stored || typeof stored !== 'object') throw new Error('unsupported_matchmaking_claims_state');
  const candidate = stored as { version?: unknown; claims?: unknown };
  if ((candidate.version !== 1 && candidate.version !== CLAIMS_VERSION) || !Array.isArray(candidate.claims)) {
    throw new Error('unsupported_matchmaking_claims_state');
  }
  if (candidate.version === 1) {
    // v1 may already contain the result of the unsafe one-store migration, so
    // even apparently Tier-X v1 claims cannot prove that D1 agrees with them.
    return {
      state: { version: CLAIMS_VERSION, claims: [] },
      migrated: true,
      invalidatedAssignmentIds: candidate.claims.map(assignmentIdOf).filter((id): id is string => id !== null),
    };
  }
  const valid = candidate.claims.filter(tierXClaim);
  const invalidatedAssignmentIds = candidate.claims.filter(claim => !tierXClaim(claim))
    .map(assignmentIdOf).filter((id): id is string => id !== null);
  return {
    state: { version: CLAIMS_VERSION, claims: valid },
    migrated: valid.length !== candidate.claims.length,
    invalidatedAssignmentIds,
  };
}

export type ClaimResult = { status: 200 | 201; claim: AssignmentClaim } | { status: number; error: string };

interface Entry {
  ticketId: string;
  userId: string;
  displayName: string;
  mode: Mode;
  ruleset: BattleRuleset;
  loadout: VerifiedLoadout;
  enqueuedAt: number;
  expiresAt: number;
  assignmentId: string | null;
  collectionDeadline: number | null;
  groupAttemptId?: string;
  groupPosition?: number;
  loadoutRevision?: number;
}

interface Assignment {
  id: string;
  mode: Mode;
  ruleset: BattleRuleset;
  mapKey: NativeBattleMapKey;
  preparedAt: number;
  expiresAt: number;
  userIds: string[];
  rewardPolicy: StandardRewardPolicy;
  /** null is an explicit frozen legacy assignment boundary. */
  rosterPolicy: PvpRosterPolicy | null;
  /** Versions 2 through 5 freeze explicit teams; version 1 retains parity. */
  teams?: Array<0 | 1>;
}

interface State {
  version: 4; entries: Entry[]; assignments: Assignment[]; groupAttempts?: GroupAdmissionAttempt[];
  // Optional, internal-only tombstones share the queue's atomic commit. No
  // public DTO or existing assignment/claim schema changes for this trial.
  capuaTestReservations?: BoundCapuaReservation[];
}
type LegacyV3Entry = Omit<Entry, 'collectionDeadline'>;
type LegacyV3Assignment = Omit<Assignment, 'rosterPolicy'>;
interface LegacyV3State { version: 3; entries: LegacyV3Entry[]; assignments: LegacyV3Assignment[] }
type LegacyV2Entry = Omit<Entry, 'collectionDeadline'>;
type LegacyV2Assignment = Omit<Assignment, 'rewardPolicy' | 'rosterPolicy'>;
interface LegacyV2State { version: 2; entries: LegacyV2Entry[]; assignments: LegacyV2Assignment[] }
type LegacyEntry = Omit<Entry, 'ruleset' | 'collectionDeadline'>;
type LegacyAssignment = Omit<Assignment, 'ruleset' | 'mapKey' | 'rewardPolicy' | 'rosterPolicy'>;
interface LegacyState { version: 1; entries: LegacyEntry[]; assignments: LegacyAssignment[] }
interface Profile { id: string; displayName: string; active: boolean; hasSession: boolean; loadout: VerifiedLoadout | null; loadoutRevision: number | null }

function validState(state: State): boolean {
  if (state.capuaTestReservations !== undefined && !validCapuaReservationHistory(state.capuaTestReservations)) return false;
  const users = new Set(state.entries.map(entry => entry.userId));
  const tickets = new Set(state.entries.map(entry => entry.ticketId));
  const assignmentIds = new Set(state.assignments.map(assignment => assignment.id));
  if (users.size !== state.entries.length || tickets.size !== state.entries.length ||
      assignmentIds.size !== state.assignments.length) return false;
  if (state.entries.some(entry => !isMode(entry.mode) || !isBattleRuleset(entry.ruleset) ||
      (entry.collectionDeadline !== null &&
        (!Number.isSafeInteger(entry.collectionDeadline) || entry.collectionDeadline < entry.enqueuedAt ||
          entry.collectionDeadline > entry.expiresAt)))) return false;
  for (const assignment of state.assignments) {
    if (!isMode(assignment.mode) || !isBattleRuleset(assignment.ruleset) ||
        !isMapKeyForRuleset(assignment.mapKey, assignment.ruleset) ||
        !validRewardPolicy(assignment.rewardPolicy, assignment.mode) ||
        (assignment.rosterPolicy !== null &&
          !validPvpRosterPolicy(assignment.rosterPolicy, assignment.mode)) ||
        (assignment.rosterPolicy === null ? assignment.userIds.length !== (assignment.mode === 'pve' ? 1 : 2) :
          assignment.userIds.length < 1 || assignment.userIds.length > (assignment.mode === 'pve' ? PVE_MAX_HUMANS : PVP_MAX_HUMANS)) ||
        new Set(assignment.userIds).size !== assignment.userIds.length) return false;
    if (assignment.rosterPolicy?.seed !== undefined && assignment.rosterPolicy.seed !==
        `${assignment.mode}-roster-v${assignment.rosterPolicy.version}:${assignment.id}`) return false;
    if (assignment.rosterPolicy?.version === 2 || assignment.rosterPolicy?.version === 3 || assignment.rosterPolicy?.version === 4 || assignment.rosterPolicy?.version === 5) {
      if (!Array.isArray(assignment.teams) || assignment.teams.length !== assignment.userIds.length ||
          assignment.teams.some(team => (team !== 0 && team !== 1) || (assignment.mode === 'pve' && team !== 0)) ||
          [0, 1].some(team => assignment.teams!.filter(t => t === team).length > 10)) return false;
    } else if (assignment.teams !== undefined) return false;
    const members = assignment.userIds.map(userId => state.entries.find(entry => entry.userId === userId));
    if (members.some(member => !member) || members.some(member => member!.assignmentId !== assignment.id ||
        member!.mode !== assignment.mode || member!.ruleset !== assignment.ruleset)) return false;
  }
  const attempts = state.groupAttempts ?? [];
  if (!Array.isArray(attempts) || new Set(attempts.map(a => a.attemptId)).size !== attempts.length ||
      attempts.some(a => !validGroupAttempt(a))) return false;
  for (const attempt of attempts) {
    if (!Number.isSafeInteger(attempt.matchmakerRevision) || attempt.matchmakerRevision! < 1 ||
        ['pending', 'cancelling'].includes(attempt.phase)) return false;
    if (attempt.phase === 'battle' && (!attempt.assignmentId || !attempt.battleId || !attempt.battleExpiresAt)) return false;
    const seats = state.entries.filter(e => e.groupAttemptId === attempt.attemptId);
    if (['queued', 'assigned'].includes(attempt.phase)) {
      if (seats.length !== attempt.members.length || attempt.members.some((member, position) =>
          !seats.some(e => e.userId === member.userId && e.groupPosition === position &&
            e.mode === attempt.mode && e.ruleset === attempt.ruleset &&
            e.loadoutRevision === member.loadoutRevision && sameLoadout(e.loadout, member.loadout)))) return false;
      if (new Set(seats.map(e => e.assignmentId)).size !== 1 ||
          (attempt.phase === 'queued' && (attempt.assignmentId !== undefined || seats[0].assignmentId !== null)) ||
          (attempt.phase === 'assigned' && (!attempt.assignmentId || seats[0].assignmentId !== attempt.assignmentId))) return false;
      if (seats[0].assignmentId) {
        const assignment = state.assignments.find(a => a.id === seats[0].assignmentId)!;
        if ((assignment.rosterPolicy?.version !== 2 && assignment.rosterPolicy?.version !== 3 && assignment.rosterPolicy?.version !== 4 && assignment.rosterPolicy?.version !== 5) ||
            new Set(seats.map(e => assignment.teams![assignment.userIds.indexOf(e.userId)])).size !== 1) return false;
      }
    } else if (seats.length) return false;
  }
  if (state.entries.some(e => e.groupAttemptId !== undefined && !attempts.some(a =>
      a.attemptId === e.groupAttemptId && a.members.some(m => m.userId === e.userId)))) return false;
  return state.entries.every(entry => entry.assignmentId === null ||
    state.assignments.some(assignment => assignment.id === entry.assignmentId && assignment.userIds.includes(entry.userId)));
}

export interface MatchmakingView {
  status: 'idle' | 'queued' | 'awaiting_gameplay_adapter';
  nativeBattles: false;
  pollAfterMs: number | null;
  ticket: {
    id: string; mode: Mode; ruleset: BattleRuleset; enqueuedAt: number; expiresAt: number; loadout: VerifiedLoadout;
  } | null;
  assignment: {
    id: string;
    // Present once either participant has claimed the assignment: the battle
    // both seats converge on via POST /v1/battles/from-assignment.
    battleId?: string;
    claimed?: boolean;
    mode: Mode;
    ruleset: BattleRuleset;
    preparedAt: number;
    expiresAt: number;
    mapKey: NativeBattleMapKey;
    humanPlayers: number;
    aiOpponents: number;
    cpuSeatsByTeam: [number, number];
    enemyTier: number | null;
    battleTier: number;
    tierPolicy: 'highest_deployed_unit';
    rewardPolicy: StandardRewardPolicy;
    participants: Array<{ userId: string; displayName: string; team: 0 | 1; loadout: VerifiedLoadout }>;
    rosterPolicy: PvpRosterPolicy | null;
    unavailableReason: 'native_adapter_unavailable';
  } | null;
}

interface Result { status: number; body: MatchmakingView | { error: string } }

/** Small private-server queue, not a battle allocator or an EOS Session.
 * One namespace name covers BOTH modes so an account cannot queue twice by
 * changing mode. Never shard this by mode/Tier without a global admission lease.
 */
export class Matchmaker extends DurableObject<Env> {
  private state: State = { version: 4, entries: [], assignments: [] };
  private readonly relayFailureRetryAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<State | LegacyV3State | LegacyV2State | LegacyState>(STORAGE_KEY);
      if (stored) {
        if (stored.version === 4) {
          if (!validState(stored)) throw new Error('invalid_matchmaking_state');
          this.state = stored;
        } else if (stored.version === 3) {
          this.state = {
            version: 4,
            entries: stored.entries.map(entry => ({ ...entry, collectionDeadline: null })),
            assignments: stored.assignments.map(assignment => ({ ...assignment, rosterPolicy: null })),
          };
          if (!validState(this.state)) throw new Error('invalid_matchmaking_state');
          await ctx.storage.put(STORAGE_KEY, this.state);
        } else if (stored.version === 2) {
          this.state = {
            version: 4,
            entries: stored.entries.map(entry => ({ ...entry, collectionDeadline: null })),
            assignments: stored.assignments.map(assignment => ({ ...assignment,
              rewardPolicy: legacyRewardPolicy(assignment.mode), rosterPolicy: null })),
          };
          if (!validState(this.state)) throw new Error('invalid_matchmaking_state');
          await ctx.storage.put(STORAGE_KEY, this.state);
        } else if (stored.version === 1) {
          // Version 1 had only PvP/PvE. Preserve its effective behavior as the
          // territory ruleset, including any already prepared assignment IDs.
          this.state = {
            version: 4,
            entries: stored.entries.map(entry => ({ ...entry, ruleset: 'territory', collectionDeadline: null })),
            assignments: stored.assignments.map(assignment => ({ ...assignment,
              ruleset: 'territory', mapKey: mapKeyForRuleset('territory'),
              rewardPolicy: legacyRewardPolicy(assignment.mode), rosterPolicy: null })),
          };
          if (!validState(this.state)) throw new Error('invalid_matchmaking_state');
          await ctx.storage.put(STORAGE_KEY, this.state);
        } else throw new Error('unsupported_matchmaking_state');
      }
      // Finish claim migration before this instance serves requests. Claims and
      // any matching queue assignment are revoked in one DO transaction;
      // D1/relay snapshots are deliberately left untouched and consistent.
      await this.loadClaims(Date.now());
    });
  }

  async command(actor: Actor, action: string, body: Record<string, unknown>): Promise<Result> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (!['join', 'get', 'cancel'].includes(action)) throw new ApiError(404, 'matchmaking_action_not_found');
        fields(body, action === 'join' ? ['mode', 'ruleset'] : []);
        if (action === 'join' && !isMode(body.mode)) throw new ApiError(400, 'invalid_mode');
        const ruleset = action === 'join' ? requestedRuleset(body.ruleset) : null;
        if (action === 'join') requirePublicQueueRuleset(this.env, ruleset!, body.mode);
        if (typeof actor.id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(actor.id)) throw new ApiError(403, 'account_disabled');

        const now = Date.now();
        const next = structuredClone(this.state);
        // Ignore Actor commander/faction/loadout: even a stale RPC caller must
        // use the current D1 account, session lease and catalog entitlements.
        const profiles = await this.profiles([...new Set([...next.entries.map(e => e.userId), actor.id])], now);
        this.reconcile(next, profiles, now);
        // A late arrival cannot reopen a collection whose deadline elapsed
        // before its request, even if the scheduled alarm was delayed.
        if (action === 'join') this.pair(next, now);
        let status = 200;
        let failure: ApiError | null = null;
        try {
          const profile = profiles.get(actor.id);
          if (!profile?.active) throw new ApiError(403, 'account_disabled');
          if (!profile.hasSession) throw new ApiError(401, 'session_expired');
          const existing = next.entries.find(e => e.userId === actor.id);
          if (action === 'cancel') {
            this.remove(next, actor.id);
          } else if (action === 'join') {
            if ((next.groupAttempts ?? []).some(a => groupActive(a) && a.members.some(m => m.userId === actor.id))) throw new ApiError(409, 'party_attempt_active');
            if (!profile.loadout) throw new ApiError(409, 'commander_selection_required');
            if (existing && existing.mode !== body.mode) throw new ApiError(409, 'already_queued_other_mode');
            if (existing && existing.ruleset !== ruleset) throw new ApiError(409, 'already_queued_other_ruleset');
            if (!existing) {
              if (next.entries.length >= CAPACITY) throw new ApiError(503, 'matchmaking_capacity_reached');
              next.entries.push({
                ticketId: crypto.randomUUID(), userId: actor.id, displayName: profile.displayName,
                mode: body.mode as Mode, ruleset: ruleset!, loadout: profile.loadout, enqueuedAt: now,
                expiresAt: now + QUEUE_LIFETIME_MS, assignmentId: null,
                collectionDeadline: null,
              });
              // Only a new authenticated seat resets the inactivity timer.
              // Polls, duplicate joins, cancellations and profile edits do not.
              const poolKey = this.poolKey(next, next.entries.at(-1)!, now);
              const pool = next.entries.filter(e => e.assignmentId === null && this.poolKey(next, e, now) === poolKey);
              const deadline = Math.min(now + COLLECTION_IDLE_MS, ...pool.map(e => e.enqueuedAt + QUEUE_LIFETIME_MS));
              for (const entry of pool) entry.collectionDeadline = deadline;
              status = 202;
            }
            // Repeated joins neither create another seat nor extend a lease.
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          failure = error;
        }
        this.pair(next, now);
        // Persist ban/expiry cleanup even when this caller's action was rejected.
        await this.commit(next, now);
        if (failure) throw failure;
        return { status, body: await this.view(actor.id) };
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, body: { error: error.code } };
        throw error;
      }
    });
  }

  /** Server-only Social lease handoff. HTTP callers never provide a roster.
   * Queue seats, attempt status and cancel tombstones share one transaction. */
  async group(actor: Actor, action: 'reserve' | 'get' | 'cancel' | 'finish', frozen: GroupAdmissionAttempt): Promise<{
    status: number; body: { attempt: GroupAdmissionAttempt | null; view: MatchmakingView } | { error: string };
  }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        if (!validGroupAttempt(frozen) || !frozen.members.some(m => m.userId === actor.id)) throw new ApiError(404, 'party_attempt_not_found');
        if (!['reserve', 'get', 'cancel', 'finish'].includes(action)) throw new ApiError(404, 'matchmaking_action_not_found');
        if (action === 'reserve') requirePublicQueueRuleset(this.env, frozen.ruleset, frozen.mode);
        const now = Date.now();
        const next = structuredClone(this.state);
        next.groupAttempts = (next.groupAttempts ?? []).filter(a => groupActive(a) || a.expiresAt + GROUP_ADMISSION_RETENTION_MS > now);
        const profiles = await this.profiles([...new Set([...next.entries.map(e => e.userId), ...frozen.members.map(m => m.userId)])], now);
        const actorProfile = profiles.get(actor.id);
        if (!actorProfile?.active) throw new ApiError(403, 'account_disabled');
        if (!actorProfile.hasSession) throw new ApiError(401, 'session_expired');
        this.reconcile(next, profiles, now);
        let attempt = next.groupAttempts.find(a => a.attemptId === frozen.attemptId);
        if (attempt && !sameGroupFreeze(attempt, frozen)) throw new ApiError(409, 'party_attempt_conflict');
        if (action === 'cancel') {
          if (attempt?.phase === 'battle') {
            await this.commit(next, now);
            return { status: 409, body: { attempt: structuredClone(attempt), view: await this.view(actor.id) } };
          }
          if (!attempt) {
            if (next.groupAttempts.length >= GROUP_ADMISSION_CAPACITY) throw new ApiError(503, 'party_attempt_capacity_reached');
            attempt = { ...structuredClone(frozen), phase: frozen.expiresAt <= now ? 'expired' : 'cancelled', matchmakerRevision: 1 };
            next.groupAttempts.push(attempt);
            // Cancellation can beat the reserve RPC. Bind that same exact
            // attempt's tombstone so a later generation cannot take its trial.
            this.bindCapuaTest(next, attempt, now);
          } else if (groupActive(attempt)) this.cancelGroupState(next, attempt, frozen.expiresAt <= now ? 'expired' : 'cancelled');
        } else if (action === 'finish' && attempt?.phase === 'battle') {
          if (!(await this.battleTerminal(attempt.battleId!, attempt.assignmentId!, now, attempt.battleExpiresAt,
            attempt.members.map(member => member.userId)))) throw new ApiError(409, 'party_battle_active');
          attempt.phase = 'completed'; advanceGroup(attempt);
        } else if (action === 'reserve' && !attempt) {
          // Close the old collection before considering this new admission.
          this.pair(next, now);
          if (frozen.phase !== 'pending' || frozen.expiresAt <= now) throw new ApiError(409, 'party_attempt_expired');
          if (next.groupAttempts.length >= GROUP_ADMISSION_CAPACITY) throw new ApiError(503, 'party_attempt_capacity_reached');
          if (next.entries.length + frozen.members.length > CAPACITY) throw new ApiError(503, 'matchmaking_capacity_reached');
          const memberIds = new Set(frozen.members.map(m => m.userId));
          if (next.entries.some(e => memberIds.has(e.userId)) || next.groupAttempts.some(a => groupActive(a) && a.members.some(m => memberIds.has(m.userId)))) {
            throw new ApiError(409, 'party_member_already_admitted');
          }
          const claims = await this.loadClaims(now);
          for (const claim of claims.claims) if (claim.expiresAt > now && claim.participants.some(p => memberIds.has(p.userId)) &&
              !(await this.battleTerminal(claim.battleId, claim.assignmentId, now, claim.expiresAt,
                claim.participants.filter(p => memberIds.has(p.userId)).map(p => p.userId)))) throw new ApiError(409, 'party_member_in_battle');
          for (const member of frozen.members) {
            const profile = profiles.get(member.userId);
            if (!profile?.active || !profile.hasSession) throw new ApiError(409, 'party_member_unavailable');
            if (!profile.loadout || profile.loadoutRevision !== member.loadoutRevision || !sameLoadout(profile.loadout, member.loadout)) {
              throw new ApiError(409, 'party_loadout_changed');
            }
          }
          attempt = { ...structuredClone(frozen), phase: 'queued', matchmakerRevision: 1 };
          next.groupAttempts.push(attempt);
          this.bindCapuaTest(next, attempt, now);
          for (const [position, member] of frozen.members.entries()) next.entries.push({
            ticketId: crypto.randomUUID(), userId: member.userId, displayName: profiles.get(member.userId)!.displayName,
            mode: frozen.mode, ruleset: frozen.ruleset, loadout: structuredClone(member.loadout), enqueuedAt: now,
            expiresAt: now + QUEUE_LIFETIME_MS, assignmentId: null, collectionDeadline: null,
            groupAttemptId: frozen.attemptId, groupPosition: position, loadoutRevision: member.loadoutRevision,
          });
          const poolKey = this.poolKey(next, next.entries.at(-1)!, now);
          const pool = next.entries.filter(e => e.assignmentId === null && this.poolKey(next, e, now) === poolKey);
          const deadline = Math.min(now + COLLECTION_IDLE_MS, ...pool.map(e => e.enqueuedAt + QUEUE_LIFETIME_MS));
          for (const entry of pool) entry.collectionDeadline = deadline;
        }
        this.pair(next, now);
        await this.commit(next, now);
        return { status: action === 'reserve' && attempt?.phase === 'queued' ? 202 : 200,
          body: { attempt: attempt ? structuredClone(attempt) : null, view: await this.view(actor.id) } };
      } catch (error) {
        if (error instanceof ApiError) return { status: error.status, body: { error: error.code } };
        throw error;
      }
    });
  }

  private async battleTerminal(battleId: string, assignmentId: string, now: number, claimExpiry?: number, userIds?: string[]): Promise<boolean> {
    const row = await this.env.DB.prepare('SELECT assignment_id, status, created_at, expires_at FROM battles WHERE id = ?')
      .bind(battleId).first<{ assignment_id: string | null; status: string; created_at: number; expires_at: number }>();
    // The claim fixes the battle ID and its two-hour expiry before D1 writes.
    // If D1 creation failed, retire the unstarted relay after its join window;
    // that durable fence rejects a delayed manifest for the same battle ID.
    if (!row) {
      if (!Number.isSafeInteger(claimExpiry)) return false;
      if (claimExpiry! <= now) return true;
      const claimedAt = claimExpiry! - CLAIM_LIFETIME_MS;
      return claimedAt >= 0 && claimedAt <= now &&
        this.relayReleased(battleId, Math.floor(claimedAt / 1000), userIds);
    }
    if (row.assignment_id !== assignmentId) return false;
    if (row.status === 'settled' || row.expires_at <= Math.floor(now / 1000)) return true;
    if (row.status === 'disputed') return false;
    return this.relayReleased(battleId, row.created_at, userIds);
  }

  private async relayReleased(battleId: string, createdAt: number, userIds?: string[]): Promise<boolean> {
    const key = `${battleId}:${createdAt}`;
    const retryAt = this.relayFailureRetryAt.get(key);
    if (retryAt !== undefined && Date.now() < retryAt) return false;
    this.relayFailureRetryAt.delete(key);
    const observation = await observeBattleAdmission(this.env, battleId, createdAt, userIds);
    // A healthy nonterminal response is rechecked immediately so a later
    // /end or abandoned-seat transition is visible on the next own poll.
    if (!observation.failed) return observation.released;
    this.relayFailureRetryAt.set(key, Date.now() + RELAY_FAILURE_RETRY_MS);
    if (this.relayFailureRetryAt.size > CLAIM_CAPACITY) {
      const oldest = this.relayFailureRetryAt.keys().next().value;
      if (oldest !== undefined) this.relayFailureRetryAt.delete(oldest);
    }
    return false;
  }

  private cancelGroupState(state: State, attempt: GroupAdmissionAttempt, phase: 'cancelled' | 'expired'): void {
    if (attempt.phase === 'battle' || !groupActive(attempt)) return;
    for (const entry of state.entries.filter(e => e.groupAttemptId === attempt.attemptId)) this.unassign(state, entry.assignmentId);
    state.entries = state.entries.filter(e => e.groupAttemptId !== attempt.attemptId);
    attempt.phase = phase; delete attempt.assignmentId; delete attempt.battleId; advanceGroup(attempt);
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const next = structuredClone(this.state);
      this.reconcile(next, await this.profiles(next.entries.map(e => e.userId), now), now);
      this.pair(next, now);
      await this.commit(next, now);
    });
  }

  /** Convert a confirmed assignment into a single frozen battle manifest.
   * The first caller consumes the assignment and fixes `battleId`; every later
   * caller (including the other participant and any retry) receives the same
   * snapshot, so two clients can never open two battles for one match.
   */
  async claim(userId: string, assignmentId: string, candidateBattleId: string,
    maxRosterPolicyVersion: 2 | 3 | 4 | 5 = 2): Promise<ClaimResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (typeof userId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(userId)) return { status: 403, error: 'account_disabled' };
      if (typeof assignmentId !== 'string' || !UUID.test(assignmentId)) return { status: 404, error: 'assignment_not_found' };
      if (typeof candidateBattleId !== 'string' || !UUID.test(candidateBattleId)) return { status: 400, error: 'invalid_battle_id' };
      if (maxRosterPolicyVersion !== 2 && maxRosterPolicyVersion !== 3 && maxRosterPolicyVersion !== 4 && maxRosterPolicyVersion !== 5) return { status: 400, error: 'invalid_roster_capability' };
      const now = Date.now();
      const stored = await this.loadClaims(now);
      const claims = stored.claims.filter(claim => claim.expiresAt > now);
      const existing = claims.find(claim => claim.assignmentId === assignmentId);
      if (existing) {
        if (!existing.participants.some(participant => participant.userId === userId)) {
          return { status: 404, error: 'assignment_not_found' };
        }
        if ((existing.rosterPolicy?.version ?? 1) > maxRosterPolicyVersion) {
          return { status: 426, error: 'launcher_update_required' };
        }
        if (claims.length !== stored.claims.length) {
          await this.commit(structuredClone(this.state), now,
            { version: CLAIMS_VERSION, claims } satisfies ClaimsState);
        }
        return { status: 200, claim: structuredClone(existing) };
      }
      const next = structuredClone(this.state);
      const profiles = await this.profiles(next.entries.map(entry => entry.userId), now);
      this.reconcile(next, profiles, now);
      const assignment = next.assignments.find(candidate => candidate.id === assignmentId);
      const members = assignment?.userIds.map(id => next.entries.find(entry => entry.userId === id)!) ?? [];
      if (!assignment || assignment.expiresAt <= now || members.some(member => !member) ||
          !assignment.userIds.includes(userId)) {
        // Persist any expiry/ban cleanup discovered above before failing.
        this.pair(next, now);
        await this.commit(next, now);
        return { status: 404, error: 'assignment_not_found' };
      }
      if ((assignment.rosterPolicy?.version ?? 1) > maxRosterPolicyVersion) {
        return { status: 426, error: 'launcher_update_required' };
      }
      // An already claimed legacy battle may be retried above; an unclaimed
      // PvE assignment cannot mint a new battle after public retirement.
      if (retiredPublicPve(this.env, assignment.mode)) {
        return { status: 409, error: 'battle_mode_removed' };
      }
      const claim: AssignmentClaim = {
        assignmentId, battleId: candidateBattleId, mode: assignment.mode, ruleset: assignment.ruleset,
        mapKey: assignment.mapKey, rewardPolicy: assignment.rewardPolicy, claimedAt: now,
        expiresAt: now + CLAIM_LIFETIME_MS,
        participants: members.map((member, index) => ({
          userId: member.userId, displayName: member.displayName,
          team: assignmentTeam(assignment, index),
          playerId: index + 1, seat: index, loadout: member.loadout,
        })),
        ...(assignment.rosterPolicy ? { rosterPolicy: assignment.rosterPolicy } : {}),
        partyGroups: [...new Set(members.flatMap(member => member.groupAttemptId ? [member.groupAttemptId] : []))]
          .map(id => members.filter(member => member.groupAttemptId === id).map(member => member.userId).sort())
          .filter(group => group.length > 1),
      };
      // The seats are now committed to a battle: release the queue tickets so a
      // participant cannot be paired into a second match while playing this one.
      for (const attempt of next.groupAttempts ?? []) {
        if (attempt.phase === 'assigned' && attempt.assignmentId === assignment.id) {
          attempt.phase = 'battle'; attempt.battleId = candidateBattleId; attempt.battleExpiresAt = claim.expiresAt; advanceGroup(attempt);
        }
      }
      next.entries = next.entries.filter(e => !assignment.userIds.includes(e.userId));
      next.assignments = next.assignments.filter(a => a.id !== assignment.id);
      this.pair(next, now);
      claims.push(claim);
      await this.commit(next, now, {
        version: CLAIMS_VERSION,
        claims: claims.slice(-CLAIM_CAPACITY),
      } satisfies ClaimsState);
      return { status: 201, claim: structuredClone(claim) };
    });
  }

  async battlePartyGroups(userId: string, battleId: string): Promise<{participants: string[]; groups: string[][]} | null> {
    // Read only the immutable claim. Current Social membership can change after
    // a match and must never rewrite the party badges of an existing battle.
    const stored = await this.ctx.storage.get<ClaimsState>(CLAIMS_KEY);
    const claim = stored?.version === CLAIMS_VERSION && stored.claims.find(row =>
      row.battleId === battleId && row.expiresAt > Date.now() &&
      row.participants.some(seat => seat.userId === userId));
    if (!claim) return null;
    return structuredClone({participants: claim.participants.map(seat => seat.userId), groups: claim.partyGroups ?? []});
  }

  private async profiles(ids: string[], now: number): Promise<Map<string, Profile>> {
    if (!ids.length) return new Map();
    // At most 65 IDs + one timestamp, below D1's statement parameter limit.
    const rows = await this.env.DB.prepare(`SELECT u.id, u.display_name, u.commander_id, u.status,
      ul.commander_id AS loadout_commander_id, ul.item_ids AS loadout_item_ids, ul.revision AS loadout_revision,
      EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS has_session
      FROM users u LEFT JOIN user_loadouts ul ON ul.user_id = u.id
      WHERE u.id IN (${ids.map(() => '?').join(',')})`)
      .bind(Math.floor(now / 1000), ...ids)
      .all<{ id: string; display_name: string; commander_id: string | null; status: string; has_session: number;
        loadout_commander_id: string | null; loadout_item_ids: string | null; loadout_revision: number | null }>();
    return new Map(rows.results.map(row => {
      let loadout: VerifiedLoadout | null = null;
      let loadoutRevision: number | null = null;
      if (row.status === 'active' && row.commander_id) {
        try {
          const selected = resolveSelectionRow(row.id, row.commander_id, row.loadout_revision === null ? null : {
            commander_id: row.loadout_commander_id!, item_ids: row.loadout_item_ids!, revision: row.loadout_revision,
          });
          loadout = selected.loadout;
          loadoutRevision = selected.revision;
        }
        catch (error) { if (!(error instanceof ApiError)) throw error; }
      }
      return [row.id, { id: row.id, displayName: row.display_name, active: row.status === 'active',
        hasSession: row.has_session === 1, loadout, loadoutRevision }];
    }));
  }

  private reconcile(state: State, profiles: Map<string, Profile>, now: number): void {
    for (const attempt of state.groupAttempts ?? []) {
      if (['queued', 'assigned'].includes(attempt.phase) && attempt.expiresAt <= now) this.cancelGroupState(state, attempt, 'expired');
    }
    // An assignment expiry ends its participants' tickets; a subsequent join is
    // a new explicit attempt. Polls cannot keep reservations alive indefinitely.
    for (const assignment of [...state.assignments]) {
      if (assignment.expiresAt <= now) {
        for (const userId of assignment.userIds) this.remove(state, userId, 'expired');
      }
    }
    for (const entry of [...state.entries]) {
      if (!state.entries.includes(entry)) continue;
      const profile = profiles.get(entry.userId);
      if ((entry.assignmentId !== null && entry.expiresAt <= now) || !profile?.active || !profile.hasSession || !profile.loadout) {
        this.remove(state, entry.userId);
        continue;
      }
      if (entry.groupAttemptId && (entry.loadoutRevision !== profile.loadoutRevision || !sameLoadout(entry.loadout, profile.loadout))) {
        this.remove(state, entry.userId);
        continue;
      }
      if (!sameLoadout(entry.loadout, profile.loadout)) {
        // Prepared assignments are immutable: revoke the old ID before using a
        // changed roster. No native admission credential exists at this stage.
        this.unassign(state, entry.assignmentId);
        entry.loadout = profile.loadout;
      }
      entry.displayName = profile.displayName;
    }
  }

  private unassign(state: State, assignmentId: string | null): void {
    if (!assignmentId) return;
    state.assignments = state.assignments.filter(a => a.id !== assignmentId);
    for (const entry of state.entries) if (entry.assignmentId === assignmentId) {
      entry.assignmentId = null;
      // Requeue partners without extending their original five-minute window.
      if (entry.groupAttemptId) entry.expiresAt = entry.enqueuedAt + QUEUE_LIFETIME_MS;
    }
    for (const attempt of state.groupAttempts ?? []) if (attempt.assignmentId === assignmentId && attempt.phase === 'assigned') {
      attempt.phase = 'queued'; delete attempt.assignmentId; advanceGroup(attempt);
    }
  }

  private remove(state: State, userId: string, reason: 'cancelled' | 'expired' = 'cancelled'): void {
    const entry = state.entries.find(e => e.userId === userId);
    if (entry?.groupAttemptId) {
      const attempt = state.groupAttempts?.find(a => a.attemptId === entry.groupAttemptId);
      if (attempt) { this.cancelGroupState(state, attempt, reason); return; }
    }
    this.unassign(state, entry?.assignmentId ?? null);
    state.entries = state.entries.filter(e => e.userId !== userId);
    // Any eligible opponent keeps their original ticket/deadline and queues
    // again; cancellation never silently joins the departing account anew.
  }

  private bindCapuaTest(state: State, attempt: GroupAdmissionAttempt, now: number): void {
    const config = configuredCapuaReservation(this.env, now);
    if (!config) return;
    const history = state.capuaTestReservations ?? [];
    if (bindCapuaReservation(history, config, attempt, now)) state.capuaTestReservations = history;
  }

  private capuaReservation(state: State, entry: Entry, now: number): BoundCapuaReservation | null {
    if (!entry.groupAttemptId || !state.capuaTestReservations?.length) return null;
    const attempt = state.groupAttempts?.find(a => a.attemptId === entry.groupAttemptId);
    return attempt ? activeCapuaReservation(state.capuaTestReservations,
      configuredCapuaReservation(this.env, now), attempt) : null;
  }

  private poolKey(state: State, entry: Entry, now: number): string {
    const reservation = this.capuaReservation(state, entry, now);
    return `${entry.mode}:${entry.ruleset}` + (reservation ? `:capua-test:${reservation.reservationId}` : '');
  }

  private pair(state: State, now: number): void {
    const pending = state.entries.filter(e => !e.assignmentId)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt || a.ticketId.localeCompare(b.ticketId));
    const pools = new Map<string, Entry[]>();
    for (const entry of pending) {
      const key = this.poolKey(state, entry, now);
      const pool = pools.get(key) ?? [];
      pool.push(entry);
      pools.set(key, pool);
    }
    for (const pool of pools.values()) {
      const capacity = pool[0].mode === 'pve' ? PVE_MAX_HUMANS : PVP_MAX_HUMANS;
      while (pool.length) {
        const units: Entry[][] = [];
        const seen = new Set<string>();
        for (const entry of pool) {
          const key = entry.groupAttemptId ?? entry.ticketId;
          if (seen.has(key)) continue;
          seen.add(key);
          units.push(entry.groupAttemptId ? pool.filter(e => e.groupAttemptId === key)
            .sort((a, b) => a.groupPosition! - b.groupPosition!) : [entry]);
        }
        const grouped = pool.some(e => e.groupAttemptId);
        const publicPvp = pool[0].mode === 'pvp' && this.env.NATIVE_PUBLIC_PROTOCOL === 'twa-relay-v1';
        // Give a solo or one whole party the full five-minute window to find
        // human opponents, then let the normal roster fill empty seats with CPUs.
        if (publicPvp && units.length < 2) {
          const deadline = Math.min(...pool.map(entry => entry.enqueuedAt + QUEUE_LIFETIME_MS));
          for (const entry of pool) {
            entry.collectionDeadline = deadline;
            // A revoked assignment may have left a shorter preparation lease.
            entry.expiresAt = entry.enqueuedAt + QUEUE_LIFETIME_MS;
          }
          if (now < deadline) break;
        }
        const packed = grouped ? packAdmissions(units, pool[0].mode, publicPvp && units.length > 1 && pool.length <= capacity)
          : {entries: pool.slice(0, capacity), teams: []};
        const group = packed.entries, teams = packed.teams;
        if (!group.length) throw new Error('invalid_group_capacity');
        const deadline = Math.min(...group.map(e => Math.min(
          e.enqueuedAt + QUEUE_LIFETIME_MS,
          e.collectionDeadline ?? e.enqueuedAt + COLLECTION_IDLE_MS)));
        for (const entry of group) entry.collectionDeadline = deadline;
        if (group.length < capacity && now < deadline) break;
        this.assign(state, group, now, group.some(e => e.groupAttemptId) ? teams : undefined);
        const selected = new Set(group.map(e => e.ticketId));
        for (let i = pool.length - 1; i >= 0; i--) if (selected.has(pool[i].ticketId)) pool.splice(i, 1);
      }
    }
  }

  private assign(state: State, entries: Entry[], now: number, teams?: Array<0 | 1>): void {
    const mode = entries[0].mode;
    if (entries.length < 1 || entries.length > (mode === 'pve' ? PVE_MAX_HUMANS : PVP_MAX_HUMANS) ||
      new Set(entries.map(entry => entry.userId)).size !== entries.length ||
      entries.some(entry => entry.ruleset !== entries[0].ruleset)) throw new Error('invalid_matchmaking_group');
    if (entries.some(entry => entry.mode !== mode || entry.ruleset !== entries[0].ruleset)) {
      throw new Error('invalid_assignment_pool');
    }
    const ruleset = entries[0].ruleset;
    const id = crypto.randomUUID();
    const policyVersion = this.env.NATIVE_PUBLIC_PROTOCOL === 'twa-relay-v1' ? 5 : teams ? 2 : 1;
    const frozenTeams = policyVersion === 5 ? teams ?? entries.map((_entry, index) => mode === 'pve' ? 0 as const : index % 2 as 0 | 1) : teams;
    const reservation = this.capuaReservation(state, entries[0], now);
    if (reservation && (entries.length !== 2 || entries.some(entry =>
        entry.groupAttemptId !== reservation.attemptId || !reservation.memberIds.includes(entry.userId)))) {
      throw new Error('invalid_capua_test_assignment');
    }
    const assignment: Assignment = { id, mode, ruleset,
      mapKey: reservation ? CAPUA_TEST_MAP : chooseMapKeyForRuleset(ruleset), preparedAt: now,
      expiresAt: now + ASSIGNMENT_LIFETIME_MS,
      userIds: entries.map(e => e.userId), rewardPolicy: rewardPolicy(mode),
      rosterPolicy: {
        version: policyVersion, totalSeats: 20, seatsPerTeam: 10, unitsPerSeat: 3,
        humanParticipantsOnly: true, cpuFill: true, seed: `${mode}-roster-v${policyVersion}:${id}`,
      }, ...(frozenTeams ? { teams: frozenTeams } : {}) };
    for (const attempt of state.groupAttempts ?? []) if (entries.some(e => e.groupAttemptId === attempt.attemptId)) {
      attempt.phase = 'assigned'; attempt.assignmentId = id; advanceGroup(attempt);
    }
    state.assignments.push(assignment);
    if (reservation) reservation.assignmentId = id;
    for (const entry of entries) {
      entry.assignmentId = assignment.id;
      entry.expiresAt = assignment.expiresAt;
      entry.collectionDeadline = null;
    }
  }

  private async commit(next: State, now: number, claims?: ClaimsState): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put(STORAGE_KEY, next);
      if (claims) await transaction.put(CLAIMS_KEY, claims);
      if (next.entries.length) {
        await transaction.setAlarm(Math.min(now + REVALIDATE_MS,
          ...next.entries.map(e => e.expiresAt),
          ...next.entries.flatMap(e => e.assignmentId !== null || e.collectionDeadline === null ||
            e.collectionDeadline <= now ? [] : [e.collectionDeadline]),
          ...next.assignments.map(a => a.expiresAt)));
      } else await transaction.deleteAlarm();
    });
    // A failed persistence operation must not leave a mutated in-memory roster.
    this.state = next;
  }

  private revokeAssignments(state: State, assignmentIds: string[]): void {
    const revoked = new Set(assignmentIds);
    if (!revoked.size) return;
    const users = state.entries
      .filter(entry => entry.assignmentId !== null && revoked.has(entry.assignmentId))
      .map(entry => entry.userId);
    for (const userId of users) this.remove(state, userId);
    // Also cover an inconsistent crash snapshot whose assignment survived but
    // whose entries did not. This operation is idempotent.
    state.assignments = state.assignments.filter(assignment => !revoked.has(assignment.id));
  }

  private async loadClaims(now: number): Promise<ClaimsState> {
    const normalized = claimsState(await this.ctx.storage.get<
      ClaimsState | LegacyVersionedClaimsState | LegacyClaimsState
    >(CLAIMS_KEY));
    if (!normalized.migrated) return normalized.state;
    const next = structuredClone(this.state);
    this.revokeAssignments(next, normalized.invalidatedAssignmentIds);
    await this.commit(next, now, normalized.state);
    return normalized.state;
  }

  /** The claim that still concerns a seat which no longer holds a queue ticket.
   * `claim()` releases both tickets, so without this the partner's view would
   * drop to `idle` before it ever learned the assignment id. Visibility is
   * bounded well below the claim lifetime so a finished battle never looks
   * like a new assignment to a companion that starts polling later.
   */
  private async claimFor(userId: string, now: number): Promise<AssignmentClaim | null> {
    const stored = await this.loadClaims(now);
    const groupBattle = this.state.groupAttempts?.find(a => a.phase === 'battle' && a.members.some(m => m.userId === userId));
    const live = stored.claims
      .filter(claim => claim.expiresAt > now && (claim.claimedAt + CLAIM_VISIBILITY_MS > now || claim.battleId === groupBattle?.battleId)
        && claim.participants.some(participant => participant.userId === userId) &&
        !(this.state.groupAttempts ?? []).some(a => a.phase === 'completed' && a.battleId === claim.battleId &&
          a.members.some(m => m.userId === userId)));
    for (const claim of live.reverse()) {
      if (!(await this.battleTerminal(claim.battleId, claim.assignmentId, now, claim.expiresAt, [userId]))) return claim;
    }
    return null;
  }

  private async view(userId: string): Promise<MatchmakingView> {
    const entry = this.state.entries.find(e => e.userId === userId);
    if (!entry) {
      const claim = await this.claimFor(userId, Date.now());
      if (!claim) return { status: 'idle', nativeBattles: false, pollAfterMs: null, ticket: null, assignment: null };
      return structuredClone({
        status: 'awaiting_gameplay_adapter', nativeBattles: false, pollAfterMs: 2000, ticket: null,
        assignment: {
          id: claim.assignmentId, battleId: claim.battleId, claimed: true, mode: claim.mode, ruleset: claim.ruleset,
          preparedAt: claim.claimedAt, expiresAt: claim.expiresAt, mapKey: claim.mapKey,
          humanPlayers: claim.participants.length, aiOpponents: claim.mode === 'pve' ? (claim.rosterPolicy ? 10 : 1) : 0,
          cpuSeatsByTeam: claim.rosterPolicy ?
            cpuSeatsByTeam(claim.participants.map(p => p.team)) : [0, 0],
          enemyTier: opponentTier(claim.mode, claim.participants.map(participant => participant.loadout)),
          battleTier: SANDBOX_EFFECTIVE_UNIT_TIER,
          tierPolicy: 'highest_deployed_unit', rewardPolicy: claim.rewardPolicy,
          participants: claim.participants.map(participant => ({ userId: participant.userId,
            displayName: participant.displayName, team: participant.team, loadout: participant.loadout })),
          rosterPolicy: claim.rosterPolicy ?? null,
          unavailableReason: 'native_adapter_unavailable',
        },
      });
    }
    const assignment = this.state.assignments.find(a => a.id === entry.assignmentId);
    const members = assignment?.userIds.map(id => this.state.entries.find(e => e.userId === id)!) ?? [];
    // No global queue/roster enumeration. Only assigned participants are visible.
    return structuredClone({
      status: assignment ? 'awaiting_gameplay_adapter' : 'queued', nativeBattles: false, pollAfterMs: 2000,
      ticket: { id: entry.ticketId, mode: entry.mode, ruleset: entry.ruleset, enqueuedAt: entry.enqueuedAt,
        expiresAt: entry.expiresAt, loadout: entry.loadout },
      assignment: assignment ? {
        id: assignment.id, mode: assignment.mode, ruleset: assignment.ruleset, preparedAt: assignment.preparedAt,
        expiresAt: assignment.expiresAt, mapKey: assignment.mapKey, humanPlayers: members.length,
        aiOpponents: assignment.mode === 'pve' ? (assignment.rosterPolicy ? 10 : 1) : 0,
        cpuSeatsByTeam: assignment.rosterPolicy ?
          cpuSeatsByTeam(members.map((_entry, index) => assignmentTeam(assignment, index))) : [0, 0],
        enemyTier: opponentTier(assignment.mode, members.map(e => e.loadout)),
        battleTier: SANDBOX_EFFECTIVE_UNIT_TIER, tierPolicy: 'highest_deployed_unit',
        rewardPolicy: assignment.rewardPolicy,
        participants: members.map((e, i) => ({ userId: e.userId, displayName: e.displayName,
          team: assignmentTeam(assignment, i), loadout: e.loadout })),
        rosterPolicy: assignment.rosterPolicy,
        unavailableReason: 'native_adapter_unavailable',
      } : null,
    });
  }
}

function cpuSeatsByTeam(teams: Array<0 | 1>): [number, number] {
  const humans: [number, number] = [0, 0];
  for (const team of teams) humans[team]++;
  return [PVP_SEATS_PER_TEAM - humans[0], PVP_SEATS_PER_TEAM - humans[1]];
}

function assignmentTeam(assignment: Assignment, index: number): 0 | 1 {
  return assignment.rosterPolicy?.version === 2 || assignment.rosterPolicy?.version === 3 || assignment.rosterPolicy?.version === 4 || assignment.rosterPolicy?.version === 5
    ? assignment.teams![index] : (assignment.mode === 'pve' ? 0 : index % 2) as 0 | 1;
}

function validGroupAttempt(a: GroupAdmissionAttempt): boolean {
  return !!a && UUID.test(a.attemptId) && UUID.test(a.requestId) && groupIdentifier(a.partyId) &&
    groupIdentifier(a.ownerId) && isMode(a.mode) && isBattleRuleset(a.ruleset) &&
    Number.isSafeInteger(a.createdAt) && Number.isSafeInteger(a.expiresAt) && a.expiresAt > a.createdAt &&
    a.expiresAt <= a.createdAt + 8 * 60_000 && Number.isSafeInteger(a.partyRevision) && a.partyRevision >= 0 &&
    Number.isSafeInteger(a.leaderLoadoutRevision) && a.leaderLoadoutRevision >= 0 &&
    ['pending', 'queued', 'assigned', 'battle', 'cancelling', 'cancelled', 'expired', 'completed', 'failed'].includes(a.phase) &&
    (a.assignmentId === undefined || UUID.test(a.assignmentId)) && (a.battleId === undefined || UUID.test(a.battleId)) &&
    (a.matchmakerRevision === undefined || (Number.isSafeInteger(a.matchmakerRevision) && a.matchmakerRevision > 0)) &&
    (a.battleExpiresAt === undefined || (Number.isSafeInteger(a.battleExpiresAt) && a.battleExpiresAt > a.createdAt)) &&
    Array.isArray(a.members) && a.members.length >= 1 && a.members.length <= 4 &&
    new Set(a.members.map(m => m.userId)).size === a.members.length && a.members.some(m => m.userId === a.ownerId && m.loadoutRevision === a.leaderLoadoutRevision) &&
    a.members.every(m => groupIdentifier(m.userId) && typeof m.displayName === 'string' &&
      Number.isSafeInteger(m.loadoutRevision) && m.loadoutRevision >= 0 && !!m.loadout &&
      Array.isArray(m.loadout.units) && m.loadout.units.length === 3);
}

function sameGroupFreeze(a: GroupAdmissionAttempt, b: GroupAdmissionAttempt): boolean {
  return a.attemptId === b.attemptId && a.requestId === b.requestId && a.partyId === b.partyId &&
    a.partyRevision === b.partyRevision && a.ownerId === b.ownerId && a.mode === b.mode && a.ruleset === b.ruleset &&
    a.createdAt === b.createdAt && a.expiresAt === b.expiresAt && a.leaderLoadoutRevision === b.leaderLoadoutRevision &&
    a.members.length === b.members.length && a.members.every((m, i) => m.userId === b.members[i].userId &&
      m.loadoutRevision === b.members[i].loadoutRevision && sameLoadout(m.loadout, b.members[i].loadout));
}

function advanceGroup(attempt: GroupAdmissionAttempt): void {
  attempt.matchmakerRevision = (attempt.matchmakerRevision ?? 0) + 1;
}

/** 11x11 bounded packing. The oldest admission is mandatory; later whole
 * parties/solos fill the remaining capacity without splitting. Equal fills
 * prefer earlier admissions, and team zero breaks symmetric ties. */
function packAdmissions(units: Entry[][], mode: Mode, preserveOpponents = false): {entries: Entry[]; teams: Array<0 | 1>} {
  type Choice = {indices: number[]; teams: Array<0 | 1>};
  const isParty = (index: number) => Boolean(units[index][0].groupAttemptId) && units[index].length > 1;
  // Retain party presence separately from seat counts: equally full layouts
  // can have both parties on one side or put them against each other.
  let states = new Map<string, Choice>([[`${units[0].length}:0:${isParty(0) ? 1 : 0}:1`, {indices: [0], teams: [0]}]]);
  const earlier = (a: Choice, b: Choice) => {
    for (let i = 0; i < Math.min(a.indices.length, b.indices.length); i++) {
      if (a.indices[i] !== b.indices[i]) return a.indices[i] < b.indices[i];
    }
    return a.indices.length > b.indices.length;
  };
  for (let i = 1; i < units.length; i++) {
    const next = new Map(states);
    for (const [key, choice] of states) {
      const counts = key.split(':').map(Number);
      for (const team of (mode === 'pve' ? [0] : [0, 1]) as Array<0 | 1>) {
        if (counts[team] + units[i].length > 10) continue;
        const updated = [...counts]; updated[team] += units[i].length;
        updated[3]++;
        if (isParty(i)) updated[2] |= 1 << team;
        const target = updated.join(':'), candidate = {indices: [...choice.indices, i], teams: [...choice.teams, team]};
        if (!next.has(target) || earlier(candidate, next.get(target)!)) next.set(target, candidate);
      }
    }
    states = next;
  }
  let best: Choice | null = null, size = -1, imbalance = Infinity, opposingParties = false;
  for (const [key, choice] of states) {
    const counts = key.split(':').map(Number);
    if (preserveOpponents && (counts[1] === 0 || units.length - choice.indices.length === 1)) continue;
    const total = counts[0] + counts[1], difference = Math.abs(counts[0] - counts[1]);
    const partiesFaceEachOther = counts[2] === 3;
    const sameAdmissions = best && choice.indices.length === best.indices.length &&
      choice.indices.every((index, position) => index === best!.indices[position]);
    // Keep whole parties and admission order, prefer party-versus-party,
    // then balance humans. Solo rivals still oppose a lone party.
    if (total > size || (total === size && best &&
        (earlier(choice, best) || (sameAdmissions &&
          ((partiesFaceEachOther && !opposingParties) ||
           (partiesFaceEachOther === opposingParties && difference < imbalance)))))) {
      best = choice; size = total; imbalance = difference; opposingParties = partiesFaceEachOther;
    }
  }
  return {entries: best!.indices.flatMap(i => units[i]), teams: best!.indices.flatMap((i, n) => units[i].map(() => best!.teams[n]))};
}
