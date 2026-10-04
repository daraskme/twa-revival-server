import { ApiError, integer, json } from './http';
import type { Env } from './types';

export const MAINTENANCE_KEY = 'maintenance';
export const ANNOUNCEMENTS_KEY = 'announcements';
export const MIN_CLIENT_VERSION_KEY = 'min_client_version';
export const MANIFEST_URL = '/v1/update/manifest?channel=stable';
export const CLIENT_VERSION_HEADER = 'X-TWA-Client-Version';
const MAX_ANNOUNCEMENTS = 50;

/** Epoch **seconds**, like every other timestamp in D1. `startsAt`/`endsAt`
 * are informational for the companion's banner; only `enabled` gates traffic.
 */
export interface MaintenanceRecord {
  enabled: boolean;
  message: string;
  startsAt?: number;
  endsAt?: number;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  expiresAt?: number;
}

export const NO_MAINTENANCE: MaintenanceRecord = { enabled: false, message: '' };

export interface StartupControl {
  maintenance: MaintenanceRecord;
  minClientVersion: string;
}

function startupConfigurationUnavailable(): never {
  throw new ApiError(503, 'startup_configuration_unavailable');
}

/** Reject C0/C1 control characters without embedding raw control bytes in source. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function isTimestamp(value: unknown): value is number {
  return integer(value, 0, 4_102_444_800);
}

export function parseMaintenance(value: unknown): MaintenanceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_maintenance');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !['enabled', 'message', 'startsAt', 'endsAt'].includes(key))) {
    throw new ApiError(400, 'unknown_field');
  }
  if (typeof record.enabled !== 'boolean') throw new ApiError(400, 'invalid_maintenance');
  if (typeof record.message !== 'string' || record.message.length > 500 ||
      hasControlCharacters(record.message)) {
    throw new ApiError(400, 'invalid_maintenance_message');
  }
  const result: MaintenanceRecord = { enabled: record.enabled, message: record.message };
  if (record.startsAt !== undefined) {
    if (!isTimestamp(record.startsAt)) throw new ApiError(400, 'invalid_maintenance_window');
    result.startsAt = record.startsAt;
  }
  if (record.endsAt !== undefined) {
    if (!isTimestamp(record.endsAt)) throw new ApiError(400, 'invalid_maintenance_window');
    result.endsAt = record.endsAt;
  }
  if (result.startsAt !== undefined && result.endsAt !== undefined && result.endsAt < result.startsAt) {
    throw new ApiError(400, 'invalid_maintenance_window');
  }
  return result;
}

/** Read the maintenance switch. A missing binding, absent key or corrupt value
 * must never take the service down, so every failure means "not in maintenance".
 */
export async function readMaintenance(env: Env): Promise<MaintenanceRecord> {
  if (!env.CONTROL) return NO_MAINTENANCE;
  let stored: unknown;
  try { stored = await env.CONTROL.get(MAINTENANCE_KEY, 'json'); }
  catch { return NO_MAINTENANCE; }
  if (stored === null || stored === undefined) return NO_MAINTENANCE;
  try { return parseMaintenance(stored); } catch { return NO_MAINTENANCE; }
}

/** Read the control-plane values required for a truthful public health check.
 *
 * This is intentionally separate from readMaintenance/readMinClientVersion:
 * gameplay keeps its existing fail-open behavior, while /health must not say
 * the service is ready when its maintenance or update gate cannot be read.
 */
export async function readStartupControl(env: Env): Promise<StartupControl> {
  if (!env.CONTROL) return startupConfigurationUnavailable();

  let storedMaintenance: unknown;
  let storedMinimum: string | null;
  try {
    [storedMaintenance, storedMinimum] = await Promise.all([
      env.CONTROL.get(MAINTENANCE_KEY, 'json'),
      env.CONTROL.get(MIN_CLIENT_VERSION_KEY, 'text'),
    ]);
  } catch {
    return startupConfigurationUnavailable();
  }

  if (storedMaintenance === null || storedMaintenance === undefined ||
      storedMinimum === null || storedMinimum === undefined) {
    return startupConfigurationUnavailable();
  }

  let maintenance: MaintenanceRecord;
  try {
    maintenance = parseMaintenance(storedMaintenance);
  } catch {
    return startupConfigurationUnavailable();
  }

  if (typeof storedMinimum !== 'string') return startupConfigurationUnavailable();
  const minClientVersion = storedMinimum.trim();
  if (!isSemver(minClientVersion)) return startupConfigurationUnavailable();
  return { maintenance, minClientVersion };
}

export function maintenanceResponse(record: MaintenanceRecord): Response {
  return json({ error: 'maintenance', message: record.message, endsAt: record.endsAt ?? null }, 503,
    { 'Retry-After': '300' });
}

export function parseAnnouncements(value: unknown): Announcement[] {
  if (!Array.isArray(value)) throw new ApiError(400, 'invalid_announcements');
  if (value.length > MAX_ANNOUNCEMENTS) throw new ApiError(400, 'too_many_announcements');
  const result = value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ApiError(400, 'invalid_announcement');
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some(key => !['id', 'title', 'body', 'createdAt', 'expiresAt'].includes(key))) {
      throw new ApiError(400, 'unknown_field');
    }
    if (typeof record.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(record.id)) throw new ApiError(400, 'invalid_announcement');
    if (typeof record.title !== 'string' || record.title.length < 1 || record.title.length > 200 ||
        hasControlCharacters(record.title)) {
      throw new ApiError(400, 'invalid_announcement');
    }
    // Announcement bodies may contain newlines; only C1 and non-newline C0 are rejected.
    if (typeof record.body !== 'string' || record.body.length > 4000 ||
        hasControlCharacters(record.body.replaceAll('\n', ' ').replaceAll('\r', ' '))) {
      throw new ApiError(400, 'invalid_announcement');
    }
    if (!isTimestamp(record.createdAt)) throw new ApiError(400, 'invalid_announcement');
    const announcement: Announcement = {
      id: record.id, title: record.title, body: record.body, createdAt: record.createdAt,
    };
    if (record.expiresAt !== undefined) {
      if (!isTimestamp(record.expiresAt)) throw new ApiError(400, 'invalid_announcement');
      announcement.expiresAt = record.expiresAt;
    }
    return announcement;
  });
  if (new Set(result.map(entry => entry.id)).size !== result.length) throw new ApiError(400, 'duplicate_announcement_id');
  return result;
}

export async function readAnnouncements(env: Env): Promise<Announcement[]> {
  if (!env.CONTROL) return [];
  let stored: unknown;
  try { stored = await env.CONTROL.get(ANNOUNCEMENTS_KEY, 'json'); }
  catch { return []; }
  if (stored === null || stored === undefined) return [];
  try { return parseAnnouncements(stored); } catch { return []; }
}

export function liveAnnouncements(all: readonly Announcement[], nowSeconds: number): Announcement[] {
  return all.filter(entry => entry.expiresAt === undefined || entry.expiresAt > nowSeconds)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
}

const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && SEMVER.test(value);
}

/** Minimal SemVer 2.0.0 precedence. Build metadata is ignored; a prerelease
 * sorts below its release, and prerelease identifiers compare numerically when
 * both are numeric and by ASCII otherwise. No dependency, no ranges.
 */
export function compareSemver(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) throw new ApiError(400, 'invalid_semver');
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  const leftPre = a[4];
  const rightPre = b[4];
  if (leftPre === undefined && rightPre === undefined) return 0;
  if (leftPre === undefined) return 1;
  if (rightPre === undefined) return -1;
  const leftParts = leftPre.split('.');
  const rightParts = rightPre.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const x = leftParts[index];
    const y = rightParts[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export async function readMinClientVersion(env: Env): Promise<string | null> {
  if (!env.CONTROL) return null;
  let stored: string | null;
  try { stored = await env.CONTROL.get(MIN_CLIENT_VERSION_KEY, 'text'); }
  catch { return null; }
  if (stored === null) return null;
  const trimmed = stored.trim().replace(/^"|"$/g, '');
  return isSemver(trimmed) ? trimmed : null;
}

/** Enforced on the two routes a companion must pass before it can play.
 * A missing header is treated as "too old": an unversioned build cannot be
 * distinguished from a build that predates the header.
 */
export async function enforceClientVersion(request: Request, env: Env): Promise<void> {
  const minimum = await readMinClientVersion(env);
  if (!minimum) return;
  const header = request.headers.get(CLIENT_VERSION_HEADER)?.trim() ?? '';
  if (!isSemver(header) || compareSemver(header, minimum) < 0) {
    throw new ApiError(426, 'update_required', { minClientVersion: minimum, manifestUrl: MANIFEST_URL });
  }
}
