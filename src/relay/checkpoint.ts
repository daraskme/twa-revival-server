/** Atomic private checkpoints. Replay bytes are paged; unchanged pages are not rewritten. */
import type { BattleRelaySession, RelaySessionCheckpoint, RelayTransport } from './session';
import type { RelayCoreCheckpoint } from './core';
import type { StreamCheckpoint } from './streams';

const PREFIX = 'relay-recovery-v1:';
const HEAD = PREFIX + 'head';
const CORE = PREFIX + 'core';
const PAGE_BYTES = 64 * 1024;
interface Page { key: string; start: number; end: number; digest: string }
interface StoredStream extends Omit<StreamCheckpoint, 'segments'> { pages: Page[] }
interface Head extends Omit<RelaySessionCheckpoint, 'streams' | 'core'> { streamIds: number[] }
interface StreamCache {
  stored: StoredStream;
  // Relay stream segments are immutable after append. Retain references only,
  // not a second copy of the potentially multi-megabyte reconnect history.
  segments: Uint8Array[];
}

export interface CheckpointStorage {
  get<T>(key: string): Promise<T | undefined>;
  transaction<T>(callback: (transaction: {
    put(key: string, value: unknown): Promise<void>;
    delete(keys: string[]): Promise<number>;
  }) => Promise<T>): Promise<T>;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export class RelayCheckpointStore {
  private pages = new Map<string, string>();
  private streamIds: number[] = [];
  private cachedStreams = new Map<number, StreamCache>();
  private savedManifest: string | null = null;
  constructor(private readonly storage: CheckpointStorage) {}

  async load(): Promise<RelaySessionCheckpoint | null> {
    const head = await this.storage.get<Head>(HEAD);
    if (head === undefined) return null;
    if (head.version !== 1 || !Array.isArray(head.streamIds) || head.streamIds.length < 1 || head.streamIds.length > 20
      || head.streamIds.some((id, index) => id !== index + 1)) throw new Error('invalid_relay_checkpoint');
    const core = await this.storage.get<RelayCoreCheckpoint>(CORE);
    if (!core) throw new Error('incomplete_relay_checkpoint');
    const streams: StreamCheckpoint[] = [];
    const pageDigests = new Map<string, string>();
    for (const playerId of head.streamIds) {
      const stream = await this.storage.get<StoredStream>(PREFIX + 'stream:' + playerId);
      if (!stream || stream.playerId !== playerId || !Array.isArray(stream.pages) || stream.pages.length > 65) {
        throw new Error('invalid_relay_checkpoint_stream');
      }
      const segments: Uint8Array[] = [];
      let offset = stream.base;
      for (const page of stream.pages) {
        if (page.start !== offset || page.end <= page.start || page.end - page.start > PAGE_BYTES
          || page.key !== `${PREFIX}page:${playerId}:${Math.floor(page.start / PAGE_BYTES)}`) {
          throw new Error('invalid_relay_checkpoint_page');
        }
        const bytes = await this.storage.get<Uint8Array>(page.key);
        if (!(bytes instanceof Uint8Array) || bytes.length !== page.end - page.start || await digest(bytes) !== page.digest) {
          throw new Error('incomplete_relay_checkpoint_page');
        }
        segments.push(bytes); pageDigests.set(page.key, page.digest); offset = page.end;
      }
      if (offset !== stream.length) throw new Error('incomplete_relay_checkpoint_stream');
      const { pages: _, ...metadata } = stream;
      streams.push({ ...metadata, segments });
    }
    this.pages = pageDigests; this.streamIds = [...head.streamIds];
    this.cachedStreams.clear(); this.savedManifest = null;
    const { streamIds: _, ...state } = head;
    return { ...state, core, streams };
  }

  async save(state: RelaySessionCheckpoint): Promise<void> {
    // Build one page at a time; do not flatten/copy every retained stream.
    const nextPages = new Map<string, string>();
    const nextStreams = new Map<number, StreamCache>();
    const writes: Array<[string, unknown]> = [];
    for (const stream of state.streams) {
      const cached = this.cachedStreams.get(stream.playerId);
      const unchangedBytes = cached && cached.stored.base === stream.base
        && cached.stored.length === stream.length && cached.segments.length === stream.segments.length
        && cached.segments.every((segment, index) => segment === stream.segments[index]);
      if (unchangedBytes) {
        const stored: StoredStream = { playerId: stream.playerId, base: stream.base, length: stream.length,
          acked: stream.acked, reportedReceived: stream.reportedReceived, pages: cached.stored.pages,
          retainBeginning: stream.retainBeginning };
        if (stored.acked !== cached.stored.acked || stored.reportedReceived !== cached.stored.reportedReceived
          || stored.retainBeginning !== cached.stored.retainBeginning) {
          writes.push([PREFIX + 'stream:' + stream.playerId, stored]);
        }
        for (const page of stored.pages) nextPages.set(page.key, page.digest);
        nextStreams.set(stream.playerId, { stored, segments: stream.segments.slice() });
        continue;
      }
      const pages: Page[] = [];
      let offset = stream.base, segmentIndex = 0, segmentOffset = 0;
      while (offset < stream.length) {
        const end = Math.min(stream.length, (Math.floor(offset / PAGE_BYTES) + 1) * PAGE_BYTES);
        const bytes = new Uint8Array(end - offset);
        let written = 0;
        while (written < bytes.length) {
          const segment = stream.segments[segmentIndex];
          if (!segment) throw new Error('incomplete_relay_stream');
          const count = Math.min(segment.length - segmentOffset, bytes.length - written);
          bytes.set(segment.subarray(segmentOffset, segmentOffset + count), written);
          written += count; segmentOffset += count;
          if (segmentOffset === segment.length) { segmentIndex++; segmentOffset = 0; }
        }
        const key = `${PREFIX}page:${stream.playerId}:${Math.floor(offset / PAGE_BYTES)}`;
        const hash = await digest(bytes);
        pages.push({ key, start: offset, end, digest: hash }); nextPages.set(key, hash);
        if (this.pages.get(key) !== hash) writes.push([key, bytes]);
        offset = end;
      }
      const { segments: _, ...metadata } = stream;
      const stored: StoredStream = { ...metadata, pages };
      writes.push([PREFIX + 'stream:' + stream.playerId, stored]);
      nextStreams.set(stream.playerId, { stored, segments: stream.segments.slice() });
    }
    const { streams, core, ...metadata } = state;
    const streamIds = streams.map(stream => stream.playerId);
    const manifest = JSON.stringify(state.manifest);
    if (manifest !== this.savedManifest) writes.push(['manifest', state.manifest]);
    writes.push([CORE, core], [HEAD, { ...metadata, streamIds } satisfies Head]);
    const removals = [...this.pages.keys()].filter(key => !nextPages.has(key));
    for (const id of this.streamIds) if (!streamIds.includes(id)) removals.push(PREFIX + 'stream:' + id);
    await this.storage.transaction(async transaction => {
      // Bounded individual values (<128 KiB). Transaction covers both offsets
      // and bytes; interruption can never publish one without the other.
      // Independent keys share a bounded write group inside the same atomic
      // transaction, avoiding a separate await round-trip for every player.
      for (let index = 0; index < writes.length; index += 32) {
        await Promise.all(writes.slice(index, index + 32).map(([key, value]) => transaction.put(key, value)));
      }
      for (let index = 0; index < removals.length; index += 128) await transaction.delete(removals.slice(index, index + 128));
    });
    this.pages = nextPages; this.streamIds = streamIds;
    this.cachedStreams = nextStreams; this.savedManifest = manifest;
  }
}

type RelayJob = {
  read: boolean;
  operation: () => unknown | Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

/** Ordered, bounded event batches; all output waits for the atomic commit. */
export class DurableRelayController {
  private readonly jobs: RelayJob[] = [];
  private pumping = false;
  private output: Array<() => void> | null = null;
  private failed = false;
  constructor(private readonly session: BattleRelaySession,
    private readonly store: Pick<RelayCheckpointStore, 'save'>,
    private readonly failClosed: () => void) {}

  transport(target: RelayTransport): RelayTransport {
    const defer = (action: () => void) => {
      if (!this.output) throw new Error('relay_output_outside_transaction');
      this.output.push(action);
    };
    return {
      sendBinary: bytes => { const copy = bytes.slice(); defer(() => target.sendBinary(copy)); },
      sendText: text => defer(() => target.sendText(text)),
      close: (code, reason) => defer(() => target.close(code, reason)),
    };
  }

  /** Observe only committed state; never expose a tentative terminal phase. */
  read<T>(observe: () => T): Promise<T> {
    return this.enqueue(true, observe);
  }

  run<T>(mutation: () => T | Promise<T>): Promise<T> {
    return this.enqueue(false, mutation);
  }

  private enqueue<T>(read: boolean, operation: () => T | Promise<T>): Promise<T> {
    if (this.failed) return Promise.reject(new Error('relay_persistence_unavailable'));
    const result = new Promise<T>((resolve, reject) => {
      this.jobs.push({ read, operation, resolve: value => resolve(value as T), reject });
    });
    if (!this.pumping) {
      this.pumping = true;
      // Preserve FIFO order; pump groups arrivals before entering the storage
      // input gate so simultaneous peers can share one durable commit.
      void Promise.resolve().then(() => this.pump());
    }
    return result;
  }

  private async pump(): Promise<void> {
    while (this.jobs.length) {
      if (this.jobs[0].read) {
        const job = this.jobs.shift()!;
        try { job.resolve(await job.operation()); } catch (error) { job.reject(error); }
        continue;
      }
      // Storage's input gate prevents newly arrived WebSocket events from
      // joining an in-flight transaction. Allow one short event-loop window
      // before each bounded batch, without extending it for later arrivals.
      await new Promise<void>(resolve => setTimeout(resolve, 2));
      const batch: RelayJob[] = [];
      while (batch.length < 32 && this.jobs.length && !this.jobs[0].read) batch.push(this.jobs.shift()!);
      this.output = [];
      const results: unknown[] = [];
      try {
        for (const job of batch) results.push(await job.operation());
        const state = this.session.checkpoint();
        if (state) await this.store.save(state);
      } catch (error) {
        this.output = null; this.failed = true;
        for (const job of batch) job.reject(error);
        for (const job of this.jobs.splice(0)) job.reject(new Error('relay_persistence_unavailable'));
        this.pumping = false;
        this.failClosed();
        return;
      }
      const output = this.output; this.output = null;
      // A socket may have closed after commit. Its queued close event fences
      // it; retained bytes remain available for the authenticated reconnect.
      for (const send of output) { try { send(); } catch { /* socket already closed */ } }
      batch.forEach((job, index) => job.resolve(results[index]));
    }
    this.pumping = false;
  }
}
