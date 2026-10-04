import { INTERNAL_PVP_TEST_BUILD } from './native-pvp-build';
import type { MatchmakingView } from './matchmaking';

export interface NativePvpTestEnv {
  DEPLOYMENT_ENVIRONMENT?: string;
  NATIVE_PVP_TEST_ENABLED?: string;
}

/** Candidate advertisement only. This does not authorize tickets or native wire. */
export function evaluateNativePvpTestGate(env: NativePvpTestEnv, internalBuild: boolean) {
  const environment = env.DEPLOYMENT_ENVIRONMENT;
  const reason = internalBuild !== true ? 'non_internal_build'
    : environment !== 'staging' && environment !== 'internal-test' ? 'environment_not_internal'
    : env.NATIVE_PVP_TEST_ENABLED !== 'true' ? 'not_explicitly_enabled'
    : 'internal_test_only';
  const enabled = reason === 'internal_test_only';
  return {
    enabled,
    state: enabled ? 'candidate' as const : 'disabled' as const,
    reason,
    scope: 'health_matchmaking_only' as const,
    // Never confuse an operator's opt-in with native gameplay acceptance.
    nativeWireEnabled: false as const,
    gameplayVerified: false as const,
  };
}

export function nativePvpTestGate(env: NativePvpTestEnv) {
  return evaluateNativePvpTestGate(env, INTERNAL_PVP_TEST_BUILD);
}

export function nativePvpTestHealth(env: NativePvpTestEnv) {
  const gate = nativePvpTestGate(env);
  // Preserve the exact public health schema for the existing strict launcher.
  return gate.enabled ? { nativeBattles: true, nativePvpTest: gate } : { nativeBattles: false };
}

// Constrain only the fields this projection reads. Durable Object RPC serializes
// tuples (including cpuSeatsByTeam) as arrays; unrelated roster fields must not
// force the transport response back into the in-process MatchmakingView type.
type MatchmakingProjectionInput = Pick<MatchmakingView, 'status' | 'nativeBattles'> & {
  ticket: Pick<NonNullable<MatchmakingView['ticket']>, 'mode'> | null;
  assignment: Pick<NonNullable<MatchmakingView['assignment']>, 'mode'> | null;
};

export function nativePvpTestMatchmaking<T extends MatchmakingProjectionInput | { error: string }>(
  view: T, env: NativePvpTestEnv,
) {
  const gate = nativePvpTestGate(env);
  if (!gate.enabled || !('nativeBattles' in view)) return view;
  const mode = view.assignment?.mode ?? view.ticket?.mode;
  if (mode === 'pve') return view;
  return {
    ...view,
    nativeBattles: true,
    nativePvpTest: gate,
    // Deliberately NOT a ready state recognized by the existing Python adapter.
    // Retain assignment.unavailableReason until the adapter is separately gated.
    status: view.status === 'awaiting_gameplay_adapter' ? 'native_test_candidate' : view.status,
  };
}
