import type { Actor, ConnectIdentity, Env } from './types';
import { ApiError, fields } from './http';
import commanders from '../data/commanders.json';
import { starterLoadout } from './loadouts';
import { readSelection, resolveSelectionRow } from './loadout-selection';
import { registrationPolicy } from './registration';

export { commanders };
export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function bearer(request: Request): string {
  const value = request.headers.get('Authorization');
  const match = value && /^Bearer ([A-Za-z0-9_.-]{20,8192})$/.exec(value);
  if (!match) throw new ApiError(401, 'bearer_required');
  return match[1];
}

interface UserRow {
  id: string;
  display_name: string;
  commander_id: string | null;
  status: string;
  loadout_commander_id?: string | null;
  loadout_item_ids?: string | null;
  loadout_revision?: number | null;
}

function toActor(row: UserRow, includeLoadout = true): Actor {
  const commander = commanders.find(c => c.id === row.commander_id);
  if (!includeLoadout) return { id: row.id, displayName: row.display_name,
    commanderId: commander?.id ?? null, faction: commander?.faction ?? null, loadout: null };
  const selection = commander && row.loadout_revision != null && row.loadout_commander_id && row.loadout_item_ids ?
    resolveSelectionRow(row.id, commander.id, { commander_id: row.loadout_commander_id,
      item_ids: row.loadout_item_ids, revision: row.loadout_revision }) : null;
  return { id: row.id, displayName: row.display_name, commanderId: commander?.id ?? null, faction: commander?.faction ?? null,
    loadout: commander ? selection?.loadout ?? starterLoadout(row.id, commander.id) : null };
}

const USER_WITH_LOADOUT = `SELECT u.*, ul.commander_id AS loadout_commander_id,
  ul.item_ids AS loadout_item_ids, ul.revision AS loadout_revision
  FROM users u LEFT JOIN user_loadouts ul ON ul.user_id = u.id`;

function validDisplayName(value: unknown): string {
  // Match companion.player_name: the name must fit a quoted native script.
  // Count Unicode code points as Python does, including non-BMP characters.
  if (typeof value !== 'string' || value.trim().length < 1 || [...value].length > 32 || /[\\";\p{C}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new ApiError(400, 'invalid_display_name');
  }
  return value.trim();
}

export async function updateDisplayName(actor: Actor, body: Record<string, unknown>, env: Env) {
  fields(body, ['displayName']);
  const name = validDisplayName(body.displayName);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE users SET display_name = ? WHERE id = ? AND status = 'active'").bind(name, actor.id),
    env.DB.prepare(`${USER_WITH_LOADOUT} WHERE u.id = ? AND u.status = 'active'`).bind(actor.id),
  ]);
  const row = (results[1].results as unknown as UserRow[])[0];
  if (!row) throw new ApiError(403, 'account_disabled');
  // Frozen matchmaking/battle rosters are intentionally not rewritten.
  return toActor(row);
}

export async function login(identity: ConnectIdentity, body: Record<string, unknown>, env: Env) {
  fields(body, ['displayName', 'inviteCode']);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(identity.expiresAt, now + 3600);
  if (expiresAt <= now) throw new ApiError(401, 'token_expired');
  const existing = await env.DB.prepare(`${USER_WITH_LOADOUT} WHERE u.id = ?`).bind(identity.productUserId).first<UserRow>();
  if (existing?.status !== undefined && existing.status !== 'active') throw new ApiError(403, 'account_disabled');
  const displayName = body.displayName;
  const inviteCode = body.inviteCode;
  const registration = existing ? null : registrationPolicy(env);
  if (!existing) {
    if (registration === 'closed') throw new ApiError(403, 'registration_closed');
    validDisplayName(displayName);
    if (registration === 'invitation' && (typeof inviteCode !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(inviteCode))) throw new ApiError(403, 'invitation_required');
  }
  const sessionToken = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await hash(sessionToken);
  const statements: D1PreparedStatement[] = [];
  if (!existing && registration === 'open') {
    // Identity comes only from verified Epic Connect claims. Concurrent first
    // logins preserve the original name and never replace account or career data.
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO users (id, display_name, created_at) VALUES (?, ?, ?)')
      .bind(identity.productUserId, (displayName as string).trim(), now));
  } else if (!existing) {
    const codeHash = await hash(inviteCode as string);
    // D1 batch is one transaction. A claimed/expired invitation cannot admit another PUID.
    statements.push(
      env.DB.prepare('UPDATE invitations SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?')
        .bind(identity.productUserId, now, codeHash, now),
      env.DB.prepare(`INSERT OR IGNORE INTO users (id, display_name, created_at)
        SELECT ?, ?, ? FROM invitations WHERE code_hash = ? AND used_by = ? AND expires_at > ?`)
        .bind(identity.productUserId, (displayName as string).trim(), now, codeHash, identity.productUserId, now),
    );
  }
  statements.push(
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').bind(identity.productUserId, now),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      SELECT ?, id, ?, ? FROM users WHERE id = ? AND status = 'active'`)
      .bind(tokenHash, now, expiresAt, identity.productUserId),
    // Bound concurrent login sessions per account. Deterministic tie-breaker for same-second logins.
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash NOT IN
      (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 5)`)
      .bind(identity.productUserId, identity.productUserId),
    env.DB.prepare(`${USER_WITH_LOADOUT} JOIN sessions s ON s.user_id = u.id
      WHERE s.token_hash = ? AND u.status = 'active'`).bind(tokenHash),
  );
  const result = await env.DB.batch<UserRow>(statements);
  const row = result.at(-1)?.results[0];
  if (!row) throw new ApiError(403, registration === 'invitation' ? 'invitation_required' : 'account_unavailable');
  return { token: sessionToken, expiresAt, user: toActor(row) };
}

async function authenticateSession(request: Request, env: Env, includeLoadout: boolean): Promise<{ actor: Actor; tokenHash: string }> {
  const token = bearer(request);
  if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'invalid_session');
  const tokenHash = await hash(token);
  const userQuery = includeLoadout ? USER_WITH_LOADOUT : 'SELECT u.* FROM users u';
  const row = await env.DB.prepare(`${userQuery} JOIN sessions s ON s.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`)
    .bind(tokenHash, Math.floor(Date.now() / 1000)).first<UserRow>();
  if (!row) throw new ApiError(401, 'invalid_session');
  return { actor: toActor(row, includeLoadout), tokenHash };
}

export async function authenticate(request: Request, env: Env): Promise<{ actor: Actor; tokenHash: string }> {
  return authenticateSession(request, env, true);
}

/** Social authorizes the same active account and unexpired opaque session.
 * Its actor identity does not depend on a readable deployment selection, so
 * a corrupt loadout cannot prevent unready/leave. Social separately resolves
 * trusted current-party presentation for reads and ready:true. */
export async function authenticateSocial(request: Request, env: Env): Promise<{ actor: Actor; tokenHash: string }> {
  return authenticateSession(request, env, false);
}

/** Renew an active native session only with fresh, verified Epic ownership.
 * The opaque token remains bound to the running native process. No account,
 * roster, profile, other session, or already-expired session is changed. */
export async function renewSession(actor: Actor, tokenHash: string, identity: ConnectIdentity, env: Env) {
  if (identity.productUserId !== actor.id) throw new ApiError(401, 'worker_identity_mismatch');
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(identity.expiresAt, now + 3600);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new ApiError(401, 'token_expired');
  const results = await env.DB.batch<{ expires_at: number }>([
    env.DB.prepare(`UPDATE sessions SET expires_at = MAX(expires_at, ?) WHERE token_hash = ?
      AND user_id = ? AND expires_at > ? AND EXISTS
      (SELECT 1 FROM users WHERE id = ? AND status = 'active')`)
      .bind(expiresAt, tokenHash, actor.id, now, actor.id),
    env.DB.prepare(`SELECT s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ? AND u.status = 'active'`)
      .bind(tokenHash, actor.id, now),
  ]);
  const renewed = results[1].results[0];
  if (!renewed) throw new ApiError(401, 'invalid_session');
  return { expiresAt: renewed.expires_at, user: { id: actor.id } };
}

export async function selectCommander(actor: Actor, body: Record<string, unknown>, env: Env): Promise<Actor> {
  fields(body, ['commanderId']);
  const commander = commanders.find(c => c.id === body.commanderId);
  if (!commander) throw new ApiError(400, 'invalid_commander');
  const itemIds = JSON.stringify(starterLoadout(actor.id, commander.id).units.map(unit => unit.itemId));
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO user_loadouts(user_id, commander_id, item_ids, revision, updated_at)
      SELECT ?, ?, ?, 1, ? WHERE EXISTS (SELECT 1 FROM users
        WHERE id = ? AND status = 'active' AND (commander_id IS NULL OR commander_id <> ?))
      ON CONFLICT(user_id) DO UPDATE SET commander_id = excluded.commander_id,
        item_ids = excluded.item_ids, revision = user_loadouts.revision + 1, updated_at = excluded.updated_at
      WHERE EXISTS (SELECT 1 FROM users
        WHERE id = excluded.user_id AND status = 'active' AND (commander_id IS NULL OR commander_id <> excluded.commander_id))`)
      .bind(actor.id, commander.id, itemIds, now, actor.id, commander.id),
    env.DB.prepare("UPDATE users SET commander_id = ? WHERE id = ? AND status = 'active'").bind(commander.id, actor.id),
  ]);
  const selected = await readSelection(actor.id, commander.id, env);
  return { ...actor, commanderId: commander.id, faction: commander.faction, loadout: selected.loadout };
}
