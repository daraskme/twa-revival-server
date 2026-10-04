import {compareSemver, isSemver} from './control';
import {ApiError} from './http';

/** Protocol floors cannot depend on optional operational KV: old renderers
 * must never consume a policy whose roster algorithm they do not implement. */
export const PUBLIC_ROSTER_MIN_LAUNCHER = '0.2.34';
export const PUBLIC_ROSTER_V4_MIN_LAUNCHER = '0.2.39';
export const PUBLIC_ROSTER_V5_MIN_LAUNCHER = '0.2.40';
export const LAUNCHER_VERSION_HEADER = 'X-TWA-Launcher-Version';
const LAUNCHER_MANIFEST_URL = '/v1/update/launcher-manifest?channel=stable';

export function supportedRosterPolicyVersion(request?: Request): 2 | 3 | 4 | 5 {
  // X-TWA-Client-Version is the separate installed game-data version.
  const version = request?.headers.get(LAUNCHER_VERSION_HEADER)?.trim() ?? '';
  if (!isSemver(version)) return 2;
  if (compareSemver(version, PUBLIC_ROSTER_V5_MIN_LAUNCHER) >= 0) return 5;
  if (compareSemver(version, PUBLIC_ROSTER_V4_MIN_LAUNCHER) >= 0) return 4;
  return compareSemver(version, PUBLIC_ROSTER_MIN_LAUNCHER) >= 0 ? 3 : 2;
}

export function requirePublicRosterClient(request?: Request, minimumPolicy: 3 | 4 | 5 = 3): void {
  if (supportedRosterPolicyVersion(request) < minimumPolicy) {
    throw new ApiError(426, 'launcher_update_required', {
      minLauncherVersion: minimumPolicy === 5 ? PUBLIC_ROSTER_V5_MIN_LAUNCHER :
        minimumPolicy === 4 ? PUBLIC_ROSTER_V4_MIN_LAUNCHER : PUBLIC_ROSTER_MIN_LAUNCHER,
      manifestUrl: LAUNCHER_MANIFEST_URL,
    });
  }
}

export function requireRosterPolicyClient(request: Request | undefined,
  policy: {version: number} | null | undefined): void {
  if (policy?.version === 3 || policy?.version === 4 || policy?.version === 5)
    requirePublicRosterClient(request, policy.version);
}

/** Check cancel responses too: a claimed party cannot be cancelled, and that
 * response may still contain its frozen assignment. */
export function requireMatchmakingRosterClient(request: Request, body: unknown): void {
  const view = body as {assignment?: {rosterPolicy?: {version: number} | null} | null;
    partyAttempt?: {rosterPolicyVersion?: number} | null};
  requireRosterPolicyClient(request, view.assignment?.rosterPolicy);
  if (view.partyAttempt?.rosterPolicyVersion === 3 || view.partyAttempt?.rosterPolicyVersion === 4 ||
      view.partyAttempt?.rosterPolicyVersion === 5)
    requirePublicRosterClient(request, view.partyAttempt.rosterPolicyVersion);
}
