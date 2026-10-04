import { ApiError, fields, integer, json, readJson } from './http';
import { resolveSandboxSelection, starterLoadout, type VerifiedLoadout } from './loadouts';
import type { Actor, Env } from './types';

export interface SelectionRow { commander_id: string; item_ids: string; revision: number }
export interface ResolvedSelection { revision: number; loadout: VerifiedLoadout }

function itemIds(row: SelectionRow): string[] {
  let value: unknown;
  try { value = JSON.parse(row.item_ids); } catch { throw new ApiError(503, 'loadout_unreadable'); }
  if (!Array.isArray(value)) throw new ApiError(503, 'loadout_unreadable');
  return value as string[];
}

export function resolveSelectionRow(userId: string, commanderId: string, row?: SelectionRow | null): ResolvedSelection {
  if (!row) return { revision: 0, loadout: starterLoadout(userId, commanderId) };
  if (row.commander_id !== commanderId) throw new ApiError(503, 'loadout_unreadable');
  try { return { revision: row.revision,
    loadout: resolveSandboxSelection(userId, commanderId, itemIds(row), row.revision) }; }
  catch (error) { if (error instanceof ApiError) throw new ApiError(503, 'loadout_unreadable'); throw error; }
}

export async function readSelection(userId: string, commanderId: string, env: Env): Promise<ResolvedSelection> {
  const row = await env.DB.prepare('SELECT commander_id, item_ids, revision FROM user_loadouts WHERE user_id = ?')
    .bind(userId).first<SelectionRow>();
  return resolveSelectionRow(userId, commanderId, row);
}

export async function getLoadout(actor: Actor, env: Env): Promise<Response> {
  if (!actor.commanderId) throw new ApiError(409, 'commander_selection_required');
  return json(await readSelection(actor.id, actor.commanderId, env));
}

export async function putLoadout(actor: Actor, request: Request, env: Env): Promise<Response> {
  if (!actor.commanderId) throw new ApiError(409, 'commander_selection_required');
  const body = await readJson(request);
  fields(body, ['commanderId', 'itemIds', 'expectedRevision']);
  if (typeof body.commanderId !== 'string') throw new ApiError(400, 'invalid_commander');
  if (body.commanderId !== actor.commanderId) throw new ApiError(409, 'loadout_commander_mismatch');
  if (!Array.isArray(body.itemIds) || body.itemIds.length !== 3) throw new ApiError(400, 'invalid_loadout');
  if (!integer(body.expectedRevision, 0, Number.MAX_SAFE_INTEGER - 1)) throw new ApiError(400, 'invalid_loadout_revision');
  const expected = body.expectedRevision;
  // Validate before attempting a write. Revision-specific instance IDs are
  // generated only after the server advances the version.
  resolveSandboxSelection(actor.id, actor.commanderId, body.itemIds as string[], expected + 1);
  const serialized = JSON.stringify(body.itemIds);
  const before = await env.DB.prepare('SELECT commander_id, item_ids, revision FROM user_loadouts WHERE user_id = ?')
    .bind(actor.id).first<SelectionRow>();
  if (before && before.revision === expected && before.commander_id === actor.commanderId && before.item_ids === serialized) {
    return json(resolveSelectionRow(actor.id, actor.commanderId, before));
  }
  const now = Math.floor(Date.now() / 1000);
  if (expected === 0) {
    await env.DB.prepare(`INSERT OR IGNORE INTO user_loadouts(user_id, commander_id, item_ids, revision, updated_at)
      VALUES (?, ?, ?, 1, ?)`).bind(actor.id, actor.commanderId, serialized, now).run();
  } else {
    await env.DB.prepare(`UPDATE user_loadouts SET item_ids = ?, revision = revision + 1, updated_at = ?
      WHERE user_id = ? AND commander_id = ? AND revision = ?`)
      .bind(serialized, now, actor.id, actor.commanderId, expected).run();
  }
  const current = await env.DB.prepare('SELECT commander_id, item_ids, revision FROM user_loadouts WHERE user_id = ?')
    .bind(actor.id).first<SelectionRow>();
  if (!current) throw new ApiError(503, 'loadout_write_failed');
  const exactRaceRetry = current.commander_id === actor.commanderId && current.item_ids === serialized &&
    (current.revision === expected || current.revision === expected + 1);
  if (!exactRaceRetry) throw new ApiError(409, 'loadout_revision_conflict', { currentRevision: current.revision });
  return json(resolveSelectionRow(actor.id, actor.commanderId, current));
}
