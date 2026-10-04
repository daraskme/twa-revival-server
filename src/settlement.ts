import { ApiError, integer } from './http';
import { validRewardPolicy, type StandardRewardPolicy } from './battle-rules';

export type BattleResult = 'victory' | 'defeat' | 'draw' | 'aborted';

export const BATTLE_RESULTS: readonly BattleResult[] = ['victory', 'defeat', 'draw', 'aborted'];

export function isBattleResult(value: unknown): value is BattleResult {
  return typeof value === 'string' && (BATTLE_RESULTS as readonly string[]).includes(value);
}

export interface UnitReward { unitId: string; xp: number }

export interface RewardAmounts {
  silver: number;
  freeXp: number;
  commanderXp: number;
  unitXp: UnitReward[];
}

export interface SettlementReport {
  result: BattleResult;
  wasAfk: boolean;
  base: RewardAmounts;
}

export interface RewardCaps {
  silver: number;
  freeXp: number;
  commanderXp: number;
  unitXp: number;
}

export interface Settlement {
  policyId: StandardRewardPolicy['policyId'];
  authority: 'server';
  /** The multiplier actually applied, not the requested one. */
  appliedMultiplier: number | null;
  zeroReason: 'afk' | 'aborted' | 'private' | null;
  awarded: RewardAmounts;
}

export const DEFAULT_REWARD_CAPS: RewardCaps = {
  // Safe fallback for an omitted/malformed deployment variable.  Normal
  // rewards stay far below this; the cap exists to reject impossible input,
  // not to break a legitimate high-tier result because one env var was lost.
  silver: 1_000_000_000, freeXp: 1_000_000_000,
  commanderXp: 1_000_000_000, unitXp: 1_000_000_000,
};

/** Absolute ceiling for any configured cap: keeps an operator typo from turning
 * into an unbounded grant and keeps every product within safe-integer math.
 */
const MAX_CAP = 1_000_000_000;

export function rewardCaps(source: {
  REWARD_CAP_SILVER?: string; REWARD_CAP_FREE_XP?: string;
  REWARD_CAP_COMMANDER_XP?: string; REWARD_CAP_UNIT_XP?: string;
}): RewardCaps {
  const read = (value: string | undefined, fallback: number): number => {
    if (value === undefined || value === null || value === '') return fallback;
    if (!/^\d{1,10}$/.test(value)) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_CAP ? parsed : fallback;
  };
  return {
    silver: read(source.REWARD_CAP_SILVER, DEFAULT_REWARD_CAPS.silver),
    freeXp: read(source.REWARD_CAP_FREE_XP, DEFAULT_REWARD_CAPS.freeXp),
    commanderXp: read(source.REWARD_CAP_COMMANDER_XP, DEFAULT_REWARD_CAPS.commanderXp),
    unitXp: read(source.REWARD_CAP_UNIT_XP, DEFAULT_REWARD_CAPS.unitXp),
  };
}

/** Reject a report whose claimed base amounts exceed the operator ceiling.
 * Amounts are never silently clamped: a caller must not be able to learn the
 * cap by observing a truncated grant.
 */
export function assertWithinCaps(base: RewardAmounts, caps: RewardCaps): void {
  if (base.silver > caps.silver || base.freeXp > caps.freeXp || base.commanderXp > caps.commanderXp ||
      base.unitXp.some(unit => unit.xp > caps.unitXp)) {
    throw new ApiError(422, 'reward_cap_exceeded', { caps });
  }
}

function amount(value: unknown, field: string): number {
  if (!integer(value, 0, MAX_CAP)) throw new ApiError(400, 'invalid_reward_amount', { field });
  return value;
}

/** Parse the untrusted `base` object of a result report. Structure only: the
 * unit identifiers are checked against the frozen battle roster by the caller.
 */
export function parseRewardAmounts(value: unknown): RewardAmounts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_base');
  const record = value as Record<string, unknown>;
  const allowed = ['silver', 'freeXp', 'commanderXp', 'unitXp'];
  if (Object.keys(record).some(key => !allowed.includes(key))) throw new ApiError(400, 'unknown_field');
  if (!Array.isArray(record.unitXp) || record.unitXp.length > 3) throw new ApiError(400, 'invalid_unit_xp');
  const unitXp = record.unitXp.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ApiError(400, 'invalid_unit_xp');
    const unit = entry as Record<string, unknown>;
    if (Object.keys(unit).some(key => key !== 'unitId' && key !== 'xp')) throw new ApiError(400, 'unknown_field');
    if (typeof unit.unitId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(unit.unitId)) {
      throw new ApiError(400, 'invalid_unit_xp');
    }
    return { unitId: unit.unitId, xp: amount(unit.xp, 'unitXp') };
  });
  if (new Set(unitXp.map(unit => unit.unitId)).size !== unitXp.length) throw new ApiError(400, 'duplicate_unit_xp');
  return {
    silver: amount(record.silver, 'silver'),
    freeXp: amount(record.freeXp, 'freeXp'),
    commanderXp: amount(record.commanderXp, 'commanderXp'),
    unitXp,
  };
}

/** Pure server-authoritative reward math.
 *
 * The only inputs are the policy frozen at battle creation and the reported
 * outcome. A client cannot supply a multiplier, deny an AFK flag's effect, or
 * turn an aborted battle into a payout: AFK and abort both fall back to the
 * policy's `afkMultiplier` (0). Products are floored so no fractional currency
 * can be created by the PvP 1.5 multiplier.
 */
export function computeSettlement(policy: StandardRewardPolicy, report: SettlementReport): Settlement {
  const inferredMode = policy?.policyId === 'standard-reward-v1' && policy.modeMultiplier === 1.5 ? 'pvp' : 'pve';
  if (!validRewardPolicy(policy, inferredMode)) {
    throw new ApiError(500, 'invalid_reward_policy');
  }
  if (!isBattleResult(report?.result) || typeof report.wasAfk !== 'boolean') {
    throw new ApiError(400, 'invalid_result');
  }
  const zeroReason = report.wasAfk ? 'afk' : report.result === 'aborted' ? 'aborted' : null;
  if ((policy.policyId === 'public-fxp-reward-v2' || policy.policyId === 'public-zero-reward-v3')) {
    const freeXp = report.wasAfk ? policy.afkAward : policy.outcomeAwards[report.result];
    return {
      policyId: policy.policyId, authority: policy.authority, appliedMultiplier: null, zeroReason,
      awarded: { silver: 0, freeXp, commanderXp: 0, unitXp: [] },
    };
  }
  if (policy.policyId === 'private-zero-reward-v1') {
    return { policyId: policy.policyId, authority: policy.authority, appliedMultiplier: null,
      zeroReason: zeroReason ?? 'private', awarded: { silver: 0, freeXp: 0, commanderXp: 0, unitXp: [] } };
  }
  const multiplier = zeroReason ? policy.afkMultiplier : policy.modeMultiplier;
  const scale = (value: number): number => {
    const scaled = Math.floor(amount(value, 'base') * multiplier);
    if (!Number.isSafeInteger(scaled) || scaled < 0) throw new ApiError(400, 'invalid_reward_amount');
    return scaled;
  };
  return {
    policyId: policy.policyId, authority: policy.authority, appliedMultiplier: multiplier, zeroReason,
    awarded: {
      silver: scale(report.base.silver),
      freeXp: scale(report.base.freeXp),
      commanderXp: scale(report.base.commanderXp),
      unitXp: report.base.unitXp.map(unit => ({ unitId: unit.unitId, xp: scale(unit.xp) })),
    },
  };
}

/** Team that the reporter's own outcome implies won. `null` means "no winner"
 * (draw or abort) and is a decided value, not an absent one.
 */
export function impliedWinnerTeam(result: BattleResult, team: 0 | 1): 0 | 1 | null {
  if (result === 'victory') return team;
  if (result === 'defeat') return team === 0 ? 1 : 0;
  return null;
}
