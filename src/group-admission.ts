import type {BattleMode, BattleRuleset} from './battle-rules';
import {ApiError} from './http';
import {resolveSelectionRow} from './loadout-selection';
import type {VerifiedLoadout} from './loadouts';
import type {Env} from './types';

/** Internal Social -> Matchmaker contract. No HTTP endpoint accepts this DTO.
 * Social supplies identities and D1 supplies the current catalog selection. */
export interface GroupAdmissionMember {
  userId: string;
  displayName: string;
  loadoutRevision: number;
  loadout: VerifiedLoadout;
}

export type GroupAdmissionPhase = 'pending' | 'queued' | 'assigned' | 'battle' | 'cancelling' |
  'cancelled' | 'expired' | 'completed' | 'failed';
export type GroupAdmissionTerminalPhase = 'cancelled' | 'expired' | 'completed' | 'failed';
export interface GroupAdmissionAttempt {
  attemptId: string;
  requestId: string;
  partyId: string;
  partyRevision: number;
  leaderLoadoutRevision: number;
  ownerId: string;
  mode: BattleMode;
  ruleset: BattleRuleset;
  members: GroupAdmissionMember[];
  phase: GroupAdmissionPhase;
  createdAt: number;
  expiresAt: number;
  assignmentId?: string;
  battleId?: string;
  /** Matchmaker-owned claim expiry; not a caller hint or public summary. */
  battleExpiresAt?: number;
  /** Monotonic durable Matchmaker observation; Social never accepts an older
   * queued/assignment response over a newer one. */
  matchmakerRevision?: number;
}

export interface GroupAdmissionRequest {
  partyId: string;
  partyRevision: number;
  leaderLoadoutRevision: number;
  requestId: string;
  mode: BattleMode;
  ruleset: BattleRuleset;
}

export const GROUP_ADMISSION_LIFETIME_MS = 8 * 60_000;
export const GROUP_ADMISSION_RETENTION_MS = 24 * 60 * 60_000;
export const GROUP_ADMISSION_CAPACITY = 256;
export const groupIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
export const groupRequestIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const groupActive = (attempt: GroupAdmissionAttempt): boolean =>
  ['pending', 'queued', 'assigned', 'battle', 'cancelling'].includes(attempt.phase);

/** A single SELECT observes active account, live session and ordered selection
 * together. IDs must come from the serialized Social membership snapshot. */
export async function readGroupAdmissionMembers(ids: readonly string[], env: Env, now: number): Promise<GroupAdmissionMember[]> {
  if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => !groupIdentifier(id))) {
    throw new ApiError(503, 'invalid_party_members');
  }
  const rows = await env.DB.prepare(`SELECT u.id, u.display_name, u.commander_id, u.status,
    ul.commander_id AS loadout_commander_id, ul.item_ids, ul.revision,
    EXISTS(SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS has_session
    FROM users u LEFT JOIN user_loadouts ul ON ul.user_id = u.id
    WHERE u.id IN (${ids.map(() => '?').join(',')})`)
    .bind(Math.floor(now / 1000), ...ids)
    .all<{id: string; display_name: string; commander_id: string | null; status: string;
      loadout_commander_id: string | null; item_ids: string | null; revision: number | null; has_session: number}>();
  const byId = new Map(rows.results.map(row => [row.id, row]));
  if (rows.results.length !== ids.length || byId.size !== ids.length || rows.results.some(row => !ids.includes(row.id))) {
    throw new ApiError(409, 'party_member_unavailable');
  }
  return ids.map(id => {
    const row = byId.get(id)!;
    if (row.status !== 'active' || row.has_session !== 1) throw new ApiError(409, 'party_member_unavailable');
    if (!row.commander_id) throw new ApiError(409, 'commander_selection_required');
    // A partially present/corrupt row must not fall back to starter units.
    const selected = resolveSelectionRow(id, row.commander_id, row.revision === null ? null : {
      commander_id: row.loadout_commander_id!, item_ids: row.item_ids!, revision: row.revision,
    });
    if (!Number.isSafeInteger(selected.revision) || selected.revision < 0) throw new ApiError(503, 'invalid_party_selection');
    return {userId: id, displayName: row.display_name, loadoutRevision: selected.revision, loadout: selected.loadout};
  });
}
