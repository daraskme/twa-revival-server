import {groupIdentifier, groupRequestIdentifier, type GroupAdmissionAttempt} from './group-admission';
import {nativePvpTestGate, type NativePvpTestEnv} from './native-pvp-test';

/** Operator-only JSON binding; never accepted from an HTTP request. Example:
 * {"version":1,"reservationId":"<new UUID>","partyId":"<own party>",
 *  "memberIds":["<WIN>","<sub>"],"expiresAt":<Unix milliseconds>}
 * The next matching authenticated party attempt consumes this reservation ID,
 * including when that attempt is cancelled before assignment. Remove the
 * binding after the trial. Never put account IDs in a checked-in config.
 */
export interface CapuaReservationEnv extends NativePvpTestEnv {
  NATIVE_PVP_TEST_CAPUA_RESERVATION?: string;
}
export interface CapuaReservation {
  version: 1;
  reservationId: string;
  partyId: string;
  memberIds: [string, string];
  expiresAt: number;
}
export interface BoundCapuaReservation extends CapuaReservation {
  attemptId: string;
  boundAt: number;
  assignmentId: string | null;
}
export const CAPUA_TEST_MAP = 'capua_territory';
export const CAPUA_RESERVATION_LIMIT = 64;
const MAX_LIFETIME_MS = 60 * 60_000;

function validReservation(value: unknown): value is CapuaReservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as CapuaReservation;
  return row.version === 1 && groupRequestIdentifier(row.reservationId) && groupIdentifier(row.partyId) &&
    Array.isArray(row.memberIds) && row.memberIds.length === 2 && row.memberIds.every(groupIdentifier) &&
    row.memberIds[0] !== row.memberIds[1] && Number.isSafeInteger(row.expiresAt) && row.expiresAt > 0;
}

export function configuredCapuaReservation(env: CapuaReservationEnv, now: number): CapuaReservation | null {
  // Unlike the existing candidate advertisement, this trial is staging only.
  if (env.DEPLOYMENT_ENVIRONMENT !== 'staging' || !nativePvpTestGate(env).enabled ||
      typeof env.NATIVE_PVP_TEST_CAPUA_RESERVATION !== 'string') return null;
  try {
    const value: unknown = JSON.parse(env.NATIVE_PVP_TEST_CAPUA_RESERVATION);
    if (!validReservation(value) || Object.keys(value).length !== 5 || value.expiresAt <= now ||
        value.expiresAt - now > MAX_LIFETIME_MS) return null;
    return {...value, memberIds: [...value.memberIds].sort() as [string, string]};
  } catch { return null; }
}

export function validCapuaReservationHistory(value: unknown): value is BoundCapuaReservation[] {
  return Array.isArray(value) && value.length <= CAPUA_RESERVATION_LIMIT &&
    new Set(value.map(row => row?.reservationId)).size === value.length && value.every(value => {
      if (!validReservation(value) || Object.keys(value).length !== 8) return false;
      const row = value as BoundCapuaReservation;
      return groupRequestIdentifier(row.attemptId) && Number.isSafeInteger(row.boundAt) && row.boundAt > 0 &&
        row.expiresAt > row.boundAt && row.expiresAt - row.boundAt <= MAX_LIFETIME_MS &&
        (row.assignmentId === null || groupRequestIdentifier(row.assignmentId));
    });
}

export function matchesCapuaParty(reservation: CapuaReservation, attempt: GroupAdmissionAttempt): boolean {
  return attempt.mode === 'pvp' && attempt.ruleset === 'territory' && attempt.partyId === reservation.partyId &&
    attempt.members.length === 2 && attempt.members.every(member => reservation.memberIds.includes(member.userId)) &&
    new Set(attempt.members.map(member => member.userId)).size === 2;
}

export function bindCapuaReservation(history: BoundCapuaReservation[], config: CapuaReservation | null,
                                     attempt: GroupAdmissionAttempt, now: number): BoundCapuaReservation | null {
  // History is deliberately never pruned: deleting an old tombstone would let
  // an operator accidentally replay a used ID. The small lifetime test budget
  // fails back to ordinary matchmaking when exhausted.
  if (!config || history.length >= CAPUA_RESERVATION_LIMIT ||
      history.some(row => row.reservationId === config.reservationId) ||
      !['queued', 'cancelled', 'expired'].includes(attempt.phase) || !matchesCapuaParty(config, attempt)) return null;
  const bound: BoundCapuaReservation = {...config, memberIds: [...config.memberIds],
    attemptId: attempt.attemptId, boundAt: now, assignmentId: null};
  history.push(bound);
  return bound;
}

export function activeCapuaReservation(history: BoundCapuaReservation[], config: CapuaReservation | null,
                                       attempt: GroupAdmissionAttempt): BoundCapuaReservation | null {
  if (!config || attempt.phase !== 'queued' || !matchesCapuaParty(config, attempt)) return null;
  return history.find(row => row.reservationId === config.reservationId && row.attemptId === attempt.attemptId &&
    row.assignmentId === null && row.partyId === config.partyId && row.expiresAt === config.expiresAt &&
    row.memberIds.every(id => config.memberIds.includes(id))) ?? null;
}
