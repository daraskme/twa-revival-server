/**
 * Pure 200 ms tick deadline owner, ported from
 * server/native_pvp_adapter_contract.py PvpTickClock (milliseconds here).
 * Keep the cadence through ordinary timer jitter instead of accumulating it.
 * A stall of a whole tick resets the deadline; reconnect also resets it.
 * No wake-up emits more than one tick, and wakes remain at least 100 ms apart.
 */
export const TICK_INTERVAL_MS = 200;

export class ClockError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ClockError';
  }
}

function finite(now: number): boolean { return typeof now === 'number' && Number.isFinite(now); }

export class TickClock {
  started = false;
  nextAt = 0;
  count = 0;

  start(now: number): void {
    if (this.started || !finite(now)) throw new ClockError('invalid_tick_start');
    this.started = true;
    this.nextAt = now + TICK_INTERVAL_MS;
  }

  due(now: number): boolean {
    if (!this.started || !finite(now)) return false;
    return now >= this.nextAt;
  }

  markSent(now: number): number {
    if (!this.due(now)) throw new ClockError('tick_not_due');
    this.count += 1;
    const lateness = now - this.nextAt;
    this.nextAt = lateness >= TICK_INTERVAL_MS
      ? now + TICK_INTERVAL_MS
      : Math.max(this.nextAt + TICK_INTERVAL_MS, now + TICK_INTERVAL_MS / 2);
    return this.count;
  }

  /** Restart the cadence after a replay so a slow reconnect cannot create catch-up ticks. */
  resume(now: number): void {
    if (!this.started || !finite(now)) throw new ClockError('invalid_tick_resume');
    this.nextAt = now + TICK_INTERVAL_MS;
  }
}
