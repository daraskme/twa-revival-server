import { ApiError } from './http';
import {
  chooseMapKeyForRuleset as chooseNativeMapKeyForRuleset,
  isMapKeyForRuleset, mapKeyForRuleset as legacyMapKeyForRuleset,
  rulesetForMapKey, type NativeBattleMapKey,
} from './native-battle-maps';

export type BattleRuleset = 'territory' | 'annihilation';
export type BattleMode = 'pvp' | 'pve';

export function isBattleMode(value: unknown): value is BattleMode {
  return value === 'pvp' || value === 'pve';
}

/** Legacy server-owned reward manifest, retained only for frozen matches and battles. */
export interface StandardRewardPolicyV1 {
  policyId: 'standard-reward-v1';
  authority: 'server';
  modeMultiplier: 1 | 1.5;
  afkMultiplier: 0;
}

export interface PublicFxpRewardPolicyV2 {
  policyId: 'public-fxp-reward-v2';
  authority: 'server';
  currency: 'free_xp_cents';
  outcomeAwards: { victory: 300_000; draw: 250_000; defeat: 200_000; aborted: 0 };
  afkAward: 0;
  otherRewardsZero: true;
}
export interface PublicZeroRewardPolicyV3 {
  policyId: 'public-zero-reward-v3';
  authority: 'server';
  currency: 'free_xp_cents';
  outcomeAwards: { victory: 0; draw: 0; defeat: 0; aborted: 0 };
  afkAward: 0;
  otherRewardsZero: true;
}
export interface PrivateZeroRewardPolicyV1 {
  policyId: 'private-zero-reward-v1';
  authority: 'server';
  allRewardsZero: true;
}

export type StandardRewardPolicy = StandardRewardPolicyV1 | PublicFxpRewardPolicyV2 | PublicZeroRewardPolicyV3 | PrivateZeroRewardPolicyV1;

export function privateRewardPolicy(): PrivateZeroRewardPolicyV1 {
  return { policyId: 'private-zero-reward-v1', authority: 'server', allRewardsZero: true };
}

export function legacyRewardPolicy(mode: BattleMode): StandardRewardPolicyV1 {
  return {
    policyId: 'standard-reward-v1', authority: 'server',
    modeMultiplier: mode === 'pve' ? 1 : 1.5, afkMultiplier: 0,
  };
}

export function legacyPublicFxpRewardPolicy(): PublicFxpRewardPolicyV2 {
  return {
    policyId: 'public-fxp-reward-v2', authority: 'server', currency: 'free_xp_cents',
    outcomeAwards: { victory: 300_000, draw: 250_000, defeat: 200_000, aborted: 0 },
    afkAward: 0, otherRewardsZero: true,
  };
}

export function rewardPolicy(_mode: BattleMode): PublicZeroRewardPolicyV3 {
  return {
    policyId: 'public-zero-reward-v3', authority: 'server', currency: 'free_xp_cents',
    outcomeAwards: { victory: 0, draw: 0, defeat: 0, aborted: 0 },
    afkAward: 0, otherRewardsZero: true,
  };
}

export function validRewardPolicy(value: unknown, mode: BattleMode): value is StandardRewardPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  if (policy.policyId === 'private-zero-reward-v1') {
    return Object.keys(policy).length === 3 && policy.authority === 'server' && policy.allRewardsZero === true;
  }
  if (policy.policyId === 'standard-reward-v1') {
    return Object.keys(policy).length === 4 && policy.authority === 'server' &&
      policy.modeMultiplier === (mode === 'pve' ? 1 : 1.5) && policy.afkMultiplier === 0;
  }
  if ((policy.policyId !== 'public-fxp-reward-v2' && policy.policyId !== 'public-zero-reward-v3') || Object.keys(policy).length !== 6 ||
      policy.authority !== 'server' || policy.currency !== 'free_xp_cents' ||
      policy.afkAward !== 0 || policy.otherRewardsZero !== true || !policy.outcomeAwards ||
      typeof policy.outcomeAwards !== 'object' || Array.isArray(policy.outcomeAwards)) return false;
  const awards = policy.outcomeAwards as Record<string, unknown>;
  return Object.keys(awards).length === 4 && awards.victory === (policy.policyId === 'public-zero-reward-v3' ? 0 : 300_000) && awards.draw === (policy.policyId === 'public-zero-reward-v3' ? 0 : 250_000) &&
    awards.defeat === (policy.policyId === 'public-zero-reward-v3' ? 0 : 200_000) && awards.aborted === 0;
}

export const DEFAULT_RULESET: BattleRuleset = 'territory';

export function isBattleRuleset(value: unknown): value is BattleRuleset {
  return value === 'territory' || value === 'annihilation';
}

export function mapKeyForRuleset(ruleset: BattleRuleset): NativeBattleMapKey {
  if (!isBattleRuleset(ruleset)) throw new Error('unsupported_battle_ruleset');
  return legacyMapKeyForRuleset(ruleset);
}

export function chooseMapKeyForRuleset(ruleset: BattleRuleset): NativeBattleMapKey {
  if (!isBattleRuleset(ruleset)) throw new Error('unsupported_battle_ruleset');
  return chooseNativeMapKeyForRuleset(ruleset);
}

/** Resolve a ruleset and validate any explicit server-manifest map key.  A
 * map never infers or overrides a conflicting explicit ruleset.  Omitted map
 * keys remain the legacy deterministic path; new allocations choose once
 * through chooseMapKeyForRuleset and persist that result. */
export function requestedRuleset(ruleset: unknown, mapKey?: unknown): BattleRuleset {
  let mapRuleset: BattleRuleset | null = null;
  if (mapKey !== undefined) {
    mapRuleset = rulesetForMapKey(mapKey);
    if (mapRuleset === null) throw new ApiError(400, 'invalid_map_key');
  }
  if (ruleset === undefined) return mapRuleset ?? DEFAULT_RULESET;
  if (!isBattleRuleset(ruleset)) throw new ApiError(400, 'invalid_ruleset');
  if (mapRuleset && mapRuleset !== ruleset) throw new ApiError(400, 'ruleset_map_mismatch');
  if (mapKey !== undefined && !isMapKeyForRuleset(mapKey, ruleset)) throw new ApiError(400, 'invalid_map_key');
  return ruleset;
}
