/**
 * Deterministic control coordination for an ALREADY STARTED native battle.
 * This module neither starts TWA nor runs AI, transfers units, or restores HP/ammo.
 * Only a trusted relay may report connection events; reconnect identities must
 * already be authenticated. Only the native adapter may acknowledge directives.
 * A returned CPU directive means requested, never applied, until acknowledged.
 *
 * The host must call advance() each authoritative tick, apply/acknowledge returned
 * directives, and persist an event ledger plus native snapshots for restart-safe
 * recovery. This in-memory prototype has no checkpoint/import or crash recovery.
 * The adapter must reject queued directives below each seat's latest epoch and
 * apply control changes at the specified authoritative tick, including CPU fences
 * that cancel a player handover whose acknowledgement may still be in flight.
 */
export interface BattleClock { nowMs: number; tick: number }
export interface BattleRosterSeat {
  seatId: string;
  userId: string;
  commanderId: string;
  faction: string;
  connectionId: string;
}
export interface PresenceOptions { heartbeatTimeoutMs?: number; reservationMs?: number }
type Phase = 'connected' | 'disconnected' | 'synchronizing' | 'handover_pending' | 'expired' | 'banned' | 'ended';

interface DirectiveBase { seatId: string; userId: string; epoch: number; tick: number }
export type PresenceDirective =
  | (DirectiveBase & { kind: 'cpu_takeover'; reason: 'connection_lost' | 'heartbeat_timeout' | 'voluntary_leave' | 'banned' | 'reservation_expired' })
  | (DirectiveBase & { kind: 'synchronize'; connectionId: string; snapshotSource: 'current_battle' })
  | (DirectiveBase & { kind: 'player_handover'; connectionId: string; snapshotId: string; snapshotTick: number });

export type AdapterAcknowledgement =
  | { kind: 'cpu_applied'; seatId: string; epoch: number; tick: number }
  | { kind: 'synchronized'; seatId: string; userId: string; connectionId: string; epoch: number; snapshotId: string; snapshotTick: number }
  | { kind: 'player_applied'; seatId: string; userId: string; connectionId: string; epoch: number; tick: number; snapshotId: string };

export interface PresenceResult { ok: boolean; error?: string; directives: PresenceDirective[] }
export interface BattleSeatState {
  seatId: string;
  userId: string;
  commanderId: string;
  faction: string;
  connectionId: string | null;
  phase: Phase;
  /** unconfirmed means no adapter has confirmed the requested CPU controller. */
  controller: 'player' | 'cpu' | 'unconfirmed' | 'none';
  epoch: number;
  lastHeartbeatAt: number;
  reservedUntil: number | null;
  controlSinceTick: number;
  pending: PresenceDirective | null;
}

function nonempty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new TypeError(`invalid_${field}`);
}
function safe(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`invalid_${field}`);
}
function success(...directives: PresenceDirective[]): PresenceResult { return { ok: true, directives }; }
function reject(error: string, ...directives: PresenceDirective[]): PresenceResult { return { ok: false, error, directives }; }

export class BattlePresence {
  private readonly seats: BattleSeatState[];
  private readonly usedConnections = new Set<string>();
  private readonly heartbeatTimeoutMs: number;
  private readonly reservationMs: number;
  private clock: BattleClock;
  private ended = false;

  /** Initial connections must already own their seats in the running battle. */
  constructor(roster: BattleRosterSeat[], initialClock: BattleClock, options: PresenceOptions = {}) {
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
    this.reservationMs = options.reservationMs ?? 180_000;
    safe(this.heartbeatTimeoutMs, 'heartbeat_timeout', 1);
    safe(this.reservationMs, 'reservation', 1);
    this.validateClock(initialClock);
    this.clock = { ...initialClock };
    if (!Array.isArray(roster) || roster.length < 1 || roster.length > 20) throw new RangeError('invalid_roster_size');
    const seatIds = new Set<string>();
    const userIds = new Set<string>();
    this.seats = roster.map(entry => {
      for (const field of ['seatId', 'userId', 'commanderId', 'faction', 'connectionId'] as const) nonempty(entry[field], field);
      if (!/^[1-9][0-9]{0,19}$/.test(entry.commanderId) || BigInt(entry.commanderId) >= 2n ** 64n) throw new TypeError('invalid_commander_id');
      if (seatIds.has(entry.seatId) || userIds.has(entry.userId) || this.usedConnections.has(entry.connectionId)) throw new TypeError('duplicate_roster_identity');
      seatIds.add(entry.seatId); userIds.add(entry.userId); this.usedConnections.add(entry.connectionId);
      return { ...entry, phase: 'connected', controller: 'player', epoch: 0,
        lastHeartbeatAt: initialClock.nowMs, reservedUntil: null,
        controlSinceTick: initialClock.tick, pending: null };
    });
  }

  /** A defensive copy for trusted server code, not a public player-facing API. */
  getState(): { ended: boolean; clock: BattleClock; seats: BattleSeatState[] } {
    return structuredClone({ ended: this.ended, clock: this.clock, seats: this.seats });
  }

  /** Heartbeats never reconnect a retired connection or cancel CPU takeover. */
  heartbeat(connectionId: string, clock: BattleClock): PresenceResult {
    nonempty(connectionId, 'connection_id');
    this.moveClock(clock);
    if (this.ended) return reject('battle_ended');
    const seat = this.seats.find(entry => entry.connectionId === connectionId);
    if (!seat) return reject('connection_not_current');
    const expired = this.expire(seat);
    if (!seat.connectionId) return reject('reservation_expired', ...expired);
    if (clock.nowMs - seat.lastHeartbeatAt >= this.heartbeatTimeoutMs) {
      return reject('heartbeat_timeout', ...this.lose(seat, 'heartbeat_timeout'));
    }
    seat.lastHeartbeatAt = clock.nowMs;
    return success();
  }

  disconnect(connectionId: string, clock: BattleClock, reason: 'connection_lost' | 'voluntary_leave' = 'connection_lost'): PresenceResult {
    nonempty(connectionId, 'connection_id');
    if (reason !== 'connection_lost' && reason !== 'voluntary_leave') throw new TypeError('invalid_disconnect_reason');
    this.moveClock(clock);
    if (this.ended) return reject('battle_ended');
    const seat = this.seats.find(entry => entry.connectionId === connectionId);
    if (!seat) return reject('connection_not_current');
    const expired = this.expire(seat);
    if (!seat.connectionId) return reject('reservation_expired', ...expired);
    return success(...this.lose(seat, reason));
  }

  /** Process all due timeouts; there is no wall-clock timer hidden in this class. */
  advance(clock: BattleClock): PresenceResult {
    this.moveClock(clock);
    if (this.ended) return reject('battle_ended');
    const directives: PresenceDirective[] = [];
    for (const seat of this.seats) {
      directives.push(...this.expire(seat));
      if (seat.connectionId && clock.nowMs - seat.lastHeartbeatAt >= this.heartbeatTimeoutMs) {
        directives.push(...this.lose(seat, 'heartbeat_timeout'));
      }
    }
    return success(...directives);
  }

  /** verifiedUserId must come from validated account/session state, never a body field. */
  reconnect(verifiedUserId: string, connectionId: string, clock: BattleClock): PresenceResult {
    nonempty(verifiedUserId, 'user_id'); nonempty(connectionId, 'connection_id');
    this.moveClock(clock);
    if (this.ended) return reject('battle_ended');
    const seat = this.seats.find(entry => entry.userId === verifiedUserId);
    if (!seat) return reject('not_in_battle_roster');
    const expired = this.expire(seat);
    if (seat.phase === 'banned') return reject('participant_banned');
    if (seat.phase === 'expired') return reject('reservation_expired', ...expired);
    if (this.usedConnections.has(connectionId)) return reject('connection_id_reused');
    if (seat.phase === 'connected') return reject('already_connected');
    if (seat.phase !== 'disconnected') return reject('reconnect_in_progress');
    if (seat.controller !== 'cpu') return reject('cpu_takeover_unconfirmed');
    this.usedConnections.add(connectionId);
    seat.connectionId = connectionId;
    seat.lastHeartbeatAt = clock.nowMs;
    seat.epoch++;
    seat.phase = 'synchronizing';
    // Reconnect retries intentionally do not extend reservedUntil.
    seat.pending = { kind: 'synchronize', seatId: seat.seatId, userId: seat.userId,
      connectionId, epoch: seat.epoch, tick: clock.tick, snapshotSource: 'current_battle' };
    return success(structuredClone(seat.pending));
  }

  /** Only a trusted native adapter can attest state synchronization or applied control. */
  acknowledge(ack: AdapterAcknowledgement, clock: BattleClock): PresenceResult {
    nonempty(ack.seatId, 'seat_id'); safe(ack.epoch, 'epoch');
    if (ack.kind === 'synchronized') {
      nonempty(ack.snapshotId, 'snapshot_id'); safe(ack.snapshotTick, 'snapshot_tick');
    } else if (ack.kind === 'cpu_applied' || ack.kind === 'player_applied') safe(ack.tick, 'ack_tick');
    else throw new TypeError('invalid_ack_kind');
    this.moveClock(clock);
    if (this.ended) return reject('battle_ended');
    const seat = this.seats.find(entry => entry.seatId === ack.seatId);
    if (!seat) return reject('unknown_seat');
    const expired = this.expire(seat);
    if (expired.length) return reject('reservation_expired', ...expired);
    if (seat.connectionId && clock.nowMs - seat.lastHeartbeatAt >= this.heartbeatTimeoutMs) {
      return reject('heartbeat_timeout', ...this.lose(seat, 'heartbeat_timeout'));
    }
    const pending = seat.pending;
    if (!pending || ack.epoch !== seat.epoch || ack.epoch !== pending.epoch) return reject('stale_acknowledgement');
    if (ack.kind === 'cpu_applied') {
      if (pending.kind !== 'cpu_takeover') return reject('unexpected_acknowledgement');
      if (ack.tick !== pending.tick || ack.tick > clock.tick) return reject('invalid_applied_tick');
      seat.controller = 'cpu'; seat.controlSinceTick = ack.tick; seat.pending = null;
      return success();
    }
    if (seat.phase === 'expired' || seat.phase === 'banned') return reject('resume_not_allowed');
    if (ack.userId !== seat.userId || ack.connectionId !== seat.connectionId) return reject('ack_identity_mismatch');
    if (ack.kind === 'synchronized') {
      if (pending.kind !== 'synchronize' || seat.phase !== 'synchronizing') return reject('unexpected_acknowledgement');
      if (ack.snapshotTick < pending.tick || ack.snapshotTick > clock.tick) return reject('invalid_snapshot_tick');
      seat.phase = 'handover_pending';
      seat.pending = { kind: 'player_handover', seatId: seat.seatId, userId: seat.userId,
        connectionId: ack.connectionId, epoch: seat.epoch, tick: clock.tick + 1,
        snapshotId: ack.snapshotId, snapshotTick: ack.snapshotTick };
      return success(structuredClone(seat.pending));
    }
    if (pending.kind !== 'player_handover' || seat.phase !== 'handover_pending') return reject('unexpected_acknowledgement');
    if (ack.tick !== pending.tick || ack.tick > clock.tick || ack.snapshotId !== pending.snapshotId) return reject('invalid_handover_acknowledgement');
    seat.controller = 'player'; seat.phase = 'connected'; seat.controlSinceTick = ack.tick;
    seat.reservedUntil = null; seat.pending = null;
    return success();
  }

  /** Guard for a trusted command relay; command payload/sequence validation is separate. */
  canAcceptCommand(userId: string, connectionId: string, epoch: number, tick: number): boolean {
    if (this.ended || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(tick) || tick !== this.clock.tick) return false;
    return this.seats.some(seat => seat.userId === userId && seat.connectionId === connectionId &&
      seat.phase === 'connected' && seat.controller === 'player' && seat.epoch === epoch && tick >= seat.controlSinceTick &&
      this.clock.nowMs - seat.lastHeartbeatAt < this.heartbeatTimeoutMs);
  }

  /** Administrative ban is trusted input. It never permits another user to claim this seat. */
  ban(userId: string, clock: BattleClock): PresenceResult {
    nonempty(userId, 'user_id'); this.moveClock(clock);
    if (this.ended) return reject('battle_ended');
    const seat = this.seats.find(entry => entry.userId === userId);
    if (!seat) return reject('not_in_battle_roster');
    const directives = seat.controller === 'player' || seat.phase === 'handover_pending' ? this.lose(seat, 'banned') : [];
    if (seat.pending?.kind !== 'cpu_takeover') { seat.epoch++; seat.pending = null; }
    seat.phase = 'banned'; seat.connectionId = null; seat.reservedUntil = null;
    return success(...directives);
  }

  end(clock: BattleClock): PresenceResult {
    this.moveClock(clock); this.ended = true;
    for (const seat of this.seats) {
      seat.epoch++; seat.phase = 'ended'; seat.controller = 'none'; seat.connectionId = null;
      seat.pending = null; seat.reservedUntil = null;
    }
    return success();
  }

  private lose(seat: BattleSeatState, reason: 'connection_lost' | 'heartbeat_timeout' | 'voluntary_leave' | 'banned' | 'reservation_expired'): PresenceDirective[] {
    const wasConnected = seat.phase === 'connected';
    // A handover may already be applied while its acknowledgement is in flight.
    // Canceling it requires a new CPU epoch, not merely dropping the pending ack.
    const mustFenceHandover = seat.phase === 'handover_pending';
    seat.connectionId = null; seat.phase = 'disconnected'; seat.epoch++;
    if (wasConnected) {
      // A delayed explicit disconnect must not reset a heartbeat deadline that
      // has already passed merely because advance() has not run yet this tick.
      const lostAt = Math.min(this.clock.nowMs, seat.lastHeartbeatAt + this.heartbeatTimeoutMs);
      seat.reservedUntil = lostAt + this.reservationMs;
    }
    if (seat.reservedUntil !== null && this.clock.nowMs >= seat.reservedUntil) seat.phase = 'expired';
    seat.pending = null;
    if (seat.controller === 'cpu' && !mustFenceHandover) return [];
    seat.controller = 'unconfirmed';
    seat.pending = { kind: 'cpu_takeover', seatId: seat.seatId, userId: seat.userId,
      epoch: seat.epoch, tick: this.clock.tick + 1, reason };
    return [structuredClone(seat.pending)];
  }

  private expire(seat: BattleSeatState): PresenceDirective[] {
    if (seat.reservedUntil === null || this.clock.nowMs < seat.reservedUntil || seat.phase === 'expired') return [];
    const directives = seat.phase === 'handover_pending' ? this.lose(seat, 'reservation_expired') : [];
    seat.phase = 'expired'; seat.connectionId = null;
    // An unconfirmed CPU directive must remain acknowledgeable after the seat reservation
    // expires; player synchronization/handover is canceled and can never revive the seat.
    if (seat.pending?.kind !== 'cpu_takeover') { seat.epoch++; seat.pending = null; }
    return directives;
  }

  private validateClock(clock: BattleClock): void {
    safe(clock.nowMs, 'time'); safe(clock.tick, 'tick');
    if (clock.nowMs > Number.MAX_SAFE_INTEGER - this.reservationMs || clock.tick >= Number.MAX_SAFE_INTEGER) throw new RangeError('clock_overflow');
  }

  private moveClock(clock: BattleClock): void {
    this.validateClock(clock);
    if (clock.nowMs < this.clock.nowMs || clock.tick < this.clock.tick) throw new RangeError('clock_regression');
    this.clock = { ...clock };
  }
}
