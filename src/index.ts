export { Social } from './social';
import type { Env, IdentityVerifier } from './types';
import { getCareer } from './career';
import { nativeHealth, nativeMatchmaking, requirePublicQueueRuleset, NATIVE_PROTOCOL } from './native-release';
import {requirePublicRosterClient, requireMatchmakingRosterClient} from './public-roster-version';
import { partyMatchmaking } from './party-matchmaking';
import { ApiError, fields, json, readJson } from './http';
import { authenticate, authenticateSocial, bearer, commanders, login, renewSession, selectCommander, updateDisplayName } from './accounts';
import { verifyConnectIdToken } from './eos';
import { handleAdmin } from './admin';
import { enforceClientVersion, liveAnnouncements, maintenanceResponse, readAnnouncements, readStartupControl, readMaintenance } from './control';
import { getProfile, putProfile } from './profiles';
import { getLoadout, putLoadout } from './loadout-selection';
import {
  BATTLE_ID, createBattle, createBattleFromAssignment, createBattleFromRoomClaim, getBattle, getActiveBattle, getRoster,
  issueRelayTicket, privateBattleReturnable, putSquad, reportBattleResult,
} from './battles';
import { updateManifest, launcherUpdateManifest, baseGameManifest, updateObject } from './updates';
export { Room } from './room';
export { Matchmaker } from './matchmaking';
export { BattleRelay } from './relay/durable-object';

const roomIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Only these routes take a query string; everything else stays query-free so a
// caller can never smuggle an identity or a limit past the path matcher.
const queryRoutes = new Set(['/v1/update/manifest', '/v1/update/launcher-manifest', '/v1/update/base-game-manifest', '/admin/users', '/admin/battles', '/v1/rooms']);

async function syncRoomDirectory(env: Env, roomId: string, body: any): Promise<void> {
  if (!body || body.visibility !== 'listed' || body.status !== 'open') {
    await env.DB.prepare('DELETE FROM room_directory WHERE room_id = ?').bind(roomId).run();
    return;
  }
  const owner = Array.isArray(body.members) ? body.members.find((member: any) => member.userId === body.ownerId) : null;
  if (!owner) return;
  await env.DB.prepare(`INSERT INTO room_directory(room_id, owner_display_name, mode, ruleset, visibility, status,
    members, max_players, ai_opponents, created_at, expires_at, room_title, battle_length)
    VALUES (?, ?, ?, ?, 'listed', 'open', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET owner_display_name=excluded.owner_display_name, mode=excluded.mode,
      ruleset=excluded.ruleset, visibility=excluded.visibility, status=excluded.status, members=excluded.members,
      max_players=excluded.max_players, ai_opponents=excluded.ai_opponents, expires_at=excluded.expires_at,
      room_title=excluded.room_title, battle_length=excluded.battle_length`)
    .bind(roomId, owner.displayName, body.mode, body.ruleset, body.members.length, body.maxPlayers,
      body.aiOpponents, Math.floor(body.createdAt / 1000), Math.floor(body.expiresAt / 1000),
      body.roomConfig.title, body.roomConfig.length).run();
}

function failure(error: unknown, request: Request): Response {
  // Never log a JWT, invitation, session, or untrusted request body.
  if (error instanceof ApiError && error.detail) {
    try { requireMatchmakingRosterClient(request, error.detail); }
    catch (compatibilityError) { error = compatibilityError; }
  }
  if (error instanceof ApiError) return json({ error: error.code, ...error.detail }, error.status);
  return json({ error: 'service_unavailable' }, 503);
}

// Only tests inject a verifier. The deployed entry point below always uses official EOS JWKS.
export function createApp(verifyIdentity: IdentityVerifier) {
  return { async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new ApiError(400, 'https_required');
      // The first client is a native companion. No ambient cookies or cross-origin browser API.
      if (request.headers.has('Origin')) throw new ApiError(403, 'browser_origin_not_allowed');
      const path = url.pathname;
      const battleAdmissionQuery = request.method === 'GET'
        && /^\/v1\/battles\/[0-9a-f-]{36}$/.test(path) && url.search === '?admission=1';
      if (url.search && !queryRoutes.has(path) && !battleAdmissionQuery) throw new ApiError(400, 'query_not_supported');
      // The operator surface keeps working while players are locked out.
      if (path.startsWith('/admin/')) return await handleAdmin(request, url, env);
      if (path === '/health' && request.method === 'GET') {
        const startup = await readStartupControl(env);
        const maintenance = startup.maintenance;
        return json({ ok: true, service: 'twa-private-control', ...nativeHealth(env),
          maintenance: { enabled: maintenance.enabled, message: maintenance.message, endsAt: maintenance.endsAt ?? null },
          minClientVersion: startup.minClientVersion });
      }
      if (!path.startsWith('/v1/')) throw new ApiError(404, 'not_found');

      // Unauthenticated, IP-budgeted self-update surface. Signed manifests and
      // their content objects only; no account data is reachable here. It stays
      // reachable during maintenance so companions can update before it ends.
      if (path === '/v1/update/manifest' || path === '/v1/update/launcher-manifest' || path === '/v1/update/base-game-manifest' || path.startsWith('/v1/update/object/')) {
        if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
        if (!(await env.UPDATE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) {
          throw new ApiError(429, 'rate_limited');
        }
        return path === '/v1/update/manifest'
          ? await updateManifest(url, env)
          : path === '/v1/update/launcher-manifest' ? await launcherUpdateManifest(url, env)
          : path === '/v1/update/base-game-manifest' ? await baseGameManifest(url, env)
          : await updateObject(path.slice('/v1/update/object/'.length), env);
      }

      // PvP command relay. The relay ticket (issued to a participant by
      // /v1/battles/:id/relay-ticket) is verified inside the Durable Object;
      // the companion bridge has no bearer session. Battles already in progress
      // keep their relay during maintenance; new battles cannot be created.
      const relayRoute = /^\/v1\/relay\/([0-9a-f-]{36})$/.exec(path);
      if (relayRoute) {
        if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          throw new ApiError(426, 'websocket_required');
        }
        if (!roomIdPattern.test(relayRoute[1])) throw new ApiError(404, 'not_found');
        if (!(await env.EDGE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) throw new ApiError(429, 'rate_limited');
        return await env.BATTLE_RELAY.getByName(relayRoute[1]).fetch(new Request('https://relay/ws', request));
      }

      // Existing authenticated games may keep their session during maintenance.
      // Both the current opaque session and independently verified Epic proof
      // are required; renewal never creates an account or changes identity.
      if (path === '/v1/auth/eos/refresh') {
        if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (!(await env.EDGE_LIMITER.limit({ key: ip })).success ||
            !(await env.AUTH_LIMITER.limit({ key: ip })).success) throw new ApiError(429, 'rate_limited');
        const { actor, tokenHash } = await authenticateSocial(request, env);
        if (!(await env.API_LIMITER.limit({ key: actor.id })).success) throw new ApiError(429, 'rate_limited');
        await enforceClientVersion(request, env);
        const body = await readJson(request);
        fields(body, ['connectIdToken']);
        if (typeof body.connectIdToken !== 'string' || body.connectIdToken.length > 8192) {
          throw new ApiError(401, 'invalid_eos_token');
        }
        const identity = await verifyIdentity(body.connectIdToken, env);
        return json(await renewSession(actor, tokenHash, identity, env));
      }

      const maintenance = await readMaintenance(env);
      if (maintenance.enabled) return maintenanceResponse(maintenance);

      if (path === '/v1/auth/eos' && request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (!(await env.AUTH_LIMITER.limit({ key: ip })).success) throw new ApiError(429, 'rate_limited');
        await enforceClientVersion(request, env);
        const identity = await verifyIdentity(bearer(request), env);
        return json(await login(identity, await readJson(request), env));
      }
      // Apply the edge/IP budget BEFORE looking up opaque sessions in D1.
      if (!(await env.EDGE_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' })).success) throw new ApiError(429, 'rate_limited');
      const socialRoute = /^\/v1\/social(?:\/([a-z]+))?$/.exec(path);
      const partyReadOrCancel = /^\/v1\/matchmaking(?:\/party)?(?:\/cancel)?$/.test(path);
      const { actor, tokenHash } = await (socialRoute || partyReadOrCancel ? authenticateSocial : authenticate)(request, env);
      if (!(await env.API_LIMITER.limit({ key: actor.id })).success) throw new ApiError(429, 'rate_limited');
      if (path === '/v1/logout' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
        return json({ ok: true });
      }
      if (socialRoute) {
        const action = socialRoute[1] ?? 'get';
        if (request.method !== (action === 'get' ? 'GET' : 'POST')) throw new ApiError(405, 'method_not_allowed');
        const body = action === 'get' ? {} : await readJson(request);
        if (action === 'settings') requirePublicQueueRuleset(env,
          typeof body.ruleset === 'string' ? body.ruleset : '', body.mode);
        const result = await env.SOCIAL.getByName('social-v1').command(actor, action, body);
        return json(result.body, result.status);
      }
      if (path === '/v1/me' && request.method === 'GET') {
        await enforceClientVersion(request, env);
        return json({ user: actor });
      }
      if (path === '/v1/me/display-name') {
        if (request.method !== 'PATCH') throw new ApiError(405, 'method_not_allowed');
        await enforceClientVersion(request, env);
        return json({ user: await updateDisplayName(actor, await readJson(request), env) });
      }
      if (path === '/v1/career') {
        if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
        return await getCareer(actor, env);
      }
      if (path === '/v1/catalog/commanders' && request.method === 'GET') return json({ commanders });
      if (path === '/v1/me/commander' && request.method === 'PATCH') return json({ user: await selectCommander(actor, await readJson(request), env) });
      if (path === '/v1/me/loadout') {
        if (request.method === 'GET') return await getLoadout(actor, env);
        if (request.method === 'PUT') return await putLoadout(actor, request, env);
        throw new ApiError(405, 'method_not_allowed');
      }
      if (path === '/v1/announcements') {
        if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
        return json({ announcements: liveAnnouncements(await readAnnouncements(env), Math.floor(Date.now() / 1000)) });
      }
      if (path === '/v1/profile') {
        if (request.method === 'GET') return await getProfile(actor, env);
        if (request.method === 'PUT') return await putProfile(actor, request, env);
        throw new ApiError(405, 'method_not_allowed');
      }
      if (path === '/v1/battles') {
        if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
        return await createBattle(actor, request, env);
      }
      if (path === '/v1/battles/active') {
        if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed');
        return await getActiveBattle(actor, env, request);
      }
      if (path === '/v1/battles/from-assignment') {
        if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed');
        return await createBattleFromAssignment(actor, request, env);
      }
      const battleRoute = /^\/v1\/battles\/([^/]+)(?:\/(result|relay-ticket|squad|roster))?$/.exec(path);
      if (battleRoute && BATTLE_ID.test(battleRoute[1])) {
        const action = battleRoute[2] ?? 'get';
        const expectedMethod = { get: 'GET', roster: 'GET', squad: 'PUT', result: 'POST', 'relay-ticket': 'POST' }[action];
        if (request.method !== expectedMethod) throw new ApiError(405, 'method_not_allowed');
        if (action === 'get') return await getBattle(actor, battleRoute[1], env, url.searchParams.get('admission') === '1', request);
        if (action === 'roster') return await getRoster(actor, battleRoute[1], env, request);
        if (action === 'squad') return await putSquad(actor, battleRoute[1], request, env);
        if (action === 'result') return await reportBattleResult(actor, battleRoute[1], request, env);
        return await issueRelayTicket(actor, battleRoute[1], env, request);
      }
      const partyRoute = /^\/v1\/matchmaking\/party(?:\/(start|cancel))?$/.exec(path);
      if (partyRoute) {
        const action = (partyRoute[1] ?? 'get') as 'start' | 'cancel' | 'get';
        if (request.method !== (action === 'get' ? 'GET' : 'POST')) throw new ApiError(405, 'method_not_allowed');
        if (action === 'start' && env.NATIVE_PUBLIC_PROTOCOL === 'twa-relay-v1') requirePublicRosterClient(request, 5);
        const body = action === 'get' ? {} : await readJson(request);
        if (action === 'cancel' && typeof body.attemptId !== 'string') throw new ApiError(400, 'invalid_group_attempt_id');
        const result = await partyMatchmaking(actor, action, body, env);
        requireMatchmakingRosterClient(request, result.body);
        return json(nativeMatchmaking(result.body, env), result.status);
      }
      const matchmakingRoute = /^\/v1\/matchmaking(?:\/(join|cancel))?$/.exec(path);
      if (matchmakingRoute) {
        const action = matchmakingRoute[1] ?? 'get';
        if ((action === 'get' && request.method !== 'GET') || (action !== 'get' && request.method !== 'POST')) throw new ApiError(405, 'method_not_allowed');
        if (action === 'join' && env.NATIVE_PUBLIC_PROTOCOL === 'twa-relay-v1') requirePublicRosterClient(request, 5);
        const body = action === 'get' ? {} : await readJson(request);
        // Both modes share an account admission namespace; no caller-provided
        // room/shard/Tier can bypass the one-ticket-per-account invariant.
        const result = await partyMatchmaking(actor, action as 'get' | 'join' | 'cancel', body, env);
        requireMatchmakingRosterClient(request, result.body);
        return json(nativeMatchmaking(result.body, env), result.status);
      }
      if (path === '/v1/rooms' && request.method === 'GET') {
        const allowed = new Set(['cursor', 'limit']);
        for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw new ApiError(400, 'invalid_query');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (rawLimit !== null && !/^\d{1,2}$/.test(rawLimit))) {
          throw new ApiError(400, 'invalid_limit');
        }
        const rawCursor = url.searchParams.get('cursor');
        let cursorAt = -1, cursorId = '';
        if (rawCursor !== null) {
          const match = /^(\d{1,12}):([0-9a-f-]{36})$/.exec(rawCursor);
          if (!match) throw new ApiError(400, 'invalid_cursor');
          cursorAt = Number(match[1]); cursorId = match[2];
        }
        const now = Math.floor(Date.now() / 1000);
        const rows = await env.DB.prepare(`SELECT room_id, owner_display_name, mode, ruleset, members, max_players,
          ai_opponents, expires_at, created_at, room_title, battle_length FROM room_directory
          WHERE visibility='listed' AND status='open'
          AND expires_at > ? AND (? = 0 OR mode = 'pvp')
          AND (created_at > ? OR (created_at = ? AND room_id > ?))
          ORDER BY created_at, room_id LIMIT ?`).bind(now,
          env.NATIVE_PUBLIC_PROTOCOL === NATIVE_PROTOCOL ? 1 : 0,
          cursorAt, cursorAt, cursorId, limit + 1).all<any>();
        const page = rows.results.slice(0, limit);
        const last = page.at(-1);
        // The index selects a bounded page; each room supplies its current public
        // projection. This also excludes stale listed rows after a privacy change.
        const summaries = await Promise.all(page.map(async row => {
          const summary = await env.ROOMS.getByName(row.room_id).directorySummary();
          return summary ? { roomId: row.room_id, ...summary } : null;
        }));
        return json({ rooms: summaries.filter(row => row !== null),
        nextCursor: rows.results.length > limit && last ? `${last.created_at}:${last.room_id}` : null });
      }
      if (path === '/v1/rooms' && request.method === 'POST') {
        const body = await readJson(request);
        // Retired PvE must be rejected before reserving room ownership or budget.
        requirePublicQueueRuleset(env, typeof body.ruleset === 'string' ? body.ruleset : '', body.mode);
        const roomId = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const claimed = await env.DB.prepare(`INSERT INTO room_ownership (user_id, room_id, expires_at) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET room_id = excluded.room_id, expires_at = excluded.expires_at
          WHERE room_ownership.expires_at <= ? RETURNING room_id`).bind(actor.id, roomId, now + 7200, now).first();
        if (!claimed) {
          const owned = await env.DB.prepare('SELECT room_id FROM room_ownership WHERE user_id = ?').bind(actor.id).first();
          return json({ error: 'created_room_exists', roomId: owned?.room_id }, 409);
        }
        let dispatched = false;
        try {
          const budget = await env.DB.prepare(`INSERT INTO room_creation_budget(user_id, count, resets_at) VALUES (?, 1, ?)
            ON CONFLICT(user_id) DO UPDATE SET
              count = CASE WHEN resets_at <= ? THEN 1 ELSE count + 1 END,
              resets_at = CASE WHEN resets_at <= ? THEN excluded.resets_at ELSE resets_at END
            WHERE resets_at <= ? OR count < 20 RETURNING count`)
            .bind(actor.id, now + 86400, now, now, now).first();
          if (!budget) throw new ApiError(429, 'room_creation_budget_exhausted');
          dispatched = true;
          const result = await env.ROOMS.getByName(roomId).command(actor, 'create', body);
          if (result.status >= 400) await env.DB.prepare('DELETE FROM room_ownership WHERE user_id = ? AND room_id = ?').bind(actor.id, roomId).run();
          else await syncRoomDirectory(env, roomId, result.body);
          return json({ roomId, ...result.body as object }, result.status);
        } catch (error) {
          // A lost RPC response does not prove creation failed. Keep the known ID
          // so a caller can GET it, instead of silently creating an orphan duplicate.
          if (dispatched) return json({ error: 'room_creation_uncertain', roomId }, 503);
          await env.DB.prepare('DELETE FROM room_ownership WHERE user_id = ? AND room_id = ?').bind(actor.id, roomId).run();
          throw error;
        }
      }
      const roomRoute = /^\/v1\/rooms\/([^/]+)(?:\/(join|leave|ready|team|settings|prepare|start|return|return-eligibility|chat|messages))?$/.exec(path);
      if (roomRoute && roomIdPattern.test(roomRoute[1])) {
        const action = roomRoute[2] ?? 'get';
        if ((action === 'get' && request.method !== 'GET') || (action !== 'get' && request.method !== 'POST')) throw new ApiError(405, 'method_not_allowed');
        const body = action === 'get' ? {} : await readJson(request);
        if (action === 'chat' || action === 'messages') {
          const result = await env.ROOMS.getByName(roomRoute[1]).chat(actor, action, body);
          return json(result.body, result.status);
        }
        if (action === 'start') {
          fields(body, []);
          const claimed = await env.ROOMS.getByName(roomRoute[1]).claimStart(actor.id, roomRoute[1], crypto.randomUUID());
          if (!claimed.claim) throw new ApiError(claimed.status, claimed.error ?? 'room_start_failed');
          return await createBattleFromRoomClaim(actor, claimed.claim, env);
        }
        if (action === 'return') {
          fields(body, ['battleId']);
          if (typeof body.battleId !== 'string' || !BATTLE_ID.test(body.battleId)) throw new ApiError(400, 'invalid_battle_id');
          const authorized = await env.ROOMS.getByName(roomRoute[1]).authorizeReturn(actor.id, body.battleId);
          if (authorized.status >= 400) throw new ApiError(authorized.status, authorized.error ?? 'room_return_failed');
          if (!await privateBattleReturnable(env, roomRoute[1], body.battleId)) {
            throw new ApiError(409, 'private_battle_not_returnable');
          }
          const returned = await env.ROOMS.getByName(roomRoute[1]).returnFromBattle(actor.id, body.battleId);
          if (returned.status < 400) await syncRoomDirectory(env, roomRoute[1], returned.body);
          return json({ roomId: roomRoute[1], ...returned.body as object }, returned.status);
        }
        if (action === 'return-eligibility') {
          fields(body, ['battleId']);
          if (typeof body.battleId !== 'string' || !BATTLE_ID.test(body.battleId)) {
            throw new ApiError(400, 'invalid_battle_id');
          }
          const authorized = await env.ROOMS.getByName(roomRoute[1])
            .authorizeReturn(actor.id, body.battleId);
          if (authorized.status >= 400) {
            throw new ApiError(authorized.status, authorized.error ?? 'room_return_failed');
          }
          if (!await privateBattleReturnable(env, roomRoute[1], body.battleId)) {
            throw new ApiError(409, 'private_battle_not_returnable');
          }
          if (typeof authorized.matchId !== 'string') throw new ApiError(503, 'room_unreadable');
          return json({ roomId: roomRoute[1], battleId: body.battleId,
            matchId: authorized.matchId, status: 'returnable', owner: true });
        }
        const result = await env.ROOMS.getByName(roomRoute[1]).command(actor, action, body);
        if (action === 'leave' && result.status < 400) {
          await env.DB.prepare('DELETE FROM room_ownership WHERE user_id = ? AND room_id = ?').bind(actor.id, roomRoute[1]).run();
        }
        if (result.status < 400) await syncRoomDirectory(env, roomRoute[1], result.body);
        return json({ roomId: roomRoute[1], ...result.body as object }, result.status);
      }
      throw new ApiError(404, 'not_found');
    } catch (error) {
      return failure(error, request);
    }
  } };
}

export default createApp(verifyConnectIdToken);
