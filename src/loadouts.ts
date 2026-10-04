import native from '../data/native-loadouts.json';
import { ApiError } from './http';

export interface OwnedUnitInstance {
  instanceId: string;
  ownerId: string;
  commanderId: string;
  itemId: string;
}

export interface DeploymentUnit {
  instanceId: string;
  itemId: string;
  key: string;
  faction: string;
  tier: number;
}

export interface VerifiedLoadout {
  commanderId: string;
  faction: string;
  units: DeploymentUnit[];
  maxTier: number;
}

/** Deterministic account bootstrap data. Unit-type ownership is global to the
 * account; only the selected commander's faction is selectable in its 3 slots.
 */
export interface InitialOwnedInventory {
  ownerId: string;
  commanderId: string;
  faction: string;
  accountUnitIds: string[];
  selectableUnitIds: string[];
  slotInstanceIds: string[];
}

const units = new Map(native.units.map(unit => [unit.id, unit]));
const commanders = new Map(native.commanders.map(commander => [commander.id, commander]));
const initialAccountUnitIds = [...native.initialOwnedUnitIds];
const initialAccountUnits = new Set(initialAccountUnitIds);
export const SANDBOX_EFFECTIVE_UNIT_TIER = 10;

/** Resolve a persisted sandbox selection. Every unit emitted by the generated
 * catalog is live; item-type availability is global in this sandbox, including
 * premium types. The caller never supplies instance ownership or metadata. */
export function resolveSandboxSelection(
  userId: string, commanderId: string, selectedUnitIds: readonly string[], revision: number,
): VerifiedLoadout {
  const commander = commanders.get(commanderId);
  if (!identifier(userId) || !commander) throw new ApiError(409, 'invalid_loadout_commander');
  if (!Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(selectedUnitIds) || selectedUnitIds.length !== 3) {
    throw new ApiError(400, 'invalid_loadout');
  }
  const resolved = selectedUnitIds.map((itemId, slot) => {
    if (typeof itemId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(itemId) || BigInt(itemId) >= 2n ** 64n) {
      throw new ApiError(400, 'invalid_unit_id');
    }
    const unit = units.get(itemId);
    if (!unit) throw new ApiError(409, 'invalid_loadout_unit');
    if (unit.faction !== commander.faction) throw new ApiError(409, 'loadout_faction_mismatch');
    return { instanceId: `selected:${userId}:${revision}:${slot}`, itemId: unit.id, key: unit.key,
      faction: unit.faction, tier: SANDBOX_EFFECTIVE_UNIT_TIER };
  });
  return { commanderId, faction: commander.faction, units: resolved, maxTier: SANDBOX_EFFECTIVE_UNIT_TIER };
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
}

/** Trusted inventory input only. Neither inventory nor slot IDs are accepted by HTTP.
 * Item faction/Tier comes exclusively from the bundled native DB catalog.
 */
export function resolveOwnedLoadout(
  userId: string, commanderId: string, owned: readonly OwnedUnitInstance[], selectedInstances: readonly string[],
): VerifiedLoadout {
  const commander = commanders.get(commanderId);
  if (!identifier(userId) || !commander) throw new ApiError(409, 'invalid_loadout_commander');
  if (!Array.isArray(owned) || owned.length > 1000 || !Array.isArray(selectedInstances) || selectedInstances.length !== 3) {
    throw new ApiError(409, 'invalid_loadout_size');
  }
  const inventory = new Map<string, OwnedUnitInstance>();
  for (const instance of owned) {
    if (!instance || !identifier(instance.instanceId) || inventory.has(instance.instanceId)) {
      throw new ApiError(409, 'invalid_owned_instance');
    }
    inventory.set(instance.instanceId, instance);
  }
  if (new Set(selectedInstances).size !== 3) throw new ApiError(409, 'duplicate_loadout_instance');
  const resolved = selectedInstances.map(instanceId => {
    const instance = inventory.get(instanceId);
    if (!identifier(instanceId) || !instance || instance.ownerId !== userId || instance.commanderId !== commanderId) {
      throw new ApiError(409, 'unit_not_owned');
    }
    const unit = units.get(instance.itemId);
    if (!unit) throw new ApiError(409, 'invalid_loadout_unit');
    if (unit.faction !== commander.faction) throw new ApiError(409, 'loadout_faction_mismatch');
    // The bundled catalog's tier is the immutable native tree identity. Queue
    // and battle contracts expose the sandbox combat tier instead.
    return {
      instanceId, itemId: unit.id, key: unit.key, faction: unit.faction,
      tier: SANDBOX_EFFECTIVE_UNIT_TIER,
    };
  });
  return { commanderId, faction: commander.faction, units: resolved, maxTier: Math.max(...resolved.map(unit => unit.tier)) };
}

/** Pure server-authoritative bootstrap boundary for a newly created account.
 * The generated catalog, rather than an HTTP body, owns the entitlement list.
 */
export function initialOwnedInventory(userId: string, commanderId: string): InitialOwnedInventory {
  const commander = commanders.get(commanderId);
  if (!identifier(userId) || !commander) throw new ApiError(409, 'invalid_loadout_commander');
  const selectableUnitIds = initialAccountUnitIds.filter(itemId => units.get(itemId)?.faction === commander.faction);
  return {
    ownerId: userId,
    commanderId,
    faction: commander.faction,
    accountUnitIds: [...initialAccountUnitIds],
    selectableUnitIds,
    // Stable slot IDs let all three slots equip the same unlocked unit type.
    slotInstanceIds: Array.from({ length: native.accountPolicy.deploymentSlots },
      (_unused, slot) => `starter:${commander.id}:${slot}`),
  };
}

/** Resolve a trusted server-side 3-unit selection against initial ownership.
 * This is intentionally not wired to an HTTP field. A future persisted inventory
 * can call this boundary after reading the selection from trusted storage.
 */
export function resolveInitialOwnedSelection(
  userId: string, commanderId: string, selectedUnitIds: readonly string[],
): VerifiedLoadout {
  const inventory = initialOwnedInventory(userId, commanderId);
  if (!Array.isArray(selectedUnitIds) || selectedUnitIds.length !== inventory.slotInstanceIds.length ||
      inventory.slotInstanceIds.length !== 3) throw new ApiError(409, 'invalid_loadout_size');
  const selectable = new Set(inventory.selectableUnitIds);
  const owned = selectedUnitIds.map((itemId, slot) => {
    if (typeof itemId !== 'string' || !initialAccountUnits.has(itemId) || !selectable.has(itemId)) {
      throw new ApiError(409, 'unit_not_owned');
    }
    return { instanceId: inventory.slotInstanceIds[slot], ownerId: userId, commanderId, itemId };
  });
  return resolveOwnedLoadout(userId, commanderId, owned, owned.map(unit => unit.instanceId));
}

/** Default new-account deployment: choose the native Tier-V identity from each
 * starter branch, then expose it as sandbox Tier X through resolveOwnedLoadout.
 * The legacy name is kept for Room/queue snapshots.
 */
export function starterLoadout(userId: string, commanderId: string): VerifiedLoadout {
  const commander = commanders.get(commanderId);
  if (!commander) throw new ApiError(409, 'commander_selection_required');
  return resolveInitialOwnedSelection(userId, commanderId, commander.initialLoadoutUnitIds);
}

export function sameLoadout(left: VerifiedLoadout | undefined, right: VerifiedLoadout): boolean {
  return left?.commanderId === right.commanderId && left.faction === right.faction && left.maxTier === right.maxTier &&
    left.units.length === right.units.length && left.units.every((unit, slot) => {
      const other = right.units[slot];
      return unit.instanceId === other.instanceId && unit.itemId === other.itemId && unit.key === other.key &&
        unit.faction === other.faction && unit.tier === other.tier;
    });
}

/** Called only at prepare with validated loadouts, never on CPU takeover/reconnect. */
export function opponentTier(mode: 'pvp' | 'pve', loadouts: readonly VerifiedLoadout[]): number | null {
  if (mode !== 'pvp' && mode !== 'pve') throw new ApiError(409, 'invalid_mode');
  if (loadouts.length < 1 || loadouts.length > (mode === 'pve' ? 10 : 20)) throw new ApiError(409, 'invalid_roster_size');
  const tiers = loadouts.flatMap(loadout => {
    const commander = commanders.get(loadout.commanderId);
    if (!commander || loadout.units.length !== 3 || new Set(loadout.units.map(unit => unit.instanceId)).size !== 3) {
      throw new ApiError(409, 'invalid_loadout_size');
    }
    return loadout.units.map(deployed => {
      const unit = units.get(deployed.itemId);
      if (!unit) throw new ApiError(409, 'invalid_loadout_unit');
      if (unit.faction !== commander.faction) throw new ApiError(409, 'loadout_faction_mismatch');
      return SANDBOX_EFFECTIVE_UNIT_TIER;
    });
  });
  return mode === 'pvp' ? null : Math.max(...tiers);
}
