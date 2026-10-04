import { ApiError, fields, integer, json, readJson, serializedSize } from './http';
import type { Actor, Env } from './types';

/** Serialized bytes of the opaque hangar blob. The Worker never interprets it. */
export const PROFILE_BLOB_LIMIT = 512 * 1024;
/** Request ceiling: the blob plus the small `{schemaVersion,saved}` envelope. */
export const PROFILE_BODY_LIMIT = PROFILE_BLOB_LIMIT + 4096;
const MAX_SCHEMA_VERSION = 1_000_000;
const MAX_SAVED = Number.MAX_SAFE_INTEGER;

interface ProfileRow {
  schema_version: number;
  saved: number;
  blob: string;
  size: number;
  updated_at: number;
}

/** `If-Match: "<saved>"` selects a specific stored watermark. An absent header
 * or `"*"` means "create only": it must never overwrite an existing profile.
 */
function expectedSaved(request: Request): number | null {
  const header = request.headers.get('If-Match');
  if (header === null || header.trim() === '' || header.trim() === '*') return null;
  const match = /^"(\d{1,15})"$/.exec(header.trim());
  if (!match) throw new ApiError(400, 'invalid_if_match');
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(400, 'invalid_if_match');
  return value;
}

export async function getProfile(actor: Actor, env: Env): Promise<Response> {
  const row = await env.DB.prepare('SELECT schema_version, saved, blob, size, updated_at FROM profiles WHERE user_id = ?')
    .bind(actor.id).first<ProfileRow>();
  if (!row) throw new ApiError(404, 'profile_not_found');
  let blob: unknown;
  try { blob = JSON.parse(row.blob); } catch { throw new ApiError(503, 'profile_unreadable'); }
  return json({ schemaVersion: row.schema_version, saved: row.saved, blob, size: row.size, updatedAt: row.updated_at },
    200, { ETag: `"${row.saved}"` });
}

export async function putProfile(actor: Actor, request: Request, env: Env): Promise<Response> {
  const expected = expectedSaved(request);
  const body = await readJson(request, PROFILE_BODY_LIMIT);
  fields(body, ['schemaVersion', 'saved', 'blob']);
  if (!integer(body.schemaVersion, 0, MAX_SCHEMA_VERSION)) throw new ApiError(400, 'invalid_schema_version');
  if (!integer(body.saved, 0, MAX_SAVED)) throw new ApiError(400, 'invalid_saved');
  if (!body.blob || typeof body.blob !== 'object' || Array.isArray(body.blob)) throw new ApiError(400, 'invalid_blob');
  // Re-serialize: the stored bytes, not the caller's framing, define the size.
  const serialized = JSON.stringify(body.blob);
  const size = serializedSize(body.blob);
  if (size > PROFILE_BLOB_LIMIT) throw new ApiError(413, 'profile_too_large', { limit: PROFILE_BLOB_LIMIT });
  const now = Math.floor(Date.now() / 1000);
  // A D1 batch is one transaction, so exactly one of these two writes can apply.
  // The UPDATE needs a matching watermark AND a strictly greater `saved`;
  // `profiles.saved = NULL` is never true, so a create-only request can never
  // reach it. The INSERT is suppressed unless the request is create-only, so a
  // precondition naming a version cannot conjure a profile that does not exist.
  const [updated, created, stored] = await env.DB.batch([
    env.DB.prepare(`UPDATE profiles SET schema_version = ?, saved = ?, blob = ?, size = ?, updated_at = ?
      WHERE user_id = ? AND saved = ? AND ? > saved RETURNING saved`)
      .bind(body.schemaVersion, body.saved, serialized, size, now, actor.id, expected, body.saved),
    env.DB.prepare(`INSERT OR IGNORE INTO profiles (user_id, schema_version, saved, blob, size, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ? IS NULL RETURNING saved`)
      .bind(actor.id, body.schemaVersion, body.saved, serialized, size, now, expected),
    env.DB.prepare('SELECT saved FROM profiles WHERE user_id = ?').bind(actor.id),
  ]);
  const written = ((updated.results as Array<{ saved: number }>)[0]
    ?? (created.results as Array<{ saved: number }>)[0]) as { saved: number } | undefined;
  if (written) {
    return json({ schemaVersion: body.schemaVersion, saved: written.saved, size, updatedAt: now },
      expected === null ? 201 : 200, { ETag: `"${written.saved}"` });
  }
  const current = (stored.results as Array<{ saved: number }>)[0];
  if (!current) throw new ApiError(409, 'profile_conflict', { saved: null });
  if (expected === null || current.saved !== expected) throw new ApiError(409, 'profile_conflict', { saved: current.saved });
  throw new ApiError(400, 'profile_not_monotonic', { saved: current.saved });
}
