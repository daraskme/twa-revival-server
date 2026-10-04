/**
 * BattleRelaySession: everything the BattleRelay Durable Object does except
 * touching Cloudflare APIs. It owns the RelayCore, the retained streams, the
 * per-connection handshake/greeting/stream stages, deadlines and the 200 ms
 * tick clock, and talks to transports only through the RelayTransport
 * interface. This keeps the DO wrapper thin and lets tests drive a complete
 * two-seat battle (handshake -> greeting -> GAME_JOIN -> payload barrier ->
 * READY barrier -> ticks -> drop -> resume) without any binding.
 *
 * Bridge <-> relay protocol (one WebSocket per game TCP connection):
 *   1. client text frame  {"ticket": str, "resumeOffset": int, "greeting": bool=true, "clientOffset": int=0}
 *   2. greeting=true : next client binary frame is the game's 40-byte CAReconn
 *                      greeting; the relay answers with the raw 17-byte reply
 *                      (plus replayed outer chunks on a CAReconn resume).
 *      greeting=false: bridge-side WebSocket resume while the game socket
 *                      stayed open; the relay sends {"event":"resumed",
 *                      "clientReceived":K} then replays from resumeOffset.
 *   3. every later client binary frame is exactly one outer chunk
 *      (<u16le len><payload>, len 0 = ACK) as read from the game's TCP stream.
 *   4. relay binary frames are raw bytes to write to the game socket, each
 *      being one unit: the 17-byte reply, one outer chunk, or one 2-byte ACK.
 *      Text frames {"event":...} are diagnostics only.
 *   5. relay close codes: 4000 rejected (reason = error code, never retry),
 *      4001 battle ended, 4002 superseded by a newer transport for the seat.
 */
import { TickClock } from './clock';
import {
  MAX_COMMAND_CIPHERTEXT_BYTES, RelayCore, RelayCoreError, parseRelayManifest, authorizeGameJoin,
  type RelayCoreCheckpoint, type RelayEmission, type RelayManifest, type RelayNote, type RelaySeatSpec, type SeatTransport,
} from './core';
import {
  ACK_CHUNK, FramingError, GREETING_BYTES, InnerPacketBuffer, MAX_INNER_BYTES, greetingReply,
  parseGreeting, parseOuterChunkFrame, streamChunk, equalBytes, validateReadyPacket,
} from './framing';
import { ClientStreamAccounting, RetainedStreams, StreamError, type StreamCheckpoint } from './streams';
import { TicketError, verifyRelayTicket, type RelayTicket } from './ticket';
import { restartPlan, validateRestartPayload, validateRestartState, type RestartState } from './restart';

export const CLOSE_REJECTED = 4000;
export const CLOSE_ENDED = 4001;
export const CLOSE_SUPERSEDED = 4002;
/** Transient capacity pressure; preserve the seat and replay unaccepted bytes. */
export const CLOSE_BACKPRESSURE = 4003;

export interface RelayTransport {
  sendBinary(bytes: Uint8Array): void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
}

export interface SessionLimits {
  handshakeTimeoutMs: number;
  greetingTimeoutMs: number;
  /** No client frame for this long closes the transport (native_battle_probe NATURAL_READ_IDLE_SECONDS). */
  readIdleMs: number;
  /** Hard battle cap from the first greeting (NATURAL_CONNECTION_SECONDS). */
  sessionMaxMs: number;
  /** Detached-seat reservation, including launcher/game restart and map load. */
  reconnectGraceMs: number;
  /** A seat that never connected within this window after the first greeting ends the battle. */
  joinTimeoutMs: number;
  /** Maximum time without an accepted JOIN/payload/READY barrier while all seats are connected. */
  startupProgressTimeoutMs: number;
  maxResumesPerSeat: number;
  /** Client inner packets per seat per battle (MAX_NATURAL_PACKETS). */
  maxClientPackets: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  handshakeTimeoutMs: 15_000,
  greetingTimeoutMs: 15_000,
  readIdleMs: 5 * 60_000,
  sessionMaxMs: 30 * 60_000,
  reconnectGraceMs: 10 * 60_000,
  joinTimeoutMs: 120_000,
  startupProgressTimeoutMs: 5 * 60_000,
  maxResumesPerSeat: 8,
  maxClientPackets: 100_000,
};

export interface SessionOptions {
  now: () => number;
  secret: string;
  log?: (event: string, fields: Record<string, unknown>) => void;
  limits?: Partial<SessionLimits>;
}

export interface Handshake {
  ticket: string;
  resumeOffset: number;
  greeting: boolean;
  clientOffset: number;
  restart?: boolean;
}

type Stage = 'handshake' | 'greeting' | 'stream' | 'closed';

interface Connection {
  id: string;
  transport: RelayTransport;
  stage: Stage;
  openedAt: number;
  lastReadAt: number;
  ticket: RelayTicket | null;
  seat: number | null;
  epoch: number;
  chain: Promise<void>;
  restartRequested?: boolean;
}

interface SeatState {
  spec: RelaySeatSpec;
  connectionId: string | null;
  greetingIdentity: Uint8Array | null;
  lastAttempt: number;
  resumes: number;
  detachedAt: number | null;
  client: ClientStreamAccounting;
  inner: InnerPacketBuffer;
  packets: number;
  checksumPackets: number;
  checksumWords: number;
  restart: RestartState | null;
}

/** Private recovery state. Never include this object in status or logs. */
export interface RelaySessionCheckpoint {
  version: 1;
  savedAt: number;
  manifest: RelayManifest;
  core: RelayCoreCheckpoint;
  streams: StreamCheckpoint[];
  startedAt: number | null;
  /** Optional for version-1 checkpoints written before the startup-progress timer existed. */
  prestartProgressAt?: number | null;
  prestartPausedAt?: number | null;
  ended: { reason: string; at: number } | null;
  clock: { started: boolean; count: number; nextAt: number };
  seats: Array<{ greetingIdentity: Uint8Array | null; lastAttempt: number; resumes: number;
    detachedAt: number | null; received: number; acked: number; packets: number; inner: Uint8Array;
    checksumPackets: number; checksumWords: number; restart?: RestartState | null }>;
}

export interface RelaySessionSeatSnapshot {
  seat: number;
  player_id: number;
  team: number;
  transport: SeatTransport;
  epoch: number;
  joined: boolean;
  payload_received: boolean;
  ready: boolean;
  resumes: number;
  detached_at: number | null;
  client_stream_bytes: number;
  client_acked_bytes: number;
  client_packets: number;
}

export interface RelaySessionSnapshot {
  battle_id: string | null;
  expected_players: number | null;
  phase: string;
  tick: number;
  end_reason: string | null;
  started_at: number | null;
  connections: Array<{ stage: Stage; seat: number | null; epoch: number }>;
  pending_commands: number;
  seats: RelaySessionSeatSnapshot[];
  streams: ReturnType<RetainedStreams['snapshot']>['players'];
  recent_events: Array<RelayNote & { at: number }>;
}

export class SessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SessionError';
  }
}

function errorCode(error: unknown): string {
  if (error instanceof RelayCoreError || error instanceof FramingError || error instanceof StreamError
    || error instanceof TicketError || error instanceof SessionError) return error.code;
  return 'internal_error';
}

function safeNonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export function parseHandshake(text: string): Handshake {
  if (typeof text !== 'string' || text.length === 0 || text.length > 4096) throw new SessionError('handshake_format');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SessionError('handshake_format'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SessionError('handshake_format');
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!['ticket', 'resumeOffset', 'greeting', 'clientOffset', 'restart'].includes(key)) throw new SessionError('handshake_format');
  const { ticket, resumeOffset, greeting = true, clientOffset = 0 } = record;
  if (typeof ticket !== 'string' || !safeNonNegative(resumeOffset) || typeof greeting !== 'boolean' || !safeNonNegative(clientOffset)) {
    throw new SessionError('handshake_format');
  }
  if (record.restart !== undefined && typeof record.restart !== 'boolean') throw new SessionError('handshake_format');
  return { ticket, resumeOffset, greeting, clientOffset, ...(record.restart !== undefined ? {restart: record.restart} : {}) };
}

export class BattleRelaySession {
  private readonly now: () => number;
  private readonly secret: string;
  private readonly limits: SessionLimits;
  private readonly logger?: (event: string, fields: Record<string, unknown>) => void;
  private readonly events: Array<RelayNote & { at: number }> = [];
  private readonly connections = new Map<string, Connection>();
  private manifest: RelayManifest | null = null;
  private core: RelayCore | null = null;
  private streams: RetainedStreams | null = null;
  private seats: SeatState[] = [];
  private clock = new TickClock();
  private startedAt: number | null = null;
  private prestartProgressAt: number | null = null;
  private prestartPausedAt: number | null = null;
  private ended: { reason: string; at: number } | null = null;

  constructor(options: SessionOptions) {
    this.now = options.now;
    this.secret = options.secret;
    this.logger = options.log;
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  }

  get hasManifest(): boolean { return this.manifest !== null; }
  get battleId(): string | null { return this.manifest?.battleId ?? null; }
  get phase(): string { return this.ended ? 'ended' : (this.core?.phase ?? 'unconfigured'); }
  get tick(): number { return this.core?.tick ?? 0; }
  get isEnded(): boolean { return this.ended !== null; }
  get connectionCount(): number { return this.connections.size; }

  checkpoint(): RelaySessionCheckpoint | null {
    if (!this.manifest || !this.core || !this.streams) return null;
    return { version: 1, savedAt: this.now(), manifest: this.manifest, core: this.core.checkpoint(),
      streams: this.streams.checkpoint(), startedAt: this.startedAt,
      prestartProgressAt: this.prestartProgressAt, prestartPausedAt: this.prestartPausedAt, ended: this.ended,
      clock: { started: this.clock.started, count: this.clock.count, nextAt: this.clock.nextAt },
      seats: this.seats.map(seat => ({ greetingIdentity: seat.greetingIdentity?.slice() ?? null,
        lastAttempt: seat.lastAttempt, resumes: seat.resumes, detachedAt: seat.detachedAt,
        received: seat.client.received, acked: seat.client.acked, packets: seat.packets,
        checksumPackets: seat.checksumPackets, checksumWords: seat.checksumWords,
        inner: seat.inner.checkpoint(), restart: seat.restart ? {...seat.restart} : null })) };
  }

  /** Restore progress and fence transports owned by the previous process. */
  restore(state: RelaySessionCheckpoint): void {
    const fail = () => { throw new SessionError('invalid_session_checkpoint'); };
    const nullableTime = (v: unknown) => v === null || safeNonNegative(v);
    if (this.connections.size || this.startedAt !== null || !state || state.version !== 1
      || !safeNonNegative(state.savedAt) || !nullableTime(state.startedAt)
      || !state.clock || typeof state.clock.started !== 'boolean' || !safeNonNegative(state.clock.count)
      || !safeNonNegative(state.clock.nextAt) || !Array.isArray(state.seats)
      || !(state.ended === null || typeof state.ended?.reason === 'string' && state.ended.reason.length <= 128
        && safeNonNegative(state.ended.at))) fail();
    const progressPresent = Object.prototype.hasOwnProperty.call(state, 'prestartProgressAt');
    const pausedPresent = Object.prototype.hasOwnProperty.call(state, 'prestartPausedAt');
    if (progressPresent !== pausedPresent) fail();
    if (progressPresent && (!nullableTime(state.prestartProgressAt) || !nullableTime(state.prestartPausedAt)
      || (state.prestartProgressAt !== null && (state.startedAt === null
        || state.prestartProgressAt! < state.startedAt || state.prestartProgressAt! > state.savedAt))
      || (state.prestartPausedAt !== null && (state.prestartProgressAt === null
        || state.prestartPausedAt < state.prestartProgressAt! || state.prestartPausedAt > state.savedAt)))) fail();
    const manifest = parseRelayManifest(state.manifest);
    if (this.manifest && JSON.stringify(this.manifest) !== JSON.stringify(manifest)) fail();
    if (state.seats.length !== manifest.seats.length) fail();
    const core = RelayCore.restore(manifest, state.core);
    const streams = RetainedStreams.restore(core.playerIds, state.streams);
    const seats = state.seats.map((row, index): SeatState => {
      if (!row || !(row.greetingIdentity === null || row.greetingIdentity instanceof Uint8Array && row.greetingIdentity.length === 16)
        || !Number.isSafeInteger(row.lastAttempt) || row.lastAttempt < -1 || !nullableTime(row.detachedAt)
        || ![row.resumes, row.received, row.acked, row.packets, row.checksumPackets, row.checksumWords].every(safeNonNegative)
        || row.acked > row.received || row.received - row.acked >= 1000 || row.resumes > this.limits.maxResumesPerSeat
        || row.packets > this.limits.maxClientPackets || !(row.inner instanceof Uint8Array) || row.inner.length > MAX_INNER_BYTES) fail();
      const client = new ClientStreamAccounting(); client.received = row.received; client.acked = row.acked;
      const inner = new InnerPacketBuffer(); inner.push(row.inner);
      // Complete packets may be waiting for command queue capacity. Check their
      // framing without consuming the saved bytes; semantics run on admission.
      const validation = new InnerPacketBuffer(); validation.push(row.inner);
      while (validation.next() !== null) { /* bounded by MAX_INNER_BYTES */ }
      return { spec: manifest.seats[index], connectionId: null, greetingIdentity: row.greetingIdentity,
        lastAttempt: row.lastAttempt, resumes: row.resumes, detachedAt: row.detachedAt,
        client, packets: row.packets, checksumPackets: row.checksumPackets, checksumWords: row.checksumWords, inner,
        restart: row.restart ? validateRestartState(row.restart, streams.history(index + 1), index + 1) : null };
    });
    this.manifest = manifest; this.core = core; this.streams = streams; this.seats = seats;
    this.startedAt = state.startedAt; this.ended = state.ended;
    const prestart = core.phase === 'joining' || core.phase === 'loading';
    this.prestartProgressAt = prestart ? (progressPresent ? state.prestartProgressAt! : state.startedAt) : null;
    this.prestartPausedAt = prestart && this.prestartProgressAt !== null
      ? (progressPresent ? state.prestartPausedAt ?? state.savedAt : state.savedAt) : null;
    Object.assign(this.clock, state.clock);
    if (this.clock.started) this.clock.resume(this.now());
    if (!this.ended) {
      for (const seat of seats) {
        const view = core.seatByUser(seat.spec.userId)!;
        if (view.connectionId !== null) {
          seat.detachedAt = state.savedAt;
          this.dispatch(core.detach(view.connectionId));
        }
      }
    }
    this.log('session_restored', { phase: this.phase, tick: this.tick, seats: seats.length });
  }

  /** True while the host must keep calling onTimer(). */
  get needsTimer(): boolean {
    if (this.ended) return false;
    if (this.connections.size > 0) return true;
    return this.seats.some(seat => seat.detachedAt !== null) || (this.startedAt !== null);
  }

  private prestartActive(): boolean {
    return !this.ended && this.startedAt !== null
      && (this.core?.phase === 'joining' || this.core?.phase === 'loading');
  }

  private allSeatsConnected(): boolean {
    return !!this.core && this.seats.every(seat =>
      this.core!.seatByUser(seat.spec.userId)!.transport === 'connected');
  }

  /** Transport absence pauses only the progress timer; reconnect grace still runs. */
  private syncPrestartClock(now: number): void {
    if (!this.prestartActive()) return;
    if (this.prestartProgressAt === null) this.prestartProgressAt = this.startedAt!;
    if (!this.allSeatsConnected()) {
      if (this.prestartPausedAt === null) this.prestartPausedAt = now;
    } else if (this.prestartPausedAt !== null) {
      this.prestartProgressAt = this.prestartProgressAt! + Math.max(0, now - this.prestartPausedAt);
      this.prestartPausedAt = null;
    }
  }

  /** Only an accepted native start barrier advances the progress deadline. */
  private recordPrestartProgress(now: number): void {
    if (!this.prestartActive()) {
      this.prestartProgressAt = null; this.prestartPausedAt = null; return;
    }
    this.prestartProgressAt = now;
    this.prestartPausedAt = this.allSeatsConnected() ? null : now;
  }

  /** Earliest deadline the host should wake for (never later than now + 1000 ms). */
  nextWakeAt(now: number): number {
    let wake = now + 1000;
    if (this.core?.phase === 'ticking' && this.clock.started) wake = Math.min(wake, this.clock.nextAt);
    for (const conn of this.connections.values()) {
      if (conn.stage === 'handshake') wake = Math.min(wake, conn.openedAt + this.limits.handshakeTimeoutMs);
      else if (conn.stage === 'greeting') wake = Math.min(wake, conn.lastReadAt + this.limits.greetingTimeoutMs);
      else if (conn.stage === 'stream') wake = Math.min(wake, conn.lastReadAt + this.limits.readIdleMs);
    }
    for (const seat of this.seats) if (seat.detachedAt !== null) wake = Math.min(wake, seat.detachedAt + this.limits.reconnectGraceMs);
    if (this.startedAt !== null) wake = Math.min(wake, this.startedAt + this.limits.sessionMaxMs);
    if (this.prestartActive() && this.prestartPausedAt === null && this.prestartProgressAt !== null) {
      wake = Math.min(wake, this.prestartProgressAt + this.limits.startupProgressTimeoutMs);
    }
    return Math.max(now, wake);
  }

  /** Metadata only: no payloads, keys, tickets or native identities. */
  snapshot(): RelaySessionSnapshot {
    const core = this.core?.snapshot();
    return {
      battle_id: this.manifest?.battleId ?? null,
      expected_players: this.manifest?.expectedPlayers ?? null,
      phase: this.phase,
      tick: this.tick,
      end_reason: this.ended?.reason ?? this.core?.endReason ?? null,
      started_at: this.startedAt,
      connections: [...this.connections.values()].map(conn => ({ stage: conn.stage, seat: conn.seat, epoch: conn.epoch })),
      pending_commands: core?.pending_commands ?? 0,
      seats: this.seats.map((seat, index) => ({
        seat: seat.spec.seat,
        player_id: seat.spec.playerId,
        team: seat.spec.team,
        transport: core?.seats[index].transport ?? 'detached',
        epoch: core?.seats[index].epoch ?? 0,
        joined: core?.seats[index].joined ?? false,
        payload_received: core?.seats[index].payloadReceived ?? false,
        ready: core?.seats[index].ready ?? false,
        resumes: seat.resumes,
        detached_at: seat.detachedAt,
        client_stream_bytes: seat.client.received,
        client_acked_bytes: seat.client.acked,
        client_packets: seat.packets,
      })),
      streams: this.streams?.snapshot().players ?? [],
      recent_events: this.events.slice(-50),
    };
  }

  // -------------------------------------------------------------------------
  // Control plane
  // -------------------------------------------------------------------------

  restartAvailable(playerId: number): boolean {
    const seat = this.seats.find(row => row.spec.playerId === playerId);
    if (!seat || this.phase !== 'ticking' || this.startedAt === null
      || this.now() >= this.startedAt + this.limits.sessionMaxMs
      || seat.resumes >= this.limits.maxResumesPerSeat
      || (seat.detachedAt !== null && this.now() >= seat.detachedAt + this.limits.reconnectGraceMs)
      || this.core!.seatByUser(seat.spec.userId)!.transport === 'abandoned') return false;
    try { restartPlan(this.streams!.history(playerId), playerId); return true; }
    catch { return false; }
  }

  /**
   * Install the frozen battle manifest. Idempotent for identical content;
   * a different manifest is accepted only before any seat has connected.
   */
  setManifest(value: unknown): RelayManifest {
    if (this.ended) throw new SessionError('battle_ended');
    const manifest = parseRelayManifest(value);
    if (this.manifest) {
      if (JSON.stringify(this.manifest) === JSON.stringify(manifest)) return this.manifest;
      if (this.startedAt !== null) throw new SessionError('manifest_conflict');
    }
    this.manifest = manifest;
    this.core = new RelayCore(manifest);
    this.streams = new RetainedStreams(manifest.seats.map(seat => seat.playerId), true);
    this.seats = manifest.seats.map(spec => ({
      spec, connectionId: null, greetingIdentity: null, lastAttempt: -1, resumes: 0, detachedAt: null,
      client: new ClientStreamAccounting(), inner: new InnerPacketBuffer(), packets: 0, checksumPackets: 0, checksumWords: 0, restart: null,
    }));
    this.log('manifest_set', { seats: manifest.seats.length, expected_players: manifest.expectedPlayers });
    return manifest;
  }

  /** Control-plane D1 creation time; test the deadline and admission atomically. */
  retireUnstarted(createdAt: unknown): void {
    if (!safeNonNegative(createdAt) || Number(createdAt) > this.now()) throw new SessionError('invalid_battle_creation_time');
    if (this.manifest && !this.ended && this.startedAt === null
      && this.now() - Number(createdAt) >= this.limits.joinTimeoutMs) this.end('unstarted_deadline');
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = { reason, at: this.now() };
    this.prestartProgressAt = null; this.prestartPausedAt = null;
    this.core?.end(reason);
    for (const conn of [...this.connections.values()]) this.closeConnection(conn, CLOSE_ENDED, reason);
    this.streams?.clear();
    for (const seat of this.seats) { seat.detachedAt = null; seat.restart = null; }
    this.log('battle_ended', { reason, tick: this.tick });
  }

  // -------------------------------------------------------------------------
  // Transport events
  // -------------------------------------------------------------------------

  onOpen(id: string, transport: RelayTransport): void {
    const now = this.now();
    if (this.connections.has(id)) throw new SessionError('connection_id_reused');
    const conn: Connection = {
      id, transport, stage: 'handshake', openedAt: now, lastReadAt: now, ticket: null, seat: null,
      epoch: 0, chain: Promise.resolve(),
    };
    this.connections.set(id, conn);
    if (this.ended) { this.closeConnection(conn, CLOSE_ENDED, this.ended.reason); return; }
    this.log('connection', { connections: this.connections.size });
  }

  /** Frames from one connection are processed strictly in order even though ticket checks are async. */
  onMessage(id: string, data: string | ArrayBuffer | Uint8Array): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return Promise.resolve();
    const bytes = typeof data === 'string' ? null : (data instanceof Uint8Array ? data : new Uint8Array(data));
    conn.chain = conn.chain.then(async () => {
      if (conn.stage === 'closed') return;
      try {
        conn.lastReadAt = this.now();
        if (bytes === null) await this.onText(conn, data as string);
        else this.onBinary(conn, bytes);
      } catch (error) {
        const reason = errorCode(error);
        const seat = conn.stage === 'stream' && conn.seat !== null ? this.seats[conn.seat] : null;
        if (seat && seat.connectionId === conn.id) {
          // A terminal protocol rejection must not retain an invalid header,
          // or complete packets following it, in an otherwise valid checkpoint.
          // Normal transport loss still keeps the partial packet for replay.
          this.log('rejected', { reason, stage: conn.stage, seat: conn.seat });
          this.abandon(seat, reason);
        } else this.reject(conn, reason);
      }
    });
    return conn.chain;
  }

  onClose(id: string, code = 1005, reason = ''): void {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.log('connection_end', { code, stage: conn.stage, seat: conn.seat });
    this.closeConnection(conn, code, reason, false);
  }

  onTimer(): void {
    if (this.ended) return;
    const now = this.now();
    if (this.startedAt !== null && now - this.startedAt >= this.limits.sessionMaxMs) { this.end('session_deadline'); return; }
    // With the default limits, read-idle and startup progress expire together.
    // Evaluate the connected startup barrier first: detaching an idle socket
    // would pause this deadline and incorrectly grant reconnect grace instead.
    if (this.core && this.streams) {
      this.syncPrestartClock(now);
      if (this.prestartActive() && this.prestartPausedAt === null && this.prestartProgressAt !== null
        && now - this.prestartProgressAt >= this.limits.startupProgressTimeoutMs) {
        const state = this.core.snapshot();
        this.log('startup_progress_timeout', { phase: state.phase,
          joined: state.seats.filter(row => row.joined).length,
          payloads: state.seats.filter(row => row.payloadReceived).length,
          ready: state.seats.filter(row => row.ready).length });
        this.end('startup_progress_timeout'); return;
      }
    }
    for (const conn of [...this.connections.values()]) {
      if (conn.stage === 'handshake' && now - conn.openedAt >= this.limits.handshakeTimeoutMs) this.reject(conn, 'handshake_timeout');
      else if (conn.stage === 'greeting' && now - conn.lastReadAt >= this.limits.greetingTimeoutMs) this.reject(conn, 'greeting_timeout');
      else if (conn.stage === 'stream' && now - conn.lastReadAt >= this.limits.readIdleMs) this.reject(conn, 'read_idle');
    }
    if (!this.core || !this.streams) return;
    for (const seat of this.seats) {
      if (this.ended) return;
      const view = this.core.seatByUser(seat.spec.userId)!;
      if (view.transport === 'abandoned') continue;
      if (seat.detachedAt !== null && now - seat.detachedAt >= this.limits.reconnectGraceMs) {
        this.abandon(seat, 'reconnect_grace_expired');
      } else if (view.epoch === 0 && view.transport === 'detached' && this.startedAt !== null
        && now - this.startedAt >= this.limits.joinTimeoutMs) {
        this.abandon(seat, 'join_timeout');
      }
    }
    if (this.ended || this.core.phase !== 'ticking') return;
    if (!this.clock.started) this.clock.start(now);
    if (this.clock.due(now)) {
      const queued = this.core.pendingCommandPlayers();
      const deferred: Array<{ playerId: number; cipher: Uint8Array }> = [];
      for (let i = 0; i < this.seats.length; i++) {
        const seat = this.seats[(this.core.tick + i) % this.seats.length];
        const conn = seat.connectionId ? this.connections.get(seat.connectionId) : undefined;
        if (!conn || conn.stage !== 'stream' || queued.has(seat.spec.playerId)) continue;
        const packet = seat.inner.peek();
        if (!packet || packet[0] !== 3) continue;
        if (packet.length < 4 || packet.length > MAX_COMMAND_CIPHERTEXT_BYTES + 3 || seat.packets >= this.limits.maxClientPackets) {
          this.abandon(seat, seat.packets >= this.limits.maxClientPackets ? 'packet_limit' : 'command_packet_length');
          if (this.ended) return;
          continue;
        }
        deferred.push({ playerId: seat.spec.playerId, cipher: packet.subarray(3) });
      }
      const { emission, consumed } = this.core.takeTickWithDeferred(deferred);
      for (const playerId of consumed) {
        const seat = this.seats[playerId - 1];
        seat.inner.next(); seat.packets += 1;
      }
      this.clock.markSent(now);
      this.dispatch([emission]);
      // Rotate the first seat so a busy sender cannot starve another seat.
      for (let i = 0; i < this.seats.length; i++) {
        const seat = this.seats[(this.core.tick + i) % this.seats.length];
        const conn = seat.connectionId ? this.connections.get(seat.connectionId) : undefined;
        if (!conn || conn.stage !== 'stream') continue;
        try { this.drainInput(conn, seat); }
        catch (error) { this.abandon(seat, errorCode(error)); }
        if (this.ended) return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Handshake / greeting / stream
  // -------------------------------------------------------------------------

  private async onText(conn: Connection, text: string): Promise<void> {
    if (conn.stage !== 'handshake') throw new SessionError('unexpected_text');
    const handshake = parseHandshake(text);
    if (!this.manifest || !this.core || !this.streams) throw new SessionError('manifest_missing');
    if (this.ended) throw new SessionError('battle_ended');
    const ticket = await verifyRelayTicket(handshake.ticket, this.secret, this.now());
    if (conn.stage !== 'handshake') return; // closed while verifying
    if (ticket.battleId !== this.manifest.battleId) throw new SessionError('ticket_battle_mismatch');
    const spec = this.manifest.seats[ticket.seat];
    if (!spec || spec.userId !== ticket.userId || spec.playerId !== ticket.playerId || spec.team !== ticket.team) {
      throw new SessionError('ticket_seat_mismatch');
    }
    conn.ticket = ticket;
    conn.seat = ticket.seat;
    conn.restartRequested = handshake.restart === true;
    if (handshake.greeting) {
      conn.stage = 'greeting';
      this.sendText(conn, { event: 'accepted', seat: spec.seat, playerId: spec.playerId, phase: this.core.phase });
      return;
    }
    this.bridgeResume(conn, handshake);
  }

  private onBinary(conn: Connection, bytes: Uint8Array): void {
    if (conn.stage === 'handshake') throw new SessionError('handshake_required');
    if (!this.core || !this.streams) throw new SessionError('manifest_missing');
    if (conn.stage === 'greeting') {
      if (bytes.byteLength !== GREETING_BYTES) throw new FramingError('greeting_length');
      this.handleGreeting(conn, bytes);
      return;
    }
    const seat = this.seats[conn.seat!];
    const payload = parseOuterChunkFrame(bytes);
    if (payload.byteLength === 0) {
      this.streams.acknowledgeBlock(seat.spec.playerId, seat.restart?.sentOffset);
      this.finishRestartIfCaughtUp(conn, seat);
      return;
    }
    seat.inner.push(payload);
    this.drainInput(conn, seat);
    if (conn.stage !== 'stream') return;
    // Keep at most one inner-packet-sized window per seat. A compound outer
    // chunk may exceed it during congestion: acknowledge only its accepted
    // prefix, then use normal offset-based resume for the untouched tail.
    const unaccepted = Math.max(0, seat.inner.pendingBytes - MAX_INNER_BYTES);
    seat.inner.retainPrefix(MAX_INNER_BYTES);
    const validation = new InnerPacketBuffer(); validation.push(seat.inner.checkpoint());
    while (validation.next() !== null) { /* keep the committed buffer restorable */ }
    const acks = seat.client.noteReceived(payload.byteLength - unaccepted);
    for (let i = 0; i < acks; i++) conn.transport.sendBinary(ACK_CHUNK);
    if (unaccepted) {
      this.log('input_backpressure', { seat: seat.spec.seat, unaccepted_bytes: unaccepted });
      this.closeConnection(conn, CLOSE_BACKPRESSURE, 'input_backpressure');
    }
  }

  private drainInput(conn: Connection, seat: SeatState): void {
    if (!this.core || conn.stage !== 'stream') return;
    let packet: Uint8Array | null;
    while ((packet = seat.inner.peek()) !== null) {
      if (seat.restart) {
        this.restartInput(conn, seat, packet);
        seat.inner.next();
        continue;
      }
      if (packet[0] === 3 && this.core.phase === 'ticking' && !this.core.canQueueCommand(packet)) return;
      if (seat.packets >= this.limits.maxClientPackets) throw new SessionError('packet_limit');
      seat.packets += 1;
      let result;
      try {
        result = this.core.handleClientPacket(conn.id, conn.epoch, packet);
      } catch (error) {
        // Especially kind 6: preserve the rejection, but identify the native
        // boundary reached without recording identity, ticket or payload.
        this.log('client_packet_rejected', { kind: packet[0], total: packet.byteLength,
          seat: seat.spec.seat, player_id: seat.spec.playerId, epoch: conn.epoch,
          phase: this.core.phase, relay_tick: this.core.tick, reason: errorCode(error) });
        throw error;
      }
      seat.inner.next(); // consume only after the command was accepted
      if (packet[0] === 0 || packet[0] === 1 || packet[0] === 5) this.recordPrestartProgress(this.now());
      for (const note of result.notes) {
        if (note.event === 'tick_checksums_observed') {
          this.log(note.event, { ...note, seat: seat.spec.seat, player_id: seat.spec.playerId,
            epoch: conn.epoch, phase: this.core.phase, relay_tick: this.core.tick,
            packet_ordinal: seat.checksumPackets, word_ordinal: seat.checksumWords,
            native_tick_mapping_verified: false });
          seat.checksumPackets += 1;
          seat.checksumWords += Number(note.count);
        } else this.log(note.event, { ...note, seat: seat.spec.seat });
      }
      if (packet[0] === 0 || packet[0] === 1 || packet[0] === 5) {
        const state = this.core.snapshot();
        this.log('native_start_barrier', { kind: packet[0], seat: seat.spec.seat,
          player_id: seat.spec.playerId, epoch: conn.epoch, phase: state.phase,
          relay_tick: state.tick, human_seats: state.seats.length,
          expected_players: this.core.manifest.expectedPlayers,
          joined: state.seats.filter(row => row.joined).length,
          payloads: state.seats.filter(row => row.payloadReceived).length,
          ready: state.seats.filter(row => row.ready).length });
      }
      this.log('client_packet', { kind: packet[0], total: packet.byteLength, seat: seat.spec.seat, phase: this.core.phase });
      this.dispatch(result.emissions);
      if (conn.stage !== 'stream') return;
    }
  }

  private sendRestartRange(conn: Connection, seat: SeatState, end: number): void {
    const restart = seat.restart!;
    for (const bytes of this.streams!.rangeChunks(seat.spec.playerId, restart.sentOffset, end)) {
      conn.transport.sendBinary(streamChunk(bytes));
    }
    restart.sentOffset = end;
  }

  private restartInput(conn: Connection, seat: SeatState, packet: Uint8Array): void {
    const restart = seat.restart!;
    if (seat.packets >= this.limits.maxClientPackets) throw new SessionError('packet_limit');
    seat.packets += 1;
    if (packet[0] === 4 && packet.length === 3) return;
    if (restart.stage === 'join' && packet[0] === 0) {
      authorizeGameJoin(this.manifest!, seat.spec.userId, packet);
      restart.stage = 'payload';
      this.sendRestartRange(conn, seat, restart.confirmEnd);
    } else if (restart.stage === 'payload' && packet[0] === 1) {
      validateRestartPayload(this.streams!.history(seat.spec.playerId), restart, seat.spec.playerId, packet);
      restart.stage = 'ready';
      this.sendRestartRange(conn, seat, restart.readyEnd);
    } else if (restart.stage === 'ready' && packet[0] === 5) {
      validateReadyPacket(packet);
      restart.stage = 'catchup';
      restart.targetOffset = this.streams!.streamLength(seat.spec.playerId);
      this.sendBattlePhase(conn);
      this.sendRestartRange(conn, seat, restart.targetOffset);
      this.finishRestartIfCaughtUp(conn, seat);
    } else if (restart.stage === 'catchup' && (packet[0] === 3 || packet[0] === 7)) {
      // Replayed simulation frames must not submit old commands a second time.
      // The seat remains fenced until the new process has received the backlog.
      this.finishRestartIfCaughtUp(conn, seat);
    } else {
      throw new SessionError('restart_packet_order');
    }
  }

  private finishRestartIfCaughtUp(conn: Connection, seat: SeatState): void {
    const restart = seat.restart;
    if (!restart || restart.stage !== 'catchup'
      || this.streams!.ackedBytes(seat.spec.playerId) < restart.targetOffset - 999) return;
    seat.restart = null;
    this.dispatch(this.core!.finishResume(conn.id, conn.epoch));
    this.log('process_restart_replayed', {seat: seat.spec.seat, player_id: seat.spec.playerId,
      tick: this.core!.tick, replayed_stream_bytes: restart.sentOffset});
  }

  private handleGreeting(conn: Connection, bytes: Uint8Array): void {
    const core = this.core!, streams = this.streams!;
    const handshake = conn.ticket!;
    const seat = this.seats[conn.seat!];
    const greeting = parseGreeting(bytes);
    const view = core.seatByUser(seat.spec.userId)!;
    const now = this.now();
    if (!greeting.reconnect && greeting.receivedOffset === 0) {
      if (view.epoch !== 0 && conn.restartRequested) {
        if (core.phase !== 'ticking') throw new SessionError('restart_battle_not_running');
        const plan = restartPlan(streams.history(seat.spec.playerId), seat.spec.playerId);
        this.supersede(seat, conn);
        const epoch = this.beginResume(seat, conn, 0);
        streams.beginFreshProcess(seat.spec.playerId);
        seat.client = new ClientStreamAccounting(); seat.inner.clear();
        seat.restart = plan;
        seat.greetingIdentity = greeting.identity; seat.lastAttempt = greeting.attempt;
        this.admitResume(seat, conn, epoch);
        conn.transport.sendBinary(greetingReply(0));
        this.sendRestartRange(conn, seat, plan.versionEnd);
        this.log('process_restart_started', {seat: seat.spec.seat, player_id: seat.spec.playerId, tick: core.tick});
        return;
      }
      // Fresh transport: only a seat that was never attached may take it.
      if (view.epoch !== 0 || view.transport !== 'detached') throw new RelayCoreError('seat_already_attached');
      const emissions = core.connect(seat.spec.userId, conn.id);
      seat.greetingIdentity = greeting.identity;
      seat.lastAttempt = greeting.attempt;
      seat.connectionId = conn.id;
      seat.detachedAt = null;
      conn.epoch = 0;
      conn.stage = 'stream';
      if (this.startedAt === null) this.startedAt = now;
      this.syncPrestartClock(now);
      this.log('careconn_greeting', { reconnect: false, seat: seat.spec.seat, player_id: handshake.playerId });
      conn.transport.sendBinary(greetingReply(0));
      this.dispatch(emissions);
      return;
    }
    // CAReconn resume initiated by the game (new TCP connection, reconnect flag set).
    if (!greeting.reconnect) throw new SessionError('resume_flag_required');
    if (!seat.greetingIdentity) throw new SessionError('resume_without_session');
    if (!equalBytes(seat.greetingIdentity, greeting.identity)) throw new SessionError('resume_identity_mismatch');
    if (greeting.attempt <= seat.lastAttempt) throw new SessionError('resume_attempt_stale');
    // The game only reconnects after its previous socket died; a lingering
    // transport for this seat (close not yet observed) is superseded first.
    this.supersede(seat, conn);
    if (core.seatByUser(seat.spec.userId)!.epoch === 0) throw new SessionError('resume_without_session');
    const epoch = this.beginResume(seat, conn, greeting.receivedOffset);
    let chunks: Uint8Array[];
    try { chunks = streams.resumeChunks(seat.spec.playerId, greeting.receivedOffset, true, seat.restart?.sentOffset); } catch (error) {
      core.abortResume(conn.id, epoch);
      throw error;
    }
    seat.lastAttempt = greeting.attempt;
    this.admitResume(seat, conn, epoch);
    seat.client.acknowledgeResume();
    conn.transport.sendBinary(greetingReply(seat.client.received));
    let replayed = 0;
    for (const chunk of chunks) { conn.transport.sendBinary(streamChunk(chunk)); replayed += chunk.byteLength; }
    this.log('transport_resumed', { mode: 'careconn', seat: seat.spec.seat, resumes: seat.resumes, replayed_stream_bytes: replayed,
      client_stream_ack: seat.client.received, tick: core.tick, cpu_takeover: false });
    if (!seat.restart) this.dispatch(core.finishResume(conn.id, epoch));
    this.syncPrestartClock(now);
    this.drainInput(conn, seat);
    if (this.clock.started) this.clock.resume(now);
  }

  /** Bridge-side WebSocket resume while the game's TCP connection stayed open. */
  private bridgeResume(conn: Connection, handshake: Handshake): void {
    const core = this.core!, streams = this.streams!;
    const seat = this.seats[conn.seat!];
    if (handshake.clientOffset < seat.client.received) throw new SessionError('client_offset_behind');
    // The bridge only resumes after its WebSocket died; the relay may not have
    // observed that close yet, so the lingering transport is superseded first.
    this.supersede(seat, conn);
    if (core.seatByUser(seat.spec.userId)!.epoch === 0) throw new SessionError('resume_without_session');
    const epoch = this.beginResume(seat, conn, handshake.resumeOffset);
    let chunks: Uint8Array[];
    try { chunks = streams.resumeChunks(seat.spec.playerId, handshake.resumeOffset, false, seat.restart?.sentOffset); } catch (error) {
      core.abortResume(conn.id, epoch);
      throw error;
    }
    this.admitResume(seat, conn, epoch);
    this.sendText(conn, { event: 'resumed', seat: seat.spec.seat, playerId: seat.spec.playerId, clientReceived: seat.client.received,
      serverOffset: handshake.resumeOffset, streamLength: streams.streamLength(seat.spec.playerId), phase: core.phase });
    if (core.phase === 'ticking') this.sendBattlePhase(conn);
    let replayed = 0;
    for (const chunk of chunks) { conn.transport.sendBinary(streamChunk(chunk)); replayed += chunk.byteLength; }
    this.log('transport_resumed', { mode: 'bridge', seat: seat.spec.seat, resumes: seat.resumes, replayed_stream_bytes: replayed,
      client_stream_ack: seat.client.received, tick: core.tick, cpu_takeover: false });
    if (!seat.restart) this.dispatch(core.finishResume(conn.id, epoch));
    this.syncPrestartClock(this.now());
    this.drainInput(conn, seat);
    if (this.clock.started) this.clock.resume(this.now());
  }

  /** A newer authenticated transport for the seat replaces a lingering one. */
  private supersede(seat: SeatState, conn: Connection): void {
    if (seat.connectionId && seat.connectionId !== conn.id) {
      const old = this.connections.get(seat.connectionId);
      if (old) this.closeConnection(old, CLOSE_SUPERSEDED, 'superseded');
      seat.connectionId = null;
    }
  }

  private beginResume(seat: SeatState, conn: Connection, offset: number): number {
    const now = this.now();
    if (seat.resumes >= this.limits.maxResumesPerSeat) throw new SessionError('resume_limit');
    if (seat.detachedAt !== null && now - seat.detachedAt > this.limits.reconnectGraceMs) {
      this.abandon(seat, 'resume_grace_expired');
      throw new SessionError('resume_grace_expired');
    }
    if (!Number.isSafeInteger(offset) || offset < 0) throw new StreamError('resume_offset_out_of_range');
    return this.core!.beginResume(seat.spec.userId, conn.id);
  }

  private admitResume(seat: SeatState, conn: Connection, epoch: number): void {
    seat.resumes += 1;
    seat.detachedAt = null;
    seat.connectionId = conn.id;
    conn.epoch = epoch;
    conn.stage = 'stream';
  }

  // -------------------------------------------------------------------------
  // Emission delivery and stream retention
  // -------------------------------------------------------------------------

  /** Append every emission to its target streams (all-or-nothing per emission) and push chunks to connected seats. */
  private dispatch(emissions: RelayEmission[]): void {
    const core = this.core, streams = this.streams;
    if (!core || !streams || this.ended) return;
    const queue = [...emissions];
    while (queue.length) {
      const emission = queue.shift()!;
      if (this.ended) return;
      const targets = emission.playerIds.filter(playerId => core.activePlayerIds().includes(playerId));
      if (targets.length === 0) continue;
      const connected = new Set<number>();
      for (const seat of this.seats) if (!seat.restart && seat.connectionId && this.connections.get(seat.connectionId)?.stage === 'stream') connected.add(seat.spec.playerId);
      let appended: Map<number, [number, number]> | null = null;
      // Flow control: a connected seat that stops acknowledging is closed
      // (it may CAReconn-resume); a seat beyond the retention cap is abandoned.
      for (let attempt = 0; attempt < this.seats.length + 1 && appended === null; attempt++) {
        const live = targets.filter(playerId => core.activePlayerIds().includes(playerId));
        if (live.length === 0) break;
        try {
          const restarting = new Set(this.seats.filter(seat => seat.restart).map(seat => seat.spec.playerId));
          appended = streams.append({ playerIds: live, packet: emission.packet }, {
            windowFor: connected, protectBeginningFor: restarting,
          });
        } catch (error) {
          if (!(error instanceof StreamError)) throw error;
          const offenders = live.filter(playerId => streams.wouldExceedWindow(playerId, emission.packet.byteLength));
          if (error.code === 'server_stream_window' && offenders.length) {
            for (const playerId of offenders) {
              const seat = this.seats[playerId - 1];
              const conn = seat.connectionId ? this.connections.get(seat.connectionId) : undefined;
              if (conn) { this.reject(conn, 'server_stream_window'); connected.delete(playerId); }
              else connected.delete(playerId);
            }
            continue;
          }
          if (error.code === 'server_stream_retention_limit') {
            // A peer retaining its initial history may be able to prune safely.
            // Retire only the stream whose preflight actually failed.
            if (error.playerId === undefined || !live.includes(error.playerId)) throw error;
            this.abandon(this.seats[error.playerId - 1], 'server_stream_retention_limit');
            if (this.ended) return;
            continue;
          }
          throw error;
        }
      }
      if (!appended) continue;
      if (emission.event === 'game_ticking' && !this.clock.started) {
        this.clock.start(this.now());
        // This control note is emitted only after RelayCore's authenticated
        // all-seat READY barrier produced GAME_TICKING.  Companions use it as
        // server authority to advance their local durable result lifecycle;
        // the native binary packet remains the gameplay wire authority.
        for (const playerId of appended.keys()) {
          const seat = this.seats[playerId - 1];
          const conn = seat.connectionId ? this.connections.get(seat.connectionId) : undefined;
          if (conn && conn.stage === 'stream') this.sendBattlePhase(conn);
        }
      }
      this.log(emission.event, { tick: emission.tick, stream_bytes: emission.packet.byteLength, targets: [...appended.keys()] });
      const chunk = streamChunk(emission.packet);
      for (const playerId of appended.keys()) {
        const seat = this.seats[playerId - 1];
        const conn = seat.connectionId ? this.connections.get(seat.connectionId) : undefined;
        if (conn && conn.stage === 'stream') {
          if (seat.restart) {
            if (seat.restart.stage === 'catchup') this.sendRestartRange(conn, seat, streams.streamLength(playerId));
          } else conn.transport.sendBinary(chunk);
        }
      }
    }
  }

  private abandon(seat: SeatState, reason: string): void {
    const core = this.core!;
    seat.restart = null;
    seat.inner.clear();
    const conn = seat.connectionId ? this.connections.get(seat.connectionId) : undefined;
    if (conn) this.closeConnection(conn, CLOSE_REJECTED, reason);
    seat.detachedAt = null;
    seat.connectionId = null;
    this.streams?.release(seat.spec.playerId);
    try { core.abandon(seat.spec.userId); } catch (error) { if (errorCode(error) !== 'battle_ended') throw error; }
    this.log('seat_abandoned', { seat: seat.spec.seat, reason, tick: core.tick, cpu_takeover: false });
    if (core.phase === 'ended') this.end(core.endReason ?? reason);
  }

  private reject(conn: Connection, code: string): void {
    if (conn.stage === 'closed') return;
    this.log('rejected', { reason: code, stage: conn.stage, seat: conn.seat });
    this.closeConnection(conn, CLOSE_REJECTED, code);
  }

  private closeConnection(conn: Connection, code: number, reason: string, sendClose = true): void {
    if (conn.stage === 'closed') return;
    const stage = conn.stage;
    conn.stage = 'closed';
    this.connections.delete(conn.id);
    if (sendClose) { try { conn.transport.close(code, reason); } catch { /* transport already gone */ } }
    const core = this.core;
    if (conn.seat !== null && core && stage === 'stream') {
      const seat = this.seats[conn.seat];
      if (seat.connectionId === conn.id) {
        seat.connectionId = null;
        if (!this.ended && core.seatByConnection(conn.id)?.transport !== 'abandoned') seat.detachedAt = this.now();
      }
      if (!this.ended && core.phase !== 'ended') {
        const view = core.seatByConnection(conn.id);
        if (view && (view.transport === 'connected' || view.transport === 'resuming')) {
          this.log('transport_detached', { seat: conn.seat, tick: core.tick, reconnect_grace_ms: this.limits.reconnectGraceMs, cpu_takeover: false });
          this.dispatch(core.detach(conn.id));
          this.syncPrestartClock(this.now());
        }
      }
    }
  }

  private sendText(conn: Connection, value: Record<string, unknown>): void {
    conn.transport.sendText(JSON.stringify(value));
  }

  private sendBattlePhase(conn: Connection): void {
    this.sendText(conn, { event: 'battle_phase', battleId: this.manifest!.battleId,
      phase: 'ticking', tick: 0 });
  }

  private log(event: string, fields: Record<string, unknown>): void {
    const row = { event, at: this.now(), ...fields } as RelayNote & { at: number };
    this.events.push(row);
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
    this.logger?.(event, fields);
  }
}
