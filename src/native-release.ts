import { NATIVE_RELEASE_BUILD } from './native-release-build';
import { nativePvpTestHealth, nativePvpTestMatchmaking, type NativePvpTestEnv } from './native-pvp-test';
import { ApiError } from './http';

export const NATIVE_PROTOCOL = 'twa-relay-v1';
export interface NativeReleaseEnv extends NativePvpTestEnv { NATIVE_PUBLIC_PROTOCOL?: string }

export function retiredPublicPve(env: NativeReleaseEnv, mode: unknown): boolean {
  return env.NATIVE_PUBLIC_PROTOCOL === NATIVE_PROTOCOL && mode === 'pve';
}

/** Public matchmaking and new private rooms use PvP only. CPU seats fill
 * unused public capacity; already allocated legacy battles keep their contract. */
export function requirePublicQueueRuleset(env: NativeReleaseEnv, ruleset: string, mode?: unknown): void {
  if (retiredPublicPve(env, mode)) {
    throw new ApiError(409, 'battle_mode_removed');
  }
}

export function nativeReleaseEnabled(env: NativeReleaseEnv, releaseBuild = NATIVE_RELEASE_BUILD): boolean {
  return releaseBuild === true && env.NATIVE_PUBLIC_PROTOCOL === NATIVE_PROTOCOL &&
    ['staging', 'production'].includes(env.DEPLOYMENT_ENVIRONMENT ?? '') &&
    env.NATIVE_PVP_TEST_ENABLED !== 'true';
}

// Capability advertisement, not an authentication or gameplay acceptance claim.
// Existing session, assignment, squad, relay ticket and settlement checks still
// authorize every operation independently.
export function nativeHealth(env: NativeReleaseEnv) {
  return nativeReleaseEnabled(env)
    ? { nativeBattles: true, nativeProtocol: NATIVE_PROTOCOL }
    : nativePvpTestHealth(env);
}

export function nativeMatchmaking<T extends Parameters<typeof nativePvpTestMatchmaking>[0]>(
  view: T, env: NativeReleaseEnv,
) {
  if (!nativeReleaseEnabled(env) || !('nativeBattles' in view)) return nativePvpTestMatchmaking(view, env);
  return { ...view, nativeBattles: true, nativeProtocol: NATIVE_PROTOCOL,
    status: view.status === 'awaiting_gameplay_adapter' ? 'native_ready' : view.status,
    assignment: view.assignment ? { ...view.assignment, unavailableReason: null } : null };
}
