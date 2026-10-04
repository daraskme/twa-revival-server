import type { Social } from './social';
import type { Room } from './room';
import type { Matchmaker } from './matchmaking';
import type { BattleRelay } from './relay/durable-object';
import type { VerifiedLoadout } from './loadouts';
import type { NativePvpTestEnv } from './native-pvp-test';
import type { CapuaReservationEnv } from './native-pvp-capua-reservation';
import type { RegistrationEnv } from './registration';
import type { NativeReleaseEnv } from './native-release';

export interface Env extends NativePvpTestEnv, CapuaReservationEnv, RegistrationEnv, NativeReleaseEnv {
  DB: D1Database;
  SOCIAL: DurableObjectNamespace<Social>;
  ROOMS: DurableObjectNamespace<Room>;
  MATCHMAKER: DurableObjectNamespace<Matchmaker>;
  // PvP command relay: one Durable Object per battle, named by the battle id.
  BATTLE_RELAY: DurableObjectNamespace<BattleRelay>;
  // Operational control plane: maintenance, announcements, minimum client version.
  CONTROL: KVNamespace;
  // Signed client update manifests and their content objects.
  PATCHES: R2Bucket;
  API_LIMITER: RateLimit;
  AUTH_LIMITER: RateLimit;
  EDGE_LIMITER: RateLimit;
  ADMIN_LIMITER: RateLimit;
  UPDATE_LIMITER: RateLimit;
  EOS_PRODUCT_ID: string;
  EOS_SANDBOX_ID: string;
  EOS_DEPLOYMENT_ID: string;
  EOS_ALLOWED_CLIENT_IDS: string;
  EOS_EXPECTED_ISSUER: string;
  EOS_ALLOWED_EXTERNAL_TYPES: string;
  // Secrets. Absent or placeholder values fail the dependent route closed.
  ADMIN_TOKEN?: string;
  RELAY_TICKET_SECRET?: string;
  // Vars arrive as strings; see src/battles.ts for parsing and defaults.
  REWARD_CAP_SILVER?: string;
  REWARD_CAP_FREE_XP?: string;
  REWARD_CAP_COMMANDER_XP?: string;
  REWARD_CAP_UNIT_XP?: string;
}

// TWA uint64 IDs must remain decimal strings: JS numbers lose precision.
export interface Actor {
  id: string;
  displayName: string;
  commanderId: string | null;
  faction: string | null;
  // Derived by the server; never accepted from a request body or trusted by Room.
  loadout?: VerifiedLoadout | null;
}

export interface ConnectIdentity {
  productUserId: string;
  expiresAt: number;
}

export type IdentityVerifier = (token: string, env: Env) => Promise<ConnectIdentity>;
