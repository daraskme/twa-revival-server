/**
 * RelayCore: pure, clock-free, socket-free CA command-relay state machine for
 * one frozen battle roster (1..20 seats). Ported from
 * server/native_pvp_relay_core.py TwoPlayerRelayCore, the GAME_JOIN
 * authorization of native_pvp_adapter_contract.PreparedPvpAllocation and the
 * per-packet dispatch of native_battle_probe.NativeBattleProbe.
 *
 * Callers (BattleRelaySession) feed validated connection events and complete
 * inner packets; the core returns RelayEmissions (logical server-stream
 * appends for listed player ids) which the caller must append to each target
 * seat's retained stream even while that seat is detached.
 *
 * Fail-closed rules carried over from the proven one-player relay:
 *   - client kind 6 routes immediate messages only within the frozen roster
 *   - client kind 7 checksums are counted, never compared
 *   - the kind 5 empty-tick bitmask (1 << player_id) is emitted exactly as the
 *     one-player lab did; its meaning for >= 2 seats is UNVERIFIED on the game
 *   - a seat lost before GAME_TICKING ends the battle (roster_incomplete):
 *     JOIN_PAYLOADS with fewer entries than GAME_JOIN's count is untested
 *
 * Deviation from the Python two-seat model (documented in the report): kind 11
 * PLAYER_TEMPORARILY_DISCONNECTED and kind 12 PLAYER_RECONNECTED go to the
 * OTHER seats only. The resuming client therefore replays pure ticks, which is
 * the exact stream shape proven by the one-player CAReconn lab.
 */
import {
  FramingError, GAME_JOIN_BYTES, MAX_INNER_BYTES, MAX_ROSTER_PLAYERS, VERSION,
  commandEchoPacket, emptyTickMaskPacket, encodeJoinPayloads, gameConfirmPacket, gameJoinMetadata,
  gameTickingPacket, parseGameJoin, playerFinishedLoadingPacket, playerReconnectedPacket,
  playerTemporarilyDisconnectedPacket, readInnerHeader, validateReadyPacket, versionPacket,
  parseUntickedPacket, untickedPacket,
} from './framing';

export const MAX_PENDING_COMMANDS = 32;
export const MAX_PENDING_CIPHERTEXT_BYTES = 4096;
/** kind + u16 length + player-id byte leave 4092 cipher bytes in a 4096-byte echo. */
export const MAX_COMMAND_CIPHERTEXT_BYTES = 4092;
export const MAX_SEATS = MAX_ROSTER_PLAYERS;

export class RelayCoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'RelayCoreError';
  }
}

export interface RelaySeatSpec {
  seat: number;
  userId: string;
  playerId: number;
  team: number;
}

export interface RelayManifest {
  battleId: string;
  /** Private custom-lobby UUID placed in GAME_JOIN; omitted for public battles. */
  wireBattleId?: string;
  /** Canonical lowercase hex, no leading zeros, 1..16 digits; the native uint64 battle key. */
  battleKeyHex: string;
  /** GAME_JOIN[89]: the wire roster count the clients were told (may exceed human seats, e.g. CPU rows). */
  expectedPlayers: number;
  seats: RelaySeatSpec[];
}

export interface RelayEmission {
  event: string;
  playerIds: number[];
  packet: Uint8Array;
  tick: number | null;
}

export type RelayNote = { event: string } & Record<string, number | string | boolean>;

export interface RelayResult {
  emissions: RelayEmission[];
  notes: RelayNote[];
}

export type SeatTransport = 'detached' | 'connected' | 'resuming' | 'abandoned';
export type RelayPhase = 'joining' | 'loading' | 'ticking' | 'ended';

export interface RelaySeatView {
  seat: number;
  userId: string;
  playerId: number;
  team: number;
  connectionId: string | null;
  transport: SeatTransport;
  epoch: number;
  joined: boolean;
  payloadReceived: boolean;
  ready: boolean;
}

interface Seat extends RelaySeatView {
  payload: Uint8Array | null;
}

/** Private durable state. Never return this from the public/status surface. */
export interface RelayCoreCheckpoint {
  version: 1;
  phase: RelayPhase;
  tick: number;
  sequence: number;
  commands: Array<{ sequence: number; playerId: number; cipher: Uint8Array }>;
  endReason: string | null;
  seats: Seat[];
  usedConnections: string[];
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_HEX = /^[1-9a-f][0-9a-f]{0,15}$/;
const WIRE_ID = /^[\x20-\x7e]{1,36}$/;
const CONNECTION_ID = /^[\x20-\x7e]{1,128}$/;

function identifier(value: unknown, field: string, nativeIdentity = false): string {
  if (typeof value !== 'string' || !(nativeIdentity ? WIRE_ID : CONNECTION_ID).test(value)) throw new RelayCoreError('invalid_' + field);
  return value;
}

/** Validate an untrusted manifest object (control-plane PUT /manifest) into a frozen RelayManifest. */
export function parseRelayManifest(value: unknown): RelayManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RelayCoreError('invalid_manifest');
  const record = value as Record<string, unknown>;
  const allowed = new Set(['battleId', 'wireBattleId', 'battleKeyHex', 'expectedPlayers', 'seats']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new RelayCoreError('invalid_manifest');
  const { battleId, battleKeyHex, expectedPlayers, seats } = record;
  if (typeof battleId !== 'string' || !CANONICAL_UUID.test(battleId)) throw new RelayCoreError('invalid_manifest_battle_id');
  const wireBattleId = record.wireBattleId;
  if (wireBattleId !== undefined && (typeof wireBattleId !== 'string' || !CANONICAL_UUID.test(wireBattleId))) {
    throw new RelayCoreError('invalid_manifest_wire_battle_id');
  }
  if (typeof battleKeyHex !== 'string' || !CANONICAL_HEX.test(battleKeyHex)) throw new RelayCoreError('invalid_manifest_battle_key');
  if (!Array.isArray(seats) || seats.length < 1 || seats.length > MAX_SEATS) throw new RelayCoreError('invalid_roster');
  if (!Number.isInteger(expectedPlayers) || (expectedPlayers as number) < seats.length || (expectedPlayers as number) > MAX_SEATS) {
    throw new RelayCoreError('invalid_manifest_expected_players');
  }
  const users = new Set<string>();
  const frozen: RelaySeatSpec[] = seats.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RelayCoreError('invalid_roster');
    const row = entry as Record<string, unknown>;
    for (const key of Object.keys(row)) if (!['seat', 'userId', 'playerId', 'team'].includes(key)) throw new RelayCoreError('invalid_roster');
    const userId = identifier(row.userId, 'native_user_id', true);
    if (users.has(userId)) throw new RelayCoreError('duplicate_roster_identity');
    users.add(userId);
    // Player ids follow the immutable roster order, never TCP arrival order.
    if (row.seat !== index || row.playerId !== index + 1) throw new RelayCoreError('invalid_roster_player_id');
    if (!Number.isInteger(row.team) || (row.team as number) < 0 || (row.team as number) >= MAX_SEATS) throw new RelayCoreError('invalid_roster_team');
    return { seat: index, userId, playerId: index + 1, team: row.team as number };
  });
  return { battleId, ...(wireBattleId === undefined ? {} : { wireBattleId }),
    battleKeyHex, expectedPlayers: expectedPlayers as number, seats: frozen };
}

export interface GameJoinAuthorization {
  playerId: number;
  seat: number;
  metadata: Record<string, boolean | number | string>;
}

/**
 * Bind an externally authenticated user (relay ticket) to its GAME_JOIN seat.
 * Both players know the shared battle key, so the packet identity must match
 * the verified user exactly (external_identity_mismatch otherwise).
 */
export function authorizeGameJoin(manifest: RelayManifest, verifiedUserId: string, packet: Uint8Array): GameJoinAuthorization {
  const userId = identifier(verifiedUserId, 'native_user_id', true);
  const seat = manifest.seats.find(row => row.userId === userId);
  if (!seat) throw new RelayCoreError('user_not_in_battle');
  if (!(packet instanceof Uint8Array) || packet.byteLength !== GAME_JOIN_BYTES) throw new RelayCoreError('join_packet_length');
  let join;
  try { join = parseGameJoin(packet); } catch (error) {
    throw new RelayCoreError('join_' + (error instanceof FramingError ? error.code : 'invalid'));
  }
  if (join.version !== VERSION) throw new RelayCoreError('join_version');
  if (join.battleId === null || join.battleId !== (manifest.wireBattleId ?? manifest.battleId)) {
    throw new RelayCoreError('join_battle_id');
  }
  if (join.battleKey !== BigInt('0x' + manifest.battleKeyHex)) throw new RelayCoreError('join_battle_key');
  if (join.identity === null) throw new RelayCoreError('join_native_identity');
  if (join.identity !== userId) throw new RelayCoreError('external_identity_mismatch');
  if (join.normalParameter !== 200) throw new RelayCoreError('join_normal_parameter');
  if (!join.casaLoopback || !join.carpgLoopback) throw new RelayCoreError('join_endpoint_not_loopback');
  if (!join.casaPort || !join.carpgPort) throw new RelayCoreError('join_endpoint_port');
  // Authenticate key and identity before comparing the public count, as the
  // Python state-backed validator does; a wrong key never learns the count.
  if (join.expectedPlayers !== manifest.expectedPlayers) throw new RelayCoreError('join_expected_players');
  const metadata: Record<string, boolean | number | string> = { ...gameJoinMetadata(packet) };
  metadata.credentials_verified = true;
  metadata.expected_players_source = 'relay_manifest';
  return { playerId: seat.playerId, seat: seat.seat, metadata };
}

export class RelayCore {
  readonly manifest: RelayManifest;
  private readonly seats: Seat[];
  private readonly byUser = new Map<string, Seat>();
  private readonly usedConnections = new Set<string>();
  private readonly joinPayloadEncoder: (entries: Array<[number, Uint8Array]>) => Uint8Array;
  private phaseValue: RelayPhase = 'joining';
  private tickValue = 0;
  private commandSequence = 0;
  private commands: Array<{ sequence: number; playerId: number; cipher: Uint8Array }> = [];
  private commandBytes = 0;
  private endReasonValue: string | null = null;

  constructor(manifest: RelayManifest, joinPayloadEncoder = encodeJoinPayloads) {
    this.manifest = parseRelayManifest(manifest);
    if (typeof joinPayloadEncoder !== 'function') throw new RelayCoreError('invalid_join_payload_encoder');
    this.joinPayloadEncoder = joinPayloadEncoder;
    this.seats = this.manifest.seats.map(spec => ({
      ...spec, connectionId: null, transport: 'detached', epoch: 0,
      joined: false, payload: null, payloadReceived: false, ready: false,
    }));
    for (const seat of this.seats) this.byUser.set(seat.userId, seat);
  }

  get phase(): RelayPhase { return this.phaseValue; }
  get tick(): number { return this.tickValue; }
  get endReason(): string | null { return this.endReasonValue; }
  get seatCount(): number { return this.seats.length; }
  get playerIds(): number[] { return this.seats.map(seat => seat.playerId); }

  checkpoint(): RelayCoreCheckpoint {
    return { version: 1, phase: this.phaseValue, tick: this.tickValue,
      sequence: this.commandSequence, commands: this.commands.map(row => ({ ...row, cipher: row.cipher.slice() })),
      endReason: this.endReasonValue, seats: this.seats.map(row => ({ ...row, payload: row.payload?.slice() ?? null })),
      usedConnections: [...this.usedConnections] };
  }

  static restore(manifest: RelayManifest, state: RelayCoreCheckpoint): RelayCore {
    const fail = () => { throw new RelayCoreError('invalid_core_checkpoint'); };
    const uint = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
    if (!state || state.version !== 1 || !['joining', 'loading', 'ticking', 'ended'].includes(state.phase)
      || !uint(state.tick) || !uint(state.sequence) || !Array.isArray(state.seats)
      || state.seats.length !== manifest.seats.length || !Array.isArray(state.commands)
      || state.commands.length > MAX_PENDING_COMMANDS || !Array.isArray(state.usedConnections)
      || state.usedConnections.length > 1024
      || !(state.endReason === null || typeof state.endReason === 'string' && state.endReason.length <= 128)) fail();
    const core = new RelayCore(manifest);
    for (let index = 0; index < state.seats.length; index++) {
      const row = state.seats[index], spec = core.manifest.seats[index];
      if (!row || row.seat !== spec.seat || row.userId !== spec.userId || row.playerId !== spec.playerId
        || row.team !== spec.team || !uint(row.epoch) || !['detached', 'connected', 'resuming', 'abandoned'].includes(row.transport)
        || typeof row.joined !== 'boolean' || typeof row.payloadReceived !== 'boolean' || typeof row.ready !== 'boolean'
        || !(row.payload === null || row.payload instanceof Uint8Array && row.payload.length <= MAX_INNER_BYTES)
        || (row.connectionId === null) !== ['detached', 'abandoned'].includes(row.transport)) fail();
      if (row.connectionId !== null) identifier(row.connectionId, 'connection_id');
      Object.assign(core.seats[index], row, { payload: row.payload?.slice() ?? null });
    }
    let lastSequence = 0, bytes = 0;
    for (const row of state.commands) {
      if (!row || !uint(row.sequence) || row.sequence <= lastSequence || row.sequence > state.sequence
        || !core.playerIds.includes(row.playerId) || !(row.cipher instanceof Uint8Array)
        || row.cipher.length < 1 || row.cipher.length > MAX_COMMAND_CIPHERTEXT_BYTES) fail();
      lastSequence = row.sequence; bytes += row.cipher.length;
    }
    if (bytes > MAX_PENDING_CIPHERTEXT_BYTES || new Set(state.usedConnections).size !== state.usedConnections.length) fail();
    for (const id of state.usedConnections) core.usedConnections.add(identifier(id, 'connection_id'));
    for (const row of core.seats) if (row.connectionId !== null && !core.usedConnections.has(row.connectionId)) fail();
    core.phaseValue = state.phase; core.tickValue = state.tick; core.commandSequence = state.sequence;
    core.commands = state.commands.map(row => ({ ...row, cipher: row.cipher.slice() }));
    core.commandBytes = bytes; core.endReasonValue = state.endReason;
    return core;
  }

  /** Metadata only; opaque payloads and command bytes stay hidden. */
  snapshot(): {
    phase: RelayPhase; tick: number; end_reason: string | null; pending_commands: number; pending_command_bytes: number;
    seats: RelaySeatView[];
  } {
    return {
      phase: this.phaseValue,
      tick: this.tickValue,
      end_reason: this.endReasonValue,
      pending_commands: this.commands.length,
      pending_command_bytes: this.commandBytes,
      seats: this.seats.map(seat => this.viewOf(seat)),
    };
  }

  seatByUser(userId: string): RelaySeatView | undefined {
    const seat = this.byUser.get(userId);
    return seat ? this.viewOf(seat) : undefined;
  }

  seatByConnection(connectionId: string): RelaySeatView | undefined {
    const seat = this.seats.find(row => row.connectionId === connectionId);
    return seat ? this.viewOf(seat) : undefined;
  }

  /** Player ids whose retained streams still receive broadcasts. */
  activePlayerIds(): number[] {
    return this.seats.filter(seat => seat.transport !== 'abandoned').map(seat => seat.playerId);
  }

  // -------------------------------------------------------------------------
  // Transport lifecycle
  // -------------------------------------------------------------------------

  /**
   * Fresh transport for a seat that has never been attached. Emits the
   * VERSION packet: the first bytes of that seat's retained stream.
   */
  connect(verifiedUserId: string, connectionId: string): RelayEmission[] {
    this.requireLive();
    const seat = this.seatForUser(verifiedUserId);
    const connection = identifier(connectionId, 'connection_id');
    if (this.usedConnections.has(connection)) throw new RelayCoreError('connection_id_reused');
    if (seat.transport === 'abandoned') throw new RelayCoreError('seat_abandoned');
    if (seat.transport !== 'detached' || seat.connectionId !== null || seat.epoch) throw new RelayCoreError('seat_already_attached');
    this.usedConnections.add(connection);
    seat.connectionId = connection;
    seat.transport = 'connected';
    return [this.emit('version', [seat.playerId], versionPacket())];
  }

  /** Authorize GAME_JOIN against the frozen manifest and confirm the seat's player id. */
  gameJoin(connectionId: string, packet: Uint8Array): RelayEmission[] {
    this.requireLive();
    const seat = this.connectedSeat(connectionId);
    if (this.phaseValue !== 'joining' || seat.joined) throw new RelayCoreError('join_order');
    authorizeGameJoin(this.manifest, seat.userId, packet);
    seat.joined = true;
    return [this.emit('game_confirm', [seat.playerId], gameConfirmPacket(seat.playerId))];
  }

  submitJoinPayload(connectionId: string, packet: Uint8Array): RelayEmission[] {
    if (this.phaseValue !== 'joining') throw new RelayCoreError('join_payload_phase');
    const seat = this.connectedSeat(connectionId);
    if (!seat.joined) throw new RelayCoreError('payload_order');
    if (seat.payloadReceived) throw new RelayCoreError('duplicate_join_payload');
    // Validate immediately without retaining a bad first payload until the
    // other seats arrive. The aggregate call later enforces its own bound.
    this.encodePayloads([[seat.playerId, packet]]);
    // The other seat may arrive later. Own the validated bytes rather than
    // retaining a caller's mutable Uint8Array across the JOIN barrier.
    seat.payload = packet.slice();
    seat.payloadReceived = true;
    return this.maybePublishJoinPayloads();
  }

  markReady(connectionId: string, packet: Uint8Array): RelayEmission[] {
    if (this.phaseValue !== 'loading') throw new RelayCoreError('ready_phase');
    const seat = this.connectedSeat(connectionId);
    try { validateReadyPacket(packet); } catch (error) { throw new RelayCoreError(error instanceof FramingError ? error.code : 'ready_framing'); }
    if (seat.ready) throw new RelayCoreError('duplicate_ready');
    seat.ready = true;
    const emissions = [this.broadcast('player_finished_loading', playerFinishedLoadingPacket(seat.playerId))];
    emissions.push(...this.maybeStartTicking());
    return emissions;
  }

  canQueueCommand(packet: Uint8Array): boolean {
    const bytes = packet.byteLength - 3;
    // Invalid packets still reach queueCommand's protocol validation.
    if (bytes <= 0 || bytes > MAX_COMMAND_CIPHERTEXT_BYTES) return true;
    return this.commands.length < MAX_PENDING_COMMANDS
      && this.commandBytes + bytes <= MAX_PENDING_CIPHERTEXT_BYTES;
  }

  queueCommand(connectionId: string, epoch: number, packet: Uint8Array): void {
    if (this.phaseValue !== 'ticking') throw new RelayCoreError('command_phase');
    if (!Number.isInteger(epoch) || epoch < 0) throw new RelayCoreError('invalid_epoch');
    const seat = this.connectedSeat(connectionId);
    if (epoch !== seat.epoch) throw new RelayCoreError('stale_epoch');
    if (!(packet instanceof Uint8Array) || packet.byteLength < 4 || packet.byteLength > MAX_INNER_BYTES) throw new RelayCoreError('command_packet_length');
    const header = readInnerHeader(packet)!;
    if (header.kind !== 3 || header.total !== packet.byteLength) throw new RelayCoreError('command_framing');
    const cipher = packet.slice(3);
    if (cipher.byteLength === 0 || cipher.byteLength > MAX_COMMAND_CIPHERTEXT_BYTES) throw new RelayCoreError('command_packet_length');
    if (this.commands.length >= MAX_PENDING_COMMANDS) throw new RelayCoreError('command_queue_overflow');
    if (this.commandBytes + cipher.byteLength > MAX_PENDING_CIPHERTEXT_BYTES) throw new RelayCoreError('command_bytes_overflow');
    this.commandSequence += 1;
    this.commands.push({ sequence: this.commandSequence, playerId: seat.playerId, cipher });
    this.commandBytes += cipher.byteLength;
  }

  /** kind 7 checksum vectors: shape-checked and counted only, never compared. */
  observeChecksums(connectionId: string, packet: Uint8Array): number {
    this.requireLive();
    const seat = this.connectedSeat(connectionId);
    if (!seat.payloadReceived) throw new RelayCoreError('post_payload_order');
    if (!(packet instanceof Uint8Array) || packet.byteLength < 3 || packet.byteLength > MAX_INNER_BYTES) {
      throw new RelayCoreError('checksum_packet_length');
    }
    const header = readInnerHeader(packet);
    if (!header || header.kind !== 7 || header.total !== packet.byteLength) throw new RelayCoreError('checksum_framing');
    if ((header.total - 3) % 4) throw new RelayCoreError('checksum_packet_length');
    return (header.total - 3) / 4;
  }

  /**
   * Dispatch one complete client inner packet, mirroring the proven
   * NativeBattleProbe order rules. Returns emissions plus metadata notes.
   */
  handleClientPacket(connectionId: string, epoch: number, packet: Uint8Array): RelayResult {
    this.requireLive();
    const header = readInnerHeader(packet);
    if (!header || header.total !== packet.byteLength || header.total < 3 || header.total > MAX_INNER_BYTES) throw new RelayCoreError('inner_length');
    const notes: RelayNote[] = [];
    const seat = this.connectedSeat(connectionId);
    // READY and JOIN mutate barriers too; fencing only commands permits a
    // stale transport generation to advance the shared battle state.
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new RelayCoreError('invalid_epoch');
    if (epoch !== seat.epoch) throw new RelayCoreError('stale_epoch');
    switch (header.kind) {
      case 4:
        if (header.total !== 3) throw new RelayCoreError('keepalive_length');
        return { emissions: [], notes };
      case 0:
        return { emissions: this.gameJoin(connectionId, packet), notes };
      case 1:
        if (!seat.joined) throw new RelayCoreError('payload_order');
        return { emissions: this.submitJoinPayload(connectionId, packet), notes };
      case 3:
      case 5:
      case 6:
      case 7: {
        if (!seat.payloadReceived) throw new RelayCoreError('post_payload_order');
        if (header.kind === 5) return { emissions: this.markReady(connectionId, packet), notes };
        if (header.kind === 3) {
          this.queueCommand(connectionId, epoch, packet);
          notes.push({ event: 'command_queued', payload_bytes: header.total - 3, pending_count: this.commands.length,
            pending_payload_bytes: this.commandBytes, command_semantics_verified: false });
          return { emissions: [], notes };
        }
        if (header.kind === 6) {
          if (this.phaseValue !== 'ticking') throw new RelayCoreError('unticked_phase');
          const message = parseUntickedPacket(packet);
          // Native all-chat uses 0xffffffff; team pings use 1 << player_id.
          // Ignore bits outside this match (including rendered CPU seats).
          const playerIds = this.seats.filter(target => target.transport !== 'abandoned' &&
            (message.recipients & (1 << target.playerId)) !== 0).map(target => target.playerId);
          return { emissions: playerIds.length ? [{ event: 'unticked_message', playerIds,
            packet: untickedPacket(seat.playerId, message.channel, message.data), tick: null }] : [], notes };
        }
        notes.push({ event: 'tick_checksums_observed', count: this.observeChecksums(connectionId, packet), compared: false });
        return { emissions: [], notes };
      }
      default:
        throw new RelayCoreError('unsupported_client_kind');
    }
  }

  /** One implicit native tick per seat, identically broadcast to every stream. */
  takeTick(): RelayEmission {
    return this.takeTickWithDeferred([]).emission;
  }

  /** Players already represented in the core's next tick. */
  pendingCommandPlayers(): ReadonlySet<number> { return new Set(this.commands.map(command => command.playerId)); }

  /** Fill this tick's unused player slots from authenticated, retained input.
   * Future queued commands cannot block another player's current command.
   * This consumes no additional persistent queue space or per-tick bytes.
   */
  takeTickWithDeferred(deferred: Array<{ playerId: number; cipher: Uint8Array }>): {
    emission: RelayEmission; consumed: number[];
  } {
    if (this.phaseValue !== 'ticking') throw new RelayCoreError('tick_phase');
    const offered = new Set<number>();
    for (const command of deferred) {
      const seat = this.seats.find(seat => seat.playerId === command.playerId);
      if (!seat || seat.transport !== 'connected' || !seat.ready || offered.has(command.playerId)
        || !(command.cipher instanceof Uint8Array) || command.cipher.length < 1
        || command.cipher.length > MAX_COMMAND_CIPHERTEXT_BYTES) throw new RelayCoreError('invalid_deferred_command');
      offered.add(command.playerId);
    }
    const commanded = new Set<number>();
    const packets: Uint8Array[] = [];
    const consumed: number[] = [];
    let tickBytes = 0;
    const remaining: typeof this.commands = [];
    for (const command of this.commands) {
      // Each kind-4 packet advances that player's implicit native tick. A
      // burst must span successive relay ticks; emitting it all at once makes
      // that player's command timeline run ahead and accumulates input delay.
      if (commanded.has(command.playerId)) {
        remaining.push(command);
        continue;
      }
      commanded.add(command.playerId);
      packets.push(commandEchoPacket(command.playerId, command.cipher));
      tickBytes += command.cipher.byteLength;
      this.commandBytes -= command.cipher.byteLength;
    }
    for (const command of deferred) {
      if (commanded.has(command.playerId) || tickBytes + command.cipher.byteLength > MAX_PENDING_CIPHERTEXT_BYTES) continue;
      commanded.add(command.playerId); consumed.push(command.playerId);
      tickBytes += command.cipher.byteLength; this.commandSequence += 1;
      packets.push(commandEchoPacket(command.playerId, command.cipher));
    }
    let missing = 0;
    for (const seat of this.seats) if (!commanded.has(seat.playerId)) missing |= 1 << seat.playerId;
    if (missing) packets.push(emptyTickMaskPacket(missing >>> 0));
    this.commands = remaining;
    this.tickValue += 1;
    let size = 0;
    for (const packet of packets) size += packet.byteLength;
    const batch = new Uint8Array(size);
    let offset = 0;
    for (const packet of packets) { batch.set(packet, offset); offset += packet.byteLength; }
    return { emission: this.broadcast('battle_tick', batch, this.tickValue), consumed };
  }

  /** Fence a current transport while preserving its logical seat. */
  detach(connectionId: string): RelayEmission[] {
    this.requireLive();
    const connection = identifier(connectionId, 'connection_id');
    const seat = this.seats.find(row => row.connectionId === connection);
    if (!seat || (seat.transport !== 'connected' && seat.transport !== 'resuming')) throw new RelayCoreError('connection_not_current');
    const wasConnected = seat.transport === 'connected';
    seat.connectionId = null;
    seat.transport = 'detached';
    seat.epoch += 1;
    if (!wasConnected || this.phaseValue !== 'ticking') return [];
    return this.toOthers('player_temporarily_disconnected', seat, playerTemporarilyDisconnectedPacket(seat.playerId), this.tickValue);
  }

  /** Reserve a fresh transport; commands stay blocked until replay completes. */
  beginResume(verifiedUserId: string, connectionId: string): number {
    this.requireLive();
    const seat = this.seatForUser(verifiedUserId);
    const connection = identifier(connectionId, 'connection_id');
    if (this.usedConnections.has(connection)) throw new RelayCoreError('connection_id_reused');
    if (seat.transport === 'abandoned') throw new RelayCoreError('seat_abandoned');
    if (seat.transport !== 'detached' || seat.connectionId !== null) throw new RelayCoreError('seat_not_detached');
    if (seat.epoch === 0) throw new RelayCoreError('resume_before_initial_attach');
    this.usedConnections.add(connection);
    seat.connectionId = connection;
    seat.transport = 'resuming';
    seat.epoch += 1;
    return seat.epoch;
  }

  /** Fence a transport which failed before retained-stream replay ended. */
  abortResume(connectionId: string, epoch: number): void {
    this.requireLive();
    const seat = this.resumingSeat(connectionId, epoch);
    seat.connectionId = null;
    seat.transport = 'detached';
    seat.epoch += 1;
  }

  /** Admit a peer only after the caller completed retained-stream replay. */
  finishResume(connectionId: string, epoch: number): RelayEmission[] {
    this.requireLive();
    const seat = this.resumingSeat(connectionId, epoch);
    seat.transport = 'connected';
    if (this.phaseValue === 'joining') return this.maybePublishJoinPayloads();
    if (this.phaseValue === 'loading') return this.maybeStartTicking();
    return this.toOthers('player_reconnected', seat, playerReconnectedPacket(seat.playerId), this.tickValue);
  }

  /**
   * Give up on a seat permanently: no further resume, no further broadcast
   * appends. Before ticking this ends the battle (roster_incomplete) because a
   * partial JOIN_PAYLOADS roster is untested on the game; during ticking the
   * remaining seats keep ticking and the kind 5 mask marks the empty seat.
   */
  abandon(verifiedUserId: string): void {
    this.requireLive();
    const seat = this.seatForUser(verifiedUserId);
    if (seat.transport === 'abandoned') return;
    seat.connectionId = null;
    seat.transport = 'abandoned';
    seat.epoch += 1;
    seat.payload = null;
    if (this.phaseValue !== 'ticking') { this.end('roster_incomplete'); return; }
    if (this.activePlayerIds().length === 0) this.end('all_seats_abandoned');
  }

  end(reason = 'ended'): void {
    if (this.phaseValue === 'ended') return;
    this.phaseValue = 'ended';
    this.endReasonValue = reason;
    this.commands = [];
    this.commandBytes = 0;
    for (const seat of this.seats) {
      seat.payload = null;
      seat.connectionId = null;
      if (seat.transport !== 'abandoned') seat.transport = 'detached';
      seat.epoch += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private maybePublishJoinPayloads(): RelayEmission[] {
    if (!this.seats.every(seat => seat.transport === 'connected' && seat.payloadReceived)) return [];
    const packet = this.encodePayloads(this.seats.map(seat => [seat.playerId, seat.payload]));
    for (const seat of this.seats) seat.payload = null;
    this.phaseValue = 'loading';
    return [this.broadcast('join_payloads', packet)];
  }

  private maybeStartTicking(): RelayEmission[] {
    if (this.phaseValue !== 'loading' || !this.seats.every(seat => seat.transport === 'connected' && seat.ready)) return [];
    this.phaseValue = 'ticking';
    return [this.broadcast('game_ticking', gameTickingPacket(), this.tickValue)];
  }

  private encodePayloads(entries: Array<[number, Uint8Array | null]>): Uint8Array {
    if (entries.some(([, packet]) => packet === null)) throw new RelayCoreError('join_payload_missing');
    let packet: Uint8Array;
    try {
      packet = this.joinPayloadEncoder(entries.map(([playerId, value]) => [playerId, value!]));
    } catch (error) {
      if (error instanceof RelayCoreError) throw error;
      const code = (error as { code?: unknown })?.code;
      throw new RelayCoreError(typeof code === 'string' && code ? code : 'invalid_join_payload');
    }
    if (!(packet instanceof Uint8Array) || packet.byteLength < 3) throw new RelayCoreError('invalid_join_payload_encoding');
    return packet;
  }

  private seatForUser(verifiedUserId: string): Seat {
    const seat = this.byUser.get(identifier(verifiedUserId, 'native_user_id', true));
    if (!seat) throw new RelayCoreError('user_not_in_battle');
    return seat;
  }

  private connectedSeat(connectionId: unknown): Seat {
    const connection = identifier(connectionId, 'connection_id');
    const seat = this.seats.find(row => row.connectionId === connection);
    if (!seat || seat.transport !== 'connected') throw new RelayCoreError('connection_not_current');
    return seat;
  }

  private resumingSeat(connectionId: unknown, epoch: number): Seat {
    const connection = identifier(connectionId, 'connection_id');
    const seat = this.seats.find(row => row.connectionId === connection);
    if (!seat || seat.transport !== 'resuming') throw new RelayCoreError('resume_not_pending');
    if (!Number.isInteger(epoch) || epoch !== seat.epoch) throw new RelayCoreError('stale_epoch');
    return seat;
  }

  private viewOf(seat: Seat): RelaySeatView {
    return {
      seat: seat.seat, userId: seat.userId, playerId: seat.playerId, team: seat.team,
      connectionId: seat.connectionId, transport: seat.transport, epoch: seat.epoch,
      joined: seat.joined, payloadReceived: seat.payloadReceived, ready: seat.ready,
    };
  }

  private emit(event: string, playerIds: number[], packet: Uint8Array, tick: number | null = null): RelayEmission {
    return { event, playerIds, packet, tick };
  }

  private broadcast(event: string, packet: Uint8Array, tick: number | null = null): RelayEmission {
    return this.emit(event, this.activePlayerIds(), packet, tick);
  }

  private toOthers(event: string, subject: Seat, packet: Uint8Array, tick: number | null): RelayEmission[] {
    const others = this.activePlayerIds().filter(playerId => playerId !== subject.playerId);
    return others.length ? [this.emit(event, others, packet, tick)] : [];
  }

  private requireLive(): void {
    if (this.phaseValue === 'ended') throw new RelayCoreError('battle_ended');
  }
}
