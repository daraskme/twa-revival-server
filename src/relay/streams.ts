/**
 * Retained per-seat server streams with CAReconn ack/flow control, ported
 * from server/native_pvp_adapter_contract.py TwoPlayerRetainedStreams and the
 * client-stream bookkeeping of native_battle_probe.BattleSession.
 *
 * Every emission is appended to each target seat's stream even while that
 * seat is detached, so a CAReconn resume (or a bridge-side WebSocket resume)
 * can replay the exact unreceived tail from an absolute offset. Bytes below a
 * seat's acknowledged offset can never be requested again (resume offsets must
 * be >= acked), so they are pruned from memory; offsets stay absolute.
 */
import { CA_RECONN_ACK_BLOCK_BYTES, concat } from './framing';

export { CA_RECONN_ACK_BLOCK_BYTES };
export const MAX_RETAINED_SERVER_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_UNACKNOWLEDGED_SERVER_STREAM_BYTES = 25_000;
export const MAX_REPLAY_CHUNK_BYTES = 16_384;

export class StreamError extends Error {
  constructor(public readonly code: string, public readonly playerId?: number) {
    super(code);
    this.name = 'StreamError';
  }
}

export interface StreamEmission {
  playerIds: readonly number[];
  packet: Uint8Array;
}

class SeatStream {
  retainBeginning = false;
  /** Absolute offset of the first retained byte (everything below was acked). */
  base = 0;
  /** Absolute length of the logical stream. */
  length = 0;
  acked = 0;
  reportedReceived = 0;
  segments: Uint8Array[] = [];

  retainedBytes(): number { return this.length - this.base; }

  append(packet: Uint8Array): void {
    this.segments.push(packet);
    this.length += packet.byteLength;
  }

  prune(): void {
    if (this.retainBeginning) return;
    // Drop whole segments that lie entirely below the acknowledged offset.
    while (this.segments.length && this.base + this.segments[0].byteLength <= this.acked) {
      this.base += this.segments[0].byteLength;
      this.segments.shift();
    }
  }

  slice(from: number, to: number): Uint8Array {
    if (from < this.base || to > this.length || from > to) throw new StreamError('resume_offset_out_of_range');
    const parts: Uint8Array[] = [];
    let cursor = this.base;
    for (const segment of this.segments) {
      const segmentEnd = cursor + segment.byteLength;
      if (segmentEnd > from && cursor < to) {
        parts.push(segment.subarray(Math.max(from, cursor) - cursor, Math.min(to, segmentEnd) - cursor));
      }
      cursor = segmentEnd;
      if (cursor >= to) break;
    }
    return concat(...parts);
  }

  clear(): void {
    this.segments = [];
    this.base = 0;
    this.length = 0;
    this.acked = 0;
    this.reportedReceived = 0;
  }
}

export interface AppendOptions {
  /**
   * Seats whose unacknowledged window (25 000 bytes) must be enforced. When
   * omitted the window applies to every target, exactly like the Python
   * contract. The relay session passes the currently connected seats so a
   * detached seat accumulates up to the retention cap during its grace period
   * instead of failing the whole broadcast.
   */
  windowFor?: ReadonlySet<number>;
  /** Pending process restarts still require their initial JOIN/READY bytes. */
  protectBeginningFor?: ReadonlySet<number>;
}

export interface StreamCheckpoint {
  playerId: number;
  base: number;
  length: number;
  acked: number;
  reportedReceived: number;
  segments: Uint8Array[];
  retainBeginning?: boolean;
}

export class RetainedStreams {
  private readonly streams = new Map<number, SeatStream>();

  constructor(playerIds: readonly number[], retainBeginning = false) {
    if (!Array.isArray(playerIds) || playerIds.length < 1 || playerIds.length > 20) throw new StreamError('invalid_stream_roster');
    for (const playerId of playerIds) {
      if (!Number.isInteger(playerId) || playerId < 1 || playerId > 20 || this.streams.has(playerId)) throw new StreamError('invalid_stream_roster');
      const stream = new SeatStream();
      stream.retainBeginning = retainBeginning;
      this.streams.set(playerId, stream);
    }
  }

  get playerIds(): number[] { return [...this.streams.keys()].sort((a, b) => a - b); }

  /** The serialized owner holds its event queue until persistence completes. */
  checkpoint(): StreamCheckpoint[] {
    return this.playerIds.map(playerId => {
      const stream = this.require(playerId);
      return { playerId, base: stream.base, length: stream.length, acked: stream.acked,
        reportedReceived: stream.reportedReceived, segments: stream.segments.slice(),
        retainBeginning: stream.retainBeginning };
    });
  }

  static restore(playerIds: number[], states: StreamCheckpoint[]): RetainedStreams {
    const fail = () => { throw new StreamError('invalid_stream_checkpoint'); };
    const result = new RetainedStreams(playerIds);
    if (!Array.isArray(states) || states.length !== playerIds.length) fail();
    for (let index = 0; index < states.length; index++) {
      const row = states[index];
      if (!row || row.playerId !== result.playerIds[index]
        || ![row.base, row.length, row.acked, row.reportedReceived].every(n => Number.isSafeInteger(n) && n >= 0)
        || row.base > row.length || row.acked > row.length || row.reportedReceived > row.length
        || row.length - row.base > MAX_RETAINED_SERVER_STREAM_BYTES
        || (row.retainBeginning !== undefined && typeof row.retainBeginning !== 'boolean')
        || (row.retainBeginning === true && row.base !== 0)
        || !Array.isArray(row.segments) || row.segments.some(segment => !(segment instanceof Uint8Array) || segment.length === 0)
        || row.segments.reduce((sum, segment) => sum + segment.length, 0) !== row.length - row.base) fail();
      Object.assign(result.require(row.playerId), row, { segments: row.segments.slice(),
        retainBeginning: row.retainBeginning === true });
    }
    return result;
  }

  /**
   * Append one emission to every target stream. Validation happens for all
   * targets before any mutation: a broadcast is all or nothing. Returns each
   * target's (start, end) absolute offsets.
   */
  append(emission: StreamEmission, options: AppendOptions = {}): Map<number, [number, number]> {
    const { playerIds, packet } = emission;
    if (!Array.isArray(playerIds) || playerIds.length === 0 || new Set(playerIds).size !== playerIds.length
      || !(packet instanceof Uint8Array) || packet.byteLength === 0) throw new StreamError('invalid_relay_emission');
    const pending = new Map<number, [number, number]>();
    const retireBeginning = new Set<number>();
    for (const playerId of playerIds) {
      const stream = this.streams.get(playerId);
      if (!stream) throw new StreamError('invalid_relay_emission');
      // Keep initial state while it fits the existing bounded stream budget.
      // Reaching the budget retires fresh-process replay, not a live match.
      let base = stream.base;
      if (stream.retainBeginning && stream.retainedBytes() + packet.byteLength > MAX_RETAINED_SERVER_STREAM_BYTES) {
        if (options.protectBeginningFor?.has(playerId)) {
          throw new StreamError('server_stream_retention_limit', playerId);
        }
        retireBeginning.add(playerId);
        for (const segment of stream.segments) {
          if (base + segment.length > stream.acked) break;
          base += segment.length;
        }
      }
      const received = Math.max(stream.acked, stream.reportedReceived);
      if (stream.length - base + packet.byteLength > MAX_RETAINED_SERVER_STREAM_BYTES) throw new StreamError('server_stream_retention_limit', playerId);
      if ((!options.windowFor || options.windowFor.has(playerId))
        && stream.length + packet.byteLength - received > MAX_UNACKNOWLEDGED_SERVER_STREAM_BYTES) {
        throw new StreamError('server_stream_window');
      }
      pending.set(playerId, [stream.length, stream.length + packet.byteLength]);
    }
    for (const playerId of playerIds) {
      const stream = this.streams.get(playerId)!;
      if (retireBeginning.has(playerId)) { stream.retainBeginning = false; stream.prune(); }
      stream.append(packet);
    }
    return pending;
  }

  /** True when appending `bytes` to this seat would exceed its unacknowledged window. */
  wouldExceedWindow(playerId: number, bytes: number): boolean {
    const stream = this.require(playerId);
    return stream.length + bytes - Math.max(stream.acked, stream.reportedReceived) > MAX_UNACKNOWLEDGED_SERVER_STREAM_BYTES;
  }

  /** One client ACK chunk (zero-length outer chunk) credits one 1000-byte block. */
  acknowledgeBlock(playerId: number, sentOffset?: number): number {
    const stream = this.require(playerId);
    const next = stream.acked + CA_RECONN_ACK_BLOCK_BYTES;
    if (next > stream.length || sentOffset !== undefined && next > sentOffset) throw new StreamError('ack_beyond_sent_stream');
    stream.acked = next;
    stream.reportedReceived = Math.max(stream.reportedReceived, next);
    stream.prune();
    return next;
  }

  /** Unframed retained bytes from `receivedOffset`, in <= 16384-byte pieces; the caller adds outer chunk headers. */
  resumeChunks(playerId: number, receivedOffset: number, rebaseAcknowledgement = false, endOffset?: number): Uint8Array[] {
    const stream = this.require(playerId);
    const end = endOffset ?? stream.length;
    if (!Number.isSafeInteger(end) || end > stream.length || !Number.isSafeInteger(receivedOffset)
      || receivedOffset < stream.acked || receivedOffset > end) {
      throw new StreamError('resume_offset_out_of_range');
    }
    stream.reportedReceived = Math.max(stream.reportedReceived, receivedOffset);
    const chunks: Uint8Array[] = [];
    for (let start = receivedOffset; start < end; start += MAX_REPLAY_CHUNK_BYTES) {
      chunks.push(stream.slice(start, Math.min(start + MAX_REPLAY_CHUNK_BYTES, end)));
    }
    // Native CAReconn starts ACK credits at the exact received offset in its
    // greeting, including the partial 1000-byte block. A bridge-only WebSocket
    // resume keeps the game socket and therefore must preserve the old base.
    if (rebaseAcknowledgement) {
      stream.acked = receivedOffset;
      stream.prune();
    }
    return chunks;
  }

  streamLength(playerId: number): number { return this.require(playerId).length; }
  ackedBytes(playerId: number): number { return this.require(playerId).acked; }

  history(playerId: number): Uint8Array {
    const stream = this.require(playerId);
    if (!stream.retainBeginning || stream.base !== 0) throw new StreamError('restart_history_unavailable');
    return stream.slice(0, stream.length);
  }

  beginFreshProcess(playerId: number): void {
    const stream = this.require(playerId);
    if (!stream.retainBeginning || stream.base !== 0) throw new StreamError('restart_history_unavailable');
    stream.acked = 0;
    stream.reportedReceived = 0;
  }

  rangeChunks(playerId: number, from: number, to: number): Uint8Array[] {
    const stream = this.require(playerId);
    if (![from, to].every(Number.isSafeInteger) || from < stream.base || to > stream.length || from > to) {
      throw new StreamError('restart_range_invalid');
    }
    const chunks: Uint8Array[] = [];
    for (let start = from; start < to; start += MAX_REPLAY_CHUNK_BYTES) {
      chunks.push(stream.slice(start, Math.min(start + MAX_REPLAY_CHUNK_BYTES, to)));
    }
    return chunks;
  }

  snapshot(): { players: Array<{ player_id: number; stream_bytes: number; retained_bytes: number; acked_bytes: number; reported_received_bytes: number }> } {
    return { players: this.playerIds.map(playerId => {
      const stream = this.streams.get(playerId)!;
      return {
        player_id: playerId,
        stream_bytes: stream.length,
        retained_bytes: stream.retainedBytes(),
        acked_bytes: stream.acked,
        reported_received_bytes: stream.reportedReceived,
      };
    }) };
  }

  /** Release a seat's retained bytes permanently (abandoned seat). Offsets are kept for snapshots. */
  release(playerId: number): void {
    const stream = this.require(playerId);
    stream.retainBeginning = false;
    stream.segments = [];
    stream.base = stream.length;
  }

  clear(): void { for (const stream of this.streams.values()) stream.clear(); }

  private require(playerId: number): SeatStream {
    const stream = Number.isInteger(playerId) ? this.streams.get(playerId) : undefined;
    if (!stream) throw new StreamError('unknown_player_id');
    return stream;
  }
}

/**
 * Client -> server stream accounting for one seat (native_battle_probe
 * client_stream_bytes / our_ack_bytes). The relay acknowledges each complete
 * 1000-byte block with a zero-length outer chunk.
 */
export class ClientStreamAccounting {
  received = 0;
  acked = 0;

  /** The native greeting reply acknowledges all retained bytes, not a rounded block. */
  acknowledgeResume(): void { this.acked = this.received; }

  /** Record `bytes` of client stream payload; returns how many ACK chunks to send now. */
  noteReceived(bytes: number): number {
    if (!Number.isInteger(bytes) || bytes < 0) throw new StreamError('invalid_client_bytes');
    this.received += bytes;
    let acks = 0;
    while (this.received - this.acked >= CA_RECONN_ACK_BLOCK_BYTES) {
      this.acked += CA_RECONN_ACK_BLOCK_BYTES;
      acks += 1;
    }
    return acks;
  }
}
