/**
 * Byte-exact TypeScript port of the CAReconn / CA command-relay framing that
 * server/native_relay_probe.py and server/native_battle_probe.py proved on the
 * real client (2026-09-01 run8: CAReconn -> VERSION 27 -> GAME_JOIN ->
 * GAME_CONFIRM -> JOIN_PAYLOADS -> READY -> ticks -> MVP/results).
 *
 * Wire layers, innermost first:
 *   inner packet : <u8 kind><u16le total><payload>, 3 <= total <= 4096
 *   outer chunk  : <u16le length><stream bytes>, length 0 is a CAReconn ACK
 *                  credit for one complete 1000-byte block of the peer stream
 *   greeting     : 40 bytes "CAReconn01\0" + flags (client -> server), then a
 *                  17-byte reply (server -> client)
 *
 * Nothing here decrypts, rewrites, or logs opaque payload bytes. Errors carry
 * constant reason codes only (never packet contents), mirroring the Python
 * *Error classes so log lines stay comparable across both implementations.
 */

export class FramingError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'FramingError';
  }
}

const EMPTY = new Uint8Array(0);
const ASCII = new TextEncoder();

/** "CAReconn01\0" — the first 11 bytes of the native 40-byte greeting (FO C56B30). */
export const GREETING_MAGIC = ASCII.encode('CAReconn01\0');
export const GREETING_BYTES = 40;
export const GREETING_REPLY_BYTES = 17;
/** Native protocol version accepted by game.dll (BCC760/B80F8F). */
export const VERSION = 27;
/** GAME_JOIN is exactly 105 bytes (BF2E30/B46F0B). */
export const GAME_JOIN_BYTES = 105;
export const MAX_INNER_BYTES = 4096;
/** Entire client JOIN_PAYLOAD packet limit (BF2D98 buffer). */
export const MAX_JOIN_PAYLOAD_BYTES = 2048;
/** Largest outer chunk this relay accepts or emits (BCC110 accepts kind 2 up to 0x4000). */
export const MAX_CHUNK_BYTES = 16384;
/** Hard u16 bound of the outer chunk header itself. */
export const MAX_OUTER_CHUNK_BYTES = 65535;
/** CAReconn acknowledges each complete 1000-byte block of the peer stream. */
export const CA_RECONN_ACK_BLOCK_BYTES = 1000;
/** The 2-byte zero-length outer chunk which carries one ACK credit. */
export const ACK_CHUNK: Uint8Array = Uint8Array.of(0, 0);
/** Native GAME_JOIN[89] roster count range accepted by this lab. */
export const MAX_ROSTER_PLAYERS = 20;

// ---------------------------------------------------------------------------
// Small byte helpers (kept local so the relay stays dependency-free).
// ---------------------------------------------------------------------------

export function concat(...parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function u32le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new FramingError('invalid_u32');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function u16le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new FramingError('invalid_u16');
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

export function u64le(value: number | bigint): Uint8Array {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n || big > 0xffff_ffff_ffff_ffffn) throw new FramingError('invalid_u64');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, big, true);
  return out;
}

export function ascii(text: string): Uint8Array { return ASCII.encode(text); }

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2 || /[^0-9a-fA-F]/.test(clean)) throw new FramingError('invalid_hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

// ---------------------------------------------------------------------------
// Inner packets
// ---------------------------------------------------------------------------

/** Port of native_relay_probe.inner_packet: <u8 kind><u16le total><payload>. */
export function innerPacket(kind: number, payload: Uint8Array = EMPTY): Uint8Array {
  if (!Number.isInteger(kind) || kind < 0 || kind > 255 || payload.byteLength + 3 > MAX_INNER_BYTES) {
    throw new FramingError('invalid_inner_packet');
  }
  const out = new Uint8Array(payload.byteLength + 3);
  out[0] = kind;
  view(out).setUint16(1, payload.byteLength + 3, true);
  out.set(payload, 3);
  return out;
}

export interface InnerHeader { kind: number; total: number }

/** Read a kind/total header; null when fewer than 3 bytes are available. */
export function readInnerHeader(bytes: Uint8Array, offset = 0): InnerHeader | null {
  if (bytes.byteLength - offset < 3) return null;
  return { kind: bytes[offset], total: view(bytes).getUint16(offset + 1, true) };
}

/**
 * Reassembles inner packets from client stream bytes which may be split or
 * coalesced arbitrarily across outer chunks (proved by
 * test_fragmented_tcp_headers_and_inner_message_across_outer_chunks).
 * Declared totals outside 3..4096 fail closed with 'inner_length'.
 */
export class InnerPacketBuffer {
  private pending: Uint8Array = EMPTY;

  get pendingBytes(): number { return this.pending.byteLength; }

  checkpoint(): Uint8Array { return this.pending.slice(); }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.pending = this.pending.byteLength ? concat(this.pending, bytes) : bytes.slice();
  }

  /** Returns the next complete packet, or null when more bytes are needed. */
  next(): Uint8Array | null {
    const packet = this.peek();
    if (packet) this.pending = this.pending.slice(packet.byteLength);
    return packet;
  }

  /** Inspect without consuming: a full command queue must retain the packet. */
  peek(): Uint8Array | null {
    const header = readInnerHeader(this.pending);
    if (!header) return null;
    if (header.total < 3 || header.total > MAX_INNER_BYTES) throw new FramingError('inner_length');
    if (this.pending.byteLength < header.total) return null;
    return this.pending.slice(0, header.total);
  }

  /** Unaccepted tail will be replayed from the committed client stream offset. */
  retainPrefix(bytes: number): void { this.pending = this.pending.slice(0, bytes); }

  clear(): void { this.pending = EMPTY; }
}

// ---------------------------------------------------------------------------
// Outer chunks
// ---------------------------------------------------------------------------

/** Port of native_relay_probe.stream_chunk: <u16le length><payload>, 1..65535 bytes. */
export function streamChunk(payload: Uint8Array): Uint8Array {
  if (payload.byteLength === 0 || payload.byteLength > MAX_OUTER_CHUNK_BYTES) throw new FramingError('invalid_stream_chunk');
  return concat(u16le(payload.byteLength), payload);
}

/**
 * Validate that one binary WebSocket frame from the companion bridge is
 * exactly one outer chunk (header + payload). Returns the payload; an empty
 * payload is the CAReconn ACK credit. Larger than 16384 fails closed just like
 * native_battle_probe.read_outer_chunk.
 */
export function parseOuterChunkFrame(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < 2) throw new FramingError('outer_chunk_frame');
  const size = view(frame).getUint16(0, true);
  if (size > MAX_CHUNK_BYTES) throw new FramingError('outer_chunk_too_large');
  if (frame.byteLength !== size + 2) throw new FramingError('outer_chunk_frame');
  return frame.slice(2);
}

/**
 * Splits a raw TCP byte stream into outer chunk payloads (empty = ACK). Used
 * by tests to model what the Python bridge does on the game side.
 */
export class OuterChunkReader {
  private pending: Uint8Array = EMPTY;

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.pending = this.pending.byteLength ? concat(this.pending, bytes) : bytes.slice();
  }

  next(): Uint8Array | null {
    if (this.pending.byteLength < 2) return null;
    const size = view(this.pending).getUint16(0, true);
    if (size > MAX_CHUNK_BYTES) throw new FramingError('outer_chunk_too_large');
    if (this.pending.byteLength < size + 2) return null;
    const payload = this.pending.slice(2, 2 + size);
    this.pending = this.pending.slice(2 + size);
    return payload;
  }
}

// ---------------------------------------------------------------------------
// CAReconn greeting (client -> server, 40 bytes) and reply (server -> client, 17 bytes)
// ---------------------------------------------------------------------------

export interface Greeting {
  reconnect: boolean;
  /** Bytes 12..28: caller parameters (8) + random session (8). Opaque; compared, never logged. */
  identity: Uint8Array;
  attempt: number;
  receivedOffset: number;
}

export function parseGreeting(bytes: Uint8Array): Greeting {
  if (bytes.byteLength !== GREETING_BYTES) throw new FramingError('greeting_length');
  if (!equalBytes(bytes.subarray(0, GREETING_MAGIC.byteLength), GREETING_MAGIC)) throw new FramingError('greeting_magic');
  const dv = view(bytes);
  const offset = dv.getBigUint64(32, true);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) throw new FramingError('greeting_offset');
  return {
    reconnect: bytes[11] !== 0,
    identity: bytes.slice(12, 28),
    attempt: dv.getUint32(28, true),
    receivedOffset: Number(offset),
  };
}

/**
 * 17-byte greeting reply. Fresh sessions send all zeros. A CAReconn resume
 * acknowledges every client-stream byte retained by the relay at offset 1 and
 * keeps the initial value 0 at offset 9 (native_battle_probe._handle_with_resume).
 * Each following ACK credits 1000 bytes from that exact offset, including its
 * partial block; the native send window cannot accept an ACK beyond bytes sent.
 */
export function greetingReply(clientStreamBytes = 0): Uint8Array {
  if (!Number.isSafeInteger(clientStreamBytes) || clientStreamBytes < 0) throw new FramingError('invalid_client_offset');
  return concat(Uint8Array.of(0), u64le(clientStreamBytes), u64le(0));
}

// ---------------------------------------------------------------------------
// GAME_JOIN (kind 0, 105 bytes; BF2E30)
// ---------------------------------------------------------------------------

const CANONICAL_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export interface GameJoin {
  version: number;
  /** Canonical lowercase UUID text, or null when the slot is not one. */
  battleId: string | null;
  battleKey: bigint;
  /** Printable-ASCII NUL-terminated identity with zero padding, or null. */
  identity: string | null;
  expectedPlayers: number;
  normalParameter: number;
  casaLoopback: boolean;
  casaPort: number;
  carpgLoopback: boolean;
  carpgPort: number;
}

function isLoopback(bytes: Uint8Array): boolean { return bytes[0] === 127; }

function nulSlot(slot: Uint8Array): { end: number; zeroPadding: boolean; printable: boolean } {
  const end = slot.indexOf(0);
  const value = end === -1 ? slot : slot.subarray(0, end);
  let printable = true;
  for (const byte of value) if (byte < 32 || byte > 126) { printable = false; break; }
  let zeroPadding = end !== -1;
  if (zeroPadding) for (let i = end; i < slot.byteLength; i++) if (slot[i]) { zeroPadding = false; break; }
  return { end, zeroPadding, printable };
}

/** Strict framing parse (packet_length / message_kind / declared_length), then structured fields. */
export function parseGameJoin(packet: Uint8Array): GameJoin {
  if (packet.byteLength !== GAME_JOIN_BYTES) throw new FramingError('packet_length');
  const dv = view(packet);
  if (packet[0] !== 0) throw new FramingError('message_kind');
  if (dv.getUint16(1, true) !== GAME_JOIN_BYTES) throw new FramingError('declared_length');
  const gameId = packet.subarray(7, 44);
  const gameIdText = new TextDecoder('ascii').decode(gameId.subarray(0, 36));
  const canonical = gameId[36] === 0 && CANONICAL_UUID.test(gameIdText);
  const identitySlot = packet.subarray(52, 89);
  const identity = nulSlot(identitySlot);
  const identityValid = identity.end > 0 && identity.zeroPadding && identity.printable;
  return {
    version: dv.getUint32(3, true),
    battleId: canonical ? gameIdText : null,
    battleKey: dv.getBigUint64(44, true),
    identity: identityValid ? new TextDecoder('ascii').decode(identitySlot.subarray(0, identity.end)) : null,
    expectedPlayers: packet[89],
    normalParameter: dv.getUint16(90, true),
    casaLoopback: isLoopback(packet.subarray(92, 96)),
    casaPort: dv.getUint16(96, true),
    carpgLoopback: isLoopback(packet.subarray(98, 102)),
    carpgPort: dv.getUint16(102, true),
  };
}

/**
 * Port of native_relay_probe.game_join_metadata: redacted boolean/int flags for
 * logs. No value from either opaque slot is returned.
 */
export function gameJoinMetadata(packet: Uint8Array): Record<string, boolean | number> {
  const join = parseGameJoin(packet);
  const gameId = packet.subarray(7, 44);
  const secondary = packet.subarray(52, 89);
  const textFlags = (slot: Uint8Array, prefix: string): Record<string, boolean | number> => {
    const end = slot.indexOf(0);
    const value = end === -1 ? slot : slot.subarray(0, end);
    let asciiOnly = true, printable = true;
    for (const byte of value) { if (byte >= 128) asciiOnly = false; if (byte < 32 || byte > 126) printable = false; }
    let zeroPadding = end !== -1;
    if (zeroPadding) for (let i = end; i < slot.byteLength; i++) if (slot[i]) { zeroPadding = false; break; }
    return {
      [prefix + '_bytes']: value.byteLength,
      [prefix + '_nul_terminated']: end !== -1,
      [prefix + '_ascii']: asciiOnly,
      [prefix + '_printable_ascii']: printable,
      [prefix + '_zero_padding']: zeroPadding,
    };
  };
  const end = secondary.indexOf(0);
  const candidate = end === -1 ? EMPTY : secondary.subarray(0, end);
  let decimal = candidate.byteLength > 0;
  for (const byte of candidate) if (byte < 48 || byte > 57) { decimal = false; break; }
  if (decimal) decimal = BigInt(new TextDecoder('ascii').decode(candidate)) <= 0xffff_ffff_ffff_ffffn;
  return {
    framing_valid: true,
    protocol_version_supported: join.version === VERSION,
    ...textFlags(gameId, 'game_id'),
    game_id_canonical_uuid: join.battleId !== null,
    opaque_identity_bytes: 8,
    ...textFlags(secondary, 'secondary_text'),
    secondary_text_decimal_uint64: decimal,
    expected_players: join.expectedPlayers,
    expected_players_in_lab_range: join.expectedPlayers >= 1 && join.expectedPlayers <= MAX_ROSTER_PLAYERS,
    normal_parameter_200: join.normalParameter === 200,
    casa_ipv4_loopback: join.casaLoopback,
    casa_port_nonzero: join.casaPort !== 0,
    carpg_ipv4_loopback: join.carpgLoopback,
    carpg_port_nonzero: join.carpgPort !== 0,
    credentials_verified: false,
    game_confirm_sent: false,
    gameplay_supported: false,
  };
}

// ---------------------------------------------------------------------------
// JOIN_PAYLOAD (client kind 1) -> JOIN_PAYLOADS (server kind 2; BCC110)
// ---------------------------------------------------------------------------

/**
 * Port of native_battle_probe.encode_join_payloads. Each opaque client
 * payload stays encrypted with a seed including its GAME_CONFIRM player id; the
 * relay validates framing only. Entries are emitted in ascending player id so
 * every client sees one canonical roster regardless of arrival order.
 */
export function encodeJoinPayloads(entries: Array<[number, Uint8Array]>): Uint8Array {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ROSTER_PLAYERS) throw new FramingError('join_payloads_count');
  const seen = new Set<number>();
  const validated: Array<{ playerId: number; packet: Uint8Array; payloadSize: number }> = [];
  for (const [playerId, packet] of entries) {
    if (!Number.isInteger(playerId) || playerId < 1 || playerId > MAX_ROSTER_PLAYERS) throw new FramingError('join_payload_player_id');
    if (seen.has(playerId)) throw new FramingError('join_payload_player_id_duplicate');
    seen.add(playerId);
    if (!(packet instanceof Uint8Array) || packet.byteLength < 9 || packet.byteLength > MAX_JOIN_PAYLOAD_BYTES) throw new FramingError('payload_packet_length');
    const dv = view(packet);
    if (packet[0] !== 1 || dv.getUint16(1, true) !== packet.byteLength) throw new FramingError('payload_framing');
    const payloadSize = dv.getUint32(3, true);
    if (payloadSize !== packet.byteLength - 7 || packet[7] !== 1) throw new FramingError('payload_declared_size_or_flag');
    validated.push({ playerId, packet, payloadSize });
  }
  validated.sort((a, b) => a.playerId - b.playerId);
  const parts: Uint8Array[] = [u32le(validated.length)];
  for (const entry of validated) parts.push(u32le(entry.playerId), u32le(entry.payloadSize), entry.packet.subarray(7));
  const body = concat(...parts);
  const total = body.byteLength + 3;
  if (total > MAX_CHUNK_BYTES) throw new FramingError('join_payloads_packet_too_large');
  const out = new Uint8Array(total);
  out[0] = 2;
  view(out).setUint16(1, total, true);
  out.set(body, 3);
  return out;
}

// ---------------------------------------------------------------------------
// READY_FOR_TICKING (client kind 5; BF2FF0)
// ---------------------------------------------------------------------------

/**
 * Port of native_battle_probe.validate_ready_packet. The body is the native
 * UTF-16-code-unit UTF/CESU-8 encoding of a private string without terminator:
 * 1..3 bytes per code unit, lone surrogates allowed, NUL and code points above
 * U+FFFF (4-byte sequences) rejected, overlong forms rejected.
 */
export function validateReadyPacket(packet: Uint8Array): void {
  if (!(packet instanceof Uint8Array) || packet.byteLength < 3 || packet.byteLength > MAX_INNER_BYTES) throw new FramingError('ready_packet_length');
  if (packet[0] !== 5 || view(packet).getUint16(1, true) !== packet.byteLength) throw new FramingError('ready_framing');
  const body = packet.subarray(3);
  let i = 0;
  while (i < body.byteLength) {
    const lead = body[i];
    if (lead === 0) throw new FramingError('ready_string_encoding');
    if (lead < 0x80) { i += 1; continue; }
    let need: number;
    if (lead >= 0xc2 && lead <= 0xdf) need = 1;
    else if (lead >= 0xe0 && lead <= 0xef) need = 2;
    else throw new FramingError('ready_string_encoding'); // 0x80..0xC1 invalid lead, 0xF0+ exceeds U+FFFF
    if (i + need >= body.byteLength) throw new FramingError('ready_string_encoding');
    for (let k = 1; k <= need; k++) if ((body[i + k] & 0xc0) !== 0x80) throw new FramingError('ready_string_encoding');
    if (lead === 0xe0 && body[i + 1] < 0xa0) throw new FramingError('ready_string_encoding'); // overlong 3-byte
    i += need + 1;
  }
}

// ---------------------------------------------------------------------------
// Server -> client relay message builders (all proven on the wire or parser-verified)
// ---------------------------------------------------------------------------

/** kind 13 VERSION(<u32 27>) — first server stream bytes after the 17-byte reply. */
export function versionPacket(): Uint8Array { return innerPacket(13, u32le(VERSION)); }
/** kind 0 GAME_CONFIRM(<u32 player_id>) (BCC090). */
export function gameConfirmPacket(playerId: number): Uint8Array { return innerPacket(0, u32le(playerId)); }
/** kind 8 PLAYER_FINISHED_LOADING(<u32 player_id>) (BCC400). */
export function playerFinishedLoadingPacket(playerId: number): Uint8Array { return innerPacket(8, u32le(playerId)); }
/** kind 3 GAME_TICKING (BCC330). */
export function gameTickingPacket(): Uint8Array { return innerPacket(3); }
/** kind 4 command echo: <u8 player_id> + opaque cipher, one implicit tick per packet. */
export function commandEchoPacket(playerId: number, cipher: Uint8Array): Uint8Array {
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > 255) throw new FramingError('invalid_player_id');
  return innerPacket(4, concat(Uint8Array.of(playerId), cipher));
}

/** Native BF2CD0 sends kind 6: u32 recipient mask, u8 channel, opaque data.
 * BCC680 reads server kind 10: u8 authenticated sender, u8 channel, data.
 * This channel is independent of the lockstep command/tick stream. */
export function parseUntickedPacket(packet: Uint8Array): { recipients: number; channel: number; data: Uint8Array } {
  // The sender bounds its five-byte routing header plus data to 4000 bytes.
  if (packet.byteLength < 8 || packet.byteLength > 4003) throw new FramingError('unticked_packet_length');
  if (packet[0] !== 6 || view(packet).getUint16(1, true) !== packet.byteLength) throw new FramingError('unticked_framing');
  return { recipients: view(packet).getUint32(3, true), channel: packet[7], data: packet.slice(8) };
}

export function untickedPacket(playerId: number, channel: number, data: Uint8Array): Uint8Array {
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > MAX_ROSTER_PLAYERS ||
      !Number.isInteger(channel) || channel < 0 || channel > 255 || data.byteLength > 3995) {
    throw new FramingError('unticked_packet_length');
  }
  return innerPacket(10, concat(Uint8Array.of(playerId, channel), data));
}
/** kind 5 empty-tick bitmask of players without a command (1 << player_id). Multi-seat semantics UNVERIFIED on the real game. */
export function emptyTickMaskPacket(mask: number): Uint8Array { return innerPacket(5, u32le(mask)); }
/** kind 11 PLAYER_TEMPORARILY_DISCONNECTED(<u32 player_id>) — parser shape verified in game.dll, effect on AI control UNVERIFIED. */
export function playerTemporarilyDisconnectedPacket(playerId: number): Uint8Array { return innerPacket(11, u32le(playerId)); }
/** kind 12 PLAYER_RECONNECTED(<u32 player_id>) — parser shape verified in game.dll. */
export function playerReconnectedPacket(playerId: number): Uint8Array { return innerPacket(12, u32le(playerId)); }
