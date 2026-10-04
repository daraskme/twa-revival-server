import { ApiError, fields, integer, json, readJson } from './http';
import { bearer } from './accounts';
import {
  ANNOUNCEMENTS_KEY, MAINTENANCE_KEY, MIN_CLIENT_VERSION_KEY, isSemver, parseAnnouncements, parseMaintenance,
  readAnnouncements, readMaintenance, readMinClientVersion,
} from './control';
import type { Env } from './types';

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

/** Compare two secrets without a length- or prefix-dependent early exit.
 * Both sides are hashed first so even the token length is not observable.
 */
export async function secretEquals(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < x.length; index += 1) difference |= x[index] ^ y[index];
  return difference === 0;
}

/** The admin surface has its own secret and its own budget. It deliberately
 * shares nothing with the player session path: no EOS token, no D1 session.
 */
export async function authorizeAdmin(request: Request, env: Env): Promise<void> {
  const configured = env.ADMIN_TOKEN;
  if (typeof configured !== 'string' || configured.length < 32 || configured.length > 512 ||
      /REPLACE_ME/i.test(configured)) {
    throw new ApiError(503, 'admin_not_configured');
  }
  const presented = bearer(request);
  if (!(await secretEquals(presented, configured))) throw new ApiError(401, 'admin_unauthorized');
}

function listLimit(url: URL): number {
  const parameters = [...url.searchParams.keys()];
  if (parameters.some(key => key !== 'limit') || parameters.length > 1) throw new ApiError(400, 'query_not_supported');
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIST_LIMIT;
  if (!/^\d{1,3}$/.test(raw)) throw new ApiError(400, 'invalid_limit');
  const value = Number(raw);
  if (!integer(value, 1, MAX_LIST_LIMIT)) throw new ApiError(400, 'invalid_limit');
  return value;
}

async function setUserStatus(userId: string, status: 'active' | 'banned', env: Env): Promise<Response> {
  if (!USER_ID.test(userId)) throw new ApiError(400, 'invalid_user_id');
  // Both directions revoke every session, mirroring scripts/manage-user.mjs:
  // an unbanned account must log in again rather than resume an old token.
  const result = await env.DB.batch([
    env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, userId),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('SELECT id, display_name, status FROM users WHERE id = ?').bind(userId),
  ]);
  const row = (result.at(-1)!.results as Array<{ id: string; display_name: string; status: string }>)[0];
  if (!row) throw new ApiError(404, 'user_not_found');
  return json({ user: { id: row.id, displayName: row.display_name, status: row.status } });
}

export async function handleAdmin(request: Request, url: URL, env: Env): Promise<Response> {
  if (!(await env.ADMIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) {
    throw new ApiError(429, 'rate_limited');
  }
  await authorizeAdmin(request, env);
  const path = url.pathname;
  const method = request.method;

  if (path === '/admin/maintenance') {
    if (method === 'GET') return json({ maintenance: await readMaintenance(env) });
    if (method === 'PUT') {
      const record = parseMaintenance(await readJson(request));
      await env.CONTROL.put(MAINTENANCE_KEY, JSON.stringify(record));
      return json({ maintenance: record });
    }
    throw new ApiError(405, 'method_not_allowed');
  }

  if (path === '/admin/announcements') {
    if (method === 'GET') return json({ announcements: await readAnnouncements(env) });
    if (method === 'PUT') {
      const body = await readJson(request, 64 * 1024);
      fields(body, ['announcements']);
      const announcements = parseAnnouncements(body.announcements);
      await env.CONTROL.put(ANNOUNCEMENTS_KEY, JSON.stringify(announcements));
      return json({ announcements });
    }
    throw new ApiError(405, 'method_not_allowed');
  }

  if (path === '/admin/update/min-version') {
    if (method === 'GET') return json({ minClientVersion: await readMinClientVersion(env) });
    if (method === 'PUT') {
      const body = await readJson(request);
      fields(body, ['minClientVersion']);
      if (body.minClientVersion === null) {
        await env.CONTROL.delete(MIN_CLIENT_VERSION_KEY);
        return json({ minClientVersion: null });
      }
      if (!isSemver(body.minClientVersion)) throw new ApiError(400, 'invalid_semver');
      await env.CONTROL.put(MIN_CLIENT_VERSION_KEY, body.minClientVersion);
      return json({ minClientVersion: body.minClientVersion });
    }
    throw new ApiError(405, 'method_not_allowed');
  }

  if (path === '/admin/users' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT id, display_name, status, commander_id, created_at
      FROM users ORDER BY created_at DESC, id ASC LIMIT ?`).bind(listLimit(url))
      .all<{ id: string; display_name: string; status: string; commander_id: string | null; created_at: number }>();
    // Never expose session or invitation material through the admin list.
    return json({ users: rows.results.map(row => ({ id: row.id, displayName: row.display_name, status: row.status,
      commanderId: row.commander_id, createdAt: row.created_at })) });
  }

  const userRoute = /^\/admin\/users\/([^/]+)\/(ban|unban)$/.exec(path);
  if (userRoute) {
    if (method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    return setUserStatus(decodeURIComponent(userRoute[1]), userRoute[2] === 'ban' ? 'banned' : 'active', env);
  }

  if (path === '/admin/battles' && method === 'GET') {
    const rows = await env.DB.prepare(`SELECT b.id, b.created_by, b.mode, b.ruleset, b.map_key, b.status,
      b.winner_team, b.winner_decided, b.created_at, b.expires_at,
      (SELECT COUNT(*) FROM battle_participants p WHERE p.battle_id = b.id) AS participants,
      (SELECT COUNT(*) FROM battle_settlements s WHERE s.battle_id = b.id) AS settlements
      FROM battles b ORDER BY b.created_at DESC, b.id ASC LIMIT ?`).bind(listLimit(url))
      .all<{ id: string; created_by: string; mode: string; ruleset: string; map_key: string; status: string;
        winner_team: number | null; winner_decided: number; created_at: number; expires_at: number;
        participants: number; settlements: number }>();
    return json({ battles: rows.results.map(row => ({ battleId: row.id, createdBy: row.created_by, mode: row.mode,
      ruleset: row.ruleset, mapKey: row.map_key, status: row.status,
      winnerTeam: row.winner_decided === 1 ? row.winner_team : null,
      participants: row.participants, settlements: row.settlements,
      createdAt: row.created_at, expiresAt: row.expires_at })) });
  }

  throw new ApiError(404, 'not_found');
}
