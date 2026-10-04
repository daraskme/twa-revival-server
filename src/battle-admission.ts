import type {Env} from './types';

// The global Matchmaker awaits this relay observation while serializing queue
// mutations. A stalled relay must delay release, never hold every queue caller.
const RELAY_OBSERVATION_TIMEOUT_MS = 1_500;
type AdmissionObservation = {released: boolean; failed: boolean};
const FAILED: AdmissionObservation = {released: false, failed: true};
const NOT_RELEASED: AdmissionObservation = {released: false, failed: false};
const RELEASED: AdmissionObservation = {released: true, failed: false};

/** A released transport lease is separate from result/reward settlement. */
export async function battleAdmissionReleased(
  env: Env, battleId: string, createdAt: number, userIds?: string[],
): Promise<boolean> {
  return (await observeBattleAdmission(env, battleId, createdAt, userIds)).released;
}

/** Distinguish an active relay from an unreachable one. Only failed observations
 * may be briefly retried less often by the global Matchmaker. */
export async function observeBattleAdmission(
  env: Env, battleId: string, createdAt: number, userIds?: string[],
): Promise<AdmissionObservation> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AdmissionObservation>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(FAILED);
    }, RELAY_OBSERVATION_TIMEOUT_MS);
  });
  try {
    const observe = async (): Promise<AdmissionObservation> => {
      const response = await env.BATTLE_RELAY.getByName(battleId).fetch('https://relay/retire-unstarted', {
        method: 'POST', headers: {'content-type': 'application/json'}, signal: controller.signal,
        body: JSON.stringify({battleId, createdAt: createdAt * 1000}),
      });
      if (controller.signal.aborted) return FAILED;
      if (!response.ok) { await response.body?.cancel(); return FAILED; }
      const state = await response.json() as {
        battle_id?: unknown; phase?: unknown; seats?: Array<{player_id?: unknown; transport?: unknown}>;
      };
      if (controller.signal.aborted || state.battle_id !== battleId) return FAILED;
      if (state.phase === 'ended') return RELEASED;
      if (!userIds?.length) return NOT_RELEASED;
      if (!Array.isArray(state.seats)) return FAILED;
      const participants = await env.DB.prepare('SELECT user_id, player_id FROM battle_participants WHERE battle_id = ?')
        .bind(battleId).all<{user_id: string; player_id: number}>();
      if (controller.signal.aborted) return FAILED;
      // A detached seat can still reconnect. Only the relay's irreversible
      // abandoned state permits a new admission while other players continue.
      const released = userIds.every(userId => {
        const player = participants.results.find(row => row.user_id === userId);
        return player && state.seats!.some(seat => seat.player_id === player.player_id && seat.transport === 'abandoned');
      });
      return released ? RELEASED : NOT_RELEASED;
    };
    return await Promise.race([observe(), deadline]);
  } catch { return FAILED; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
