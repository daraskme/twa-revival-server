/**
 * BattleRelay Durable Object: the shared PvP CA command-relay tick authority.
 *
 * One DO instance per battle id (env.BATTLE_RELAY.getByName(battleId)). The
 * control plane installs the frozen manifest with PUT /manifest at battle
 * claim time; each player's companion bridge (server/native_relay_ws_bridge.py)
 * connects outbound over WebSocket to /ws and forwards the game's loopback
 * TCP 19000 stream. All protocol decisions live in BattleRelaySession /
 * RelayCore; this class only adapts Cloudflare APIs.
 *
 * The non-hibernating relay emits ticks every 200 ms. Bounded event batches
 * durably commit progress, partial input and paged replay streams before
 * emitting ACKs or ticks. A replacement instance restores those bytes and
 * fences previous transports, allowing authenticated CAReconn/bridge replay.
 * Existing battles created before checkpointing cannot recover lost history.
 *
 * Tick scheduling uses a re-armed setTimeout at the exact next deadline rather
 * than setInterval(200). TickClock preserves cadence through ordinary timer
 * jitter, with bounded recovery, and resets after a whole-tick stall or replay.
 */
import { DurableObject } from 'cloudflare:workers';
import { json } from '../http';
import { MAX_CHUNK_BYTES } from './framing';
import { BattleRelaySession, DEFAULT_LIMITS } from './session';
import { DurableRelayController, RelayCheckpointStore } from './checkpoint';

export interface BattleRelayEnv {
  /** HMAC-SHA256 key for relay tickets. Set with `wrangler secret put RELAY_TICKET_SECRET`. */
  RELAY_TICKET_SECRET: string;
}

const MANIFEST_KEY = 'manifest';
// A claim may outlive a failed D1/manifest write. This fence survives eviction
// even though an unconfigured session has no relay checkpoint to save.
const UNCONFIGURED_RETIREMENT_KEY = 'unconfigured-retirement-v1';
const BATTLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface UnconfiguredRetirement { battleId: string; createdAt: number }
function validUnconfiguredRetirement(value: unknown): value is UnconfiguredRetirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row.battleId === 'string' && BATTLE_ID.test(row.battleId) &&
    Number.isSafeInteger(row.createdAt) && (row.createdAt as number) >= 0;
}
// One post-greeting client WebSocket message is exactly one outer frame:
// u16 length plus native_battle_probe's <=16 KiB chunk.
const MAX_RELAY_MESSAGE_BYTES = MAX_CHUNK_BYTES + 2;

/** Normalize the binary shapes used by both Cloudflare and local workerd. */
export async function relayMessageData(value: unknown): Promise<string | Uint8Array> {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    if (value.byteLength > MAX_RELAY_MESSAGE_BYTES) throw new TypeError('relay_message_type');
    return value;
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > MAX_RELAY_MESSAGE_BYTES) throw new TypeError('relay_message_type');
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > MAX_RELAY_MESSAGE_BYTES) throw new TypeError('relay_message_type');
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // Local workerd exposes RFC-6455 binary messages as Blob in some Node API
  // configurations, whereas deployed Workers expose ArrayBuffer.  Decode the
  // already-bounded WebSocket message without accepting arbitrary objects
  // that merely happen to have an arrayBuffer property.
  if (typeof Blob !== 'undefined' && value instanceof Blob
      && value.size <= MAX_RELAY_MESSAGE_BYTES) {
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new TypeError('relay_message_type');
}

/** Payload-free runtime shape used only for one-shot adapter diagnostics. */
export function relayMessageShape(value: unknown): Record<string, string | number | null> {
  const record = value !== null && typeof value === 'object'
    ? value as Record<string, unknown> : null;
  const finite = (field: string): number | null => {
    const candidate = record?.[field];
    return typeof candidate === 'number' && Number.isFinite(candidate)
      ? candidate : null;
  };
  const constructorName = record?.constructor
    && typeof (record.constructor as { name?: unknown }).name === 'string'
    ? String((record.constructor as { name: string }).name).slice(0, 32) : null;
  return {
    tag: Object.prototype.toString.call(value).slice(0, 48),
    constructor: constructorName,
    byteLength: finite('byteLength'),
    length: finite('length'),
    size: finite('size'),
  };
}

export class BattleRelay extends DurableObject<BattleRelayEnv> {
  private readonly session: BattleRelaySession;
  private readonly recovery: RelayCheckpointStore;
  private readonly durable: DurableRelayController;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private timerPending = false;
  private unconfiguredRetirement: UnconfiguredRetirement | null = null;

  constructor(ctx: DurableObjectState, env: BattleRelayEnv) {
    super(ctx, env);
    this.session = new BattleRelaySession({
      now: () => Date.now(),
      secret: typeof env.RELAY_TICKET_SECRET === 'string' ? env.RELAY_TICKET_SECRET : '',
      // Metadata only: the session never passes payloads, keys, identities or tickets to the logger.
      log: (event, fields) => console.log(JSON.stringify({ relay: event, ...fields })),
    });
    this.recovery = new RelayCheckpointStore(ctx.storage);
    this.durable = new DurableRelayController(this.session, this.recovery, () => ctx.abort('relay_persistence_unavailable'));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(MANIFEST_KEY);
      const retirement = await ctx.storage.get<unknown>(UNCONFIGURED_RETIREMENT_KEY);
      if (retirement !== undefined) {
        if (!validUnconfiguredRetirement(retirement) || stored ||
            Date.now() - retirement.createdAt < DEFAULT_LIMITS.joinTimeoutMs) {
          throw new Error('invalid_unconfigured_retirement');
        }
        this.unconfiguredRetirement = retirement;
        this.session.end('unstarted_deadline');
      }
      if (stored) {
        this.session.setManifest(stored);
      }
      const checkpoint = await this.recovery.load();
      if (retirement !== undefined && checkpoint) throw new Error('invalid_unconfigured_retirement');
      if (checkpoint) {
        await this.durable.run(() => this.session.restore(checkpoint));
        this.arm();
      } else if (stored) {
        // A legacy manifest cannot prove whether a previous process already
        // ran this battle. Never fabricate a fresh stream under that battle ID.
        await this.durable.run(() => this.session.end('recovery_state_missing'));
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/manifest' && request.method === 'PUT') {
        let body: unknown;
        try { body = await request.json(); } catch { return json({ error: 'invalid_json' }, 400); }
        const manifest = await this.durable.run(() =>
          this.unconfiguredRetirement ? null : this.session.setManifest(body));
        if (!manifest) return json({ error: 'battle_ended' }, 409);
        return json({ ok: true, battleId: manifest.battleId, seats: manifest.seats.length });
      }
      if (url.pathname === '/status' && request.method === 'GET') return json(await this.durable.read(() => this.snapshot()));
      if (url.pathname === '/restart-status' && request.method === 'GET') {
        const playerId = Number(url.searchParams.get('playerId'));
        if (!Number.isInteger(playerId) || playerId < 1 || playerId > 20) return json({error: 'invalid_player_id'}, 400);
        return json(await this.durable.read(() => ({battleId: this.session.snapshot().battle_id,
          canRestart: this.session.restartAvailable(playerId)})));
      }
      if (url.pathname === '/retire-unstarted' && request.method === 'POST') {
        const body = await request.json() as { battleId?: unknown; createdAt?: unknown } | null;
        if (!body || Object.keys(body).some(key => key !== 'battleId' && key !== 'createdAt') ||
            !Number.isSafeInteger(body.createdAt) || (body.createdAt as number) < 0 ||
            (body.createdAt as number) > Date.now() ||
            (body.battleId !== undefined && (typeof body.battleId !== 'string' || !BATTLE_ID.test(body.battleId)))) {
          return json({ error: 'invalid_creation_time' }, 400);
        }
        const state = await this.durable.run(async () => {
          if (this.unconfiguredRetirement) {
            if (body.battleId !== this.unconfiguredRetirement.battleId ||
                body.createdAt !== this.unconfiguredRetirement.createdAt) return null;
            return this.snapshot();
          }
          if (this.session.hasManifest) {
            if (body.battleId !== undefined && body.battleId !== this.session.battleId) return null;
            this.session.retireUnstarted(body.createdAt);
            return this.snapshot();
          }
          if (body.battleId === undefined) return null;
          if (Date.now() - (body.createdAt as number) >= DEFAULT_LIMITS.joinTimeoutMs) {
            const retirement = { battleId: body.battleId as string, createdAt: body.createdAt as number };
            await this.ctx.storage.put(UNCONFIGURED_RETIREMENT_KEY, retirement);
            this.unconfiguredRetirement = retirement;
            this.session.end('unstarted_deadline');
          }
          return { ...this.snapshot(), battle_id: body.battleId };
        });
        if (!state) return json({ error: 'battle_identity_conflict' }, 409);
        this.arm();
        return json(state);
      }
      if (url.pathname === '/end' && request.method === 'POST') {
        await this.durable.run(() => this.session.end('control_plane'));
        this.arm();
        return json({ ok: true });
      }
      if (url.pathname === '/ws' && request.method === 'GET') {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
        const pair = new WebSocketPair();
        const client = pair[0], server = pair[1];
        server.accept();
        const id = crypto.randomUUID();
        let messageChain = Promise.resolve();
        let binaryShapeLogged = false;
        let connectionClosed = false;
        let pendingMessages = 0;
        const closeInvalidMessage = (shape: Record<string, string | number | null>) => {
          if (connectionClosed) return;
          connectionClosed = true;
          console.log(JSON.stringify({ relay: 'websocket_message_rejected', ...shape }));
          void this.durable.run(() => this.session.onClose(id, 4000, 'relay_message_type'));
          try { server.close(4000, 'relay_message_type'); } catch { /* already closed */ }
          this.arm();
        };
        server.addEventListener('message', event => {
          if (connectionClosed) return;
          const shape = relayMessageShape(event.data);
          if (pendingMessages >= 64) {
            closeInvalidMessage(shape);
            return;
          }
          pendingMessages += 1;
          // Blob conversion is asynchronous. Chain it in arrival order before
          // BattleRelaySession's own frame chain so a following frame can
          // never overtake the greeting that authorizes it.
          messageChain = messageChain.then(async () => {
            if (connectionClosed) return;
            if (!binaryShapeLogged && typeof event.data !== 'string') {
              binaryShapeLogged = true;
              console.log(JSON.stringify({ relay: 'websocket_binary_shape',
                ...shape }));
            }
            const data = await relayMessageData(event.data);
            await this.durable.run(() => this.session.onMessage(id, data));
            this.arm();
          }).catch(() => {
            closeInvalidMessage(shape);
          }).finally(() => { pendingMessages -= 1; });
        });
        server.addEventListener('close', event => {
          connectionClosed = true;
          void this.durable.run(() => this.session.onClose(id, event.code, event.reason)).then(() => this.arm());
        });
        server.addEventListener('error', () => {
          connectionClosed = true;
          void this.durable.run(() => this.session.onClose(id, 1006, 'error')).then(() => this.arm());
        });
        await this.durable.run(() => this.session.onOpen(id, this.durable.transport({
          sendBinary: bytes => server.send(bytes),
          sendText: text => server.send(text),
          close: (code, reason) => { try { server.close(code, reason.slice(0, 123)); } catch { /* already closed */ } },
        })));
        this.arm();
        return new Response(null, { status: 101, webSocket: client });
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      return json({ error: typeof code === 'string' ? code : 'relay_error' }, 400);
    }
  }

  private snapshot() {
    const state = this.session.snapshot();
    return this.unconfiguredRetirement ? { ...state, battle_id: this.unconfiguredRetirement.battleId } : state;
  }

  /** Re-arm the single wake-up timer at the session's next deadline (tick, idle, grace, cap). */
  private arm(): void {
    if (this.timerPending) return;
    if (!this.session.needsTimer) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    const now = Date.now();
    const at = this.session.nextWakeAt(now);
    if (this.timer !== null && this.timerAt <= at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerAt = at;
    const delay = Math.max(0, at - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerPending = true;
      void this.durable.run(() => this.session.onTimer()).finally(() => {
        this.timerPending = false;
        this.arm();
      });
    }, delay);
  }
}
