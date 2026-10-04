/** Rebuild a native process through the original JOIN/READY barriers.
 * Replay is private authenticated seat history, never a second battle.
 */
import { equalBytes, readInnerHeader, versionPacket, gameConfirmPacket } from './framing';

export class RestartError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export interface RestartState {
  stage: 'join' | 'payload' | 'ready' | 'catchup';
  versionEnd: number;
  confirmEnd: number;
  payloadEnd: number;
  readyEnd: number;
  sentOffset: number;
  targetOffset: number;
}

function u32(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > bytes.length) throw new RestartError('restart_history_invalid');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
}

export function restartPlan(history: Uint8Array, playerId: number): RestartState {
  let offset = 0;
  const starts: Array<{kind: number; start: number; end: number}> = [];
  while (offset < history.length) {
    const header = readInnerHeader(history, offset);
    if (!header || header.total < 3 || offset + header.total > history.length) {
      throw new RestartError('restart_history_invalid');
    }
    starts.push({kind: header.kind, start: offset, end: offset + header.total});
    offset += header.total;
    if (header.kind === 3) break;
    if (starts.length > 24) throw new RestartError('restart_history_invalid');
  }
  if (starts.length < 4 || starts[0].kind !== 13 || starts[1].kind !== 0 || starts[2].kind !== 2
    || starts.at(-1)!.kind !== 3 || starts.slice(3, -1).some(row => row.kind !== 8)
    || !equalBytes(history.subarray(0, starts[0].end), versionPacket())
    || !equalBytes(history.subarray(starts[1].start, starts[1].end), gameConfirmPacket(playerId))) {
    throw new RestartError('restart_history_invalid');
  }
  return { stage: 'join', versionEnd: starts[0].end, confirmEnd: starts[1].end,
    payloadEnd: starts[2].end, readyEnd: starts.at(-1)!.start,
    sentOffset: 0, targetOffset: history.length };
}

/** A changed roster/seed cannot restart an old deterministic simulation. */
export function validateRestartPayload(history: Uint8Array, state: RestartState,
  playerId: number, packet: Uint8Array): void {
  const header = readInnerHeader(packet);
  if (!header || header.kind !== 1 || header.total !== packet.length || packet.length < 9
    || u32(packet, 3) !== packet.length - 7 || packet[7] !== 1) {
    throw new RestartError('restart_payload_invalid');
  }
  let offset = state.confirmEnd + 3;
  const count = u32(history, offset); offset += 4;
  if (count < 1 || count > 20) throw new RestartError('restart_history_invalid');
  let found = false;
  for (let index = 0; index < count; index++) {
    const id = u32(history, offset), size = u32(history, offset + 4); offset += 8;
    if (size < 2 || offset + size > state.payloadEnd) throw new RestartError('restart_history_invalid');
    if (id === playerId) {
      if (found || !equalBytes(packet.subarray(7), history.subarray(offset, offset + size))) {
        throw new RestartError('restart_payload_changed');
      }
      found = true;
    }
    offset += size;
  }
  if (!found || offset !== state.payloadEnd) throw new RestartError('restart_history_invalid');
}

export function validateRestartState(value: unknown, history: Uint8Array, playerId: number): RestartState | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object') throw new RestartError('restart_checkpoint_invalid');
  const state = value as RestartState, planned = restartPlan(history, playerId);
  if (Object.keys(state).length !== 7 || !['join', 'payload', 'ready', 'catchup'].includes(state.stage)
    || ['versionEnd', 'confirmEnd', 'payloadEnd', 'readyEnd'].some(key =>
      state[key as keyof RestartState] !== planned[key as keyof RestartState])
    || !Number.isSafeInteger(state.sentOffset) || !Number.isSafeInteger(state.targetOffset)
    || state.targetOffset < state.readyEnd || state.targetOffset > history.length
    || state.sentOffset < 0 || state.sentOffset > history.length
    || (state.stage === 'join' && state.sentOffset !== state.versionEnd)
    || (state.stage === 'payload' && state.sentOffset !== state.confirmEnd)
    || (state.stage === 'ready' && state.sentOffset !== state.readyEnd)
    || (state.stage === 'catchup' && state.sentOffset < state.targetOffset)) {
    throw new RestartError('restart_checkpoint_invalid');
  }
  return {...state};
}
