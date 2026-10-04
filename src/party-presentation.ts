import commanders from '../data/commanders.json';
import {ApiError} from './http';
import {resolveSelectionRow, type SelectionRow} from './loadout-selection';
import type {Env} from './types';

export interface PartyPresentation {
  commanderId: string;
  loadoutRevision: number;
  commander_key: string;
  commander_skin_key: string;
  units: string[];
}

interface SelectedRow {
  id: string;
  commander_id: string | null;
  loadout_commander_id: string | null;
  item_ids: string | null;
  revision: number | null;
}
const byId = new Map(commanders.map(row => [row.id, row]));

/** Input IDs are the authenticated actor's current party, supplied by Social.
 * One D1 SELECT observes commander and ordered unit selection together. No
 * caller-supplied native keys, tiers or peer IDs enter the response. */
export async function readPartyPresentations(ids: readonly string[], env: Env): Promise<Record<string, PartyPresentation | null>> {
  if (ids.length < 1 || ids.length > 4 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id))) {
    throw new ApiError(503, 'invalid_party_members');
  }
  const records = await env.DB.prepare(`SELECT u.id, u.commander_id,
    ul.commander_id AS loadout_commander_id, ul.item_ids, ul.revision
    FROM users u LEFT JOIN user_loadouts ul ON ul.user_id = u.id
    WHERE u.status = 'active' AND u.id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).all<SelectedRow>();
  const result: Record<string, PartyPresentation | null> = Object.fromEntries(ids.map(id => [id, null]));
  for (const row of records.results) {
    if (!ids.includes(row.id)) throw new ApiError(503, 'invalid_party_selection');
    if (!row.commander_id) continue;
    const commander = byId.get(row.commander_id);
    if (!commander) throw new ApiError(503, 'invalid_party_selection');
    const stored: SelectionRow | null = row.revision === null ? null : {
      commander_id: row.loadout_commander_id!, item_ids: row.item_ids!, revision: row.revision,
    };
    const selected = resolveSelectionRow(row.id, row.commander_id, stored);
    if (!Number.isSafeInteger(selected.revision) || selected.revision < 0 ||
        selected.loadout.faction !== commander.faction || selected.loadout.units.length !== 3) {
      throw new ApiError(503, 'invalid_party_selection');
    }
    result[row.id] = {commanderId: commander.id, loadoutRevision: selected.revision,
      commander_key: commander.key, commander_skin_key: '',
      units: selected.loadout.units.map(unit => unit.key)};
  }
  return result;
}
