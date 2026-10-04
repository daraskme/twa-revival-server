/**
 * Relay admission tickets issued by the control plane at battle claim time.
 *
 * Format (exact):
 *   base64url(JSON.stringify({battleId,userId,seat,playerId,team,exp}))
 *   + "." + base64url(HMAC-SHA256(secret, firstPart))
 *
 * `exp` is a Unix timestamp in milliseconds. The secret is the Worker binding
 * RELAY_TICKET_SECRET (a string; its UTF-8 bytes are the HMAC key). The
 * signature is checked with WebCrypto `subtle.verify`, which compares MACs in
 * constant time, before the JSON is parsed or any field is trusted.
 */

export class TicketError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'TicketError';
  }
}

export interface RelayTicket {
  battleId: string;
  userId: string;
  seat: number;
  playerId: number;
  team: number;
  exp: number;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** GAME_JOIN identity slot is 37 bytes including NUL: printable ASCII, 1..36 chars. */
const WIRE_ID = /^[\x20-\x7e]{1,36}$/;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
export const MAX_TICKET_LENGTH = 2048;
export const MAX_TICKET_SEATS = 20;

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  if (typeof text !== 'string' || text.length === 0 || !BASE64URL.test(text)) throw new TicketError('ticket_encoding');
  const padded = text.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  if (remainder === 1) throw new TicketError('ticket_encoding');
  let binary: string;
  try { binary = atob(padded + '='.repeat(remainder ? 4 - remainder : 0)); } catch { throw new TicketError('ticket_encoding'); }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 16) throw new TicketError('ticket_secret_missing');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Issue a ticket. Only tests and the control plane use this; the relay never signs. */
export async function signRelayTicket(claims: RelayTicket, secret: string): Promise<string> {
  const first = base64UrlEncode(encoder.encode(JSON.stringify({
    battleId: claims.battleId, userId: claims.userId, seat: claims.seat,
    playerId: claims.playerId, team: claims.team, exp: claims.exp,
  })));
  const key = await hmacKey(secret, 'sign');
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(first)));
  return first + '.' + base64UrlEncode(mac);
}

function claimsFrom(value: unknown): RelayTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TicketError('ticket_claims');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'battleId,exp,playerId,seat,team,userId') throw new TicketError('ticket_claims');
  const { battleId, userId, seat, playerId, team, exp } = record;
  if (typeof battleId !== 'string' || !CANONICAL_UUID.test(battleId)) throw new TicketError('ticket_battle_id');
  if (typeof userId !== 'string' || !WIRE_ID.test(userId)) throw new TicketError('ticket_user_id');
  if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) >= MAX_TICKET_SEATS) throw new TicketError('ticket_seat');
  if (!Number.isInteger(playerId) || (playerId as number) < 1 || (playerId as number) > MAX_TICKET_SEATS) throw new TicketError('ticket_player_id');
  if (!Number.isInteger(team) || (team as number) < 0 || (team as number) >= MAX_TICKET_SEATS) throw new TicketError('ticket_team');
  if (!Number.isSafeInteger(exp) || (exp as number) <= 0) throw new TicketError('ticket_exp');
  return { battleId, userId, seat: seat as number, playerId: playerId as number, team: team as number, exp: exp as number };
}

/**
 * Verify signature first (constant time), then expiry, then claim shape.
 * Errors: ticket_format, ticket_encoding, ticket_signature, ticket_expired,
 * ticket_claims, ticket_battle_id, ticket_user_id, ticket_seat,
 * ticket_player_id, ticket_team, ticket_exp, ticket_secret_missing.
 */
export async function verifyRelayTicket(ticket: unknown, secret: string, nowMs: number): Promise<RelayTicket> {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_TICKET_LENGTH) throw new TicketError('ticket_format');
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TicketError('ticket_format');
  const [first, signature] = parts;
  const mac = base64UrlDecode(signature);
  if (mac.byteLength !== 32) throw new TicketError('ticket_signature');
  const key = await hmacKey(secret, 'verify');
  if (!(await crypto.subtle.verify('HMAC', key, mac, encoder.encode(first)))) throw new TicketError('ticket_signature');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(first))); } catch { throw new TicketError('ticket_claims'); }
  const claims = claimsFrom(parsed);
  if (!Number.isFinite(nowMs) || claims.exp <= nowMs) throw new TicketError('ticket_expired');
  return claims;
}
