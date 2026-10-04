import {ApiError, fields} from './http';
import {requestedRuleset} from './battle-rules';
import {requirePublicQueueRuleset, nativeMatchmaking} from './native-release';
import {groupActive, type GroupAdmissionAttempt} from './group-admission';
import type {Actor, Env} from './types';
type PolicyView = {assignment?: {rosterPolicy?: {version: 1 | 2 | 3 | 4 | 5} | null} | null};

/** Cross-DO calls occur here, outside either DO's serialized transaction.
 * Persist Social intent first, then reconcile the same durable Matchmaker key.
 * An exception never implies that the remote mutation did not happen. */
export async function partyMatchmaking(actor: Actor, action: 'get' | 'start' | 'cancel' | 'join', body: Record<string, unknown>, env: Env): Promise<{status: number; body: Parameters<typeof nativeMatchmaking>[0] & Record<string, unknown>}> {
  const social = env.SOCIAL.getByName('social-v1');
  const matcher = env.MATCHMAKER.getByName('standard-v1');
  // A claimed/assigned party advertises its frozen version, including legacy
  // v2 after an upgrade. Pending parties advertise the next assignment policy.
  const summaryFor = (attempt: GroupAdmissionAttempt, view?: PolicyView | {error: string}) =>
    summary(attempt, actor.id, view && 'assignment' in view && view.assignment?.rosterPolicy
      ? view.assignment.rosterPolicy.version : env.NATIVE_PUBLIC_PROTOCOL === 'twa-relay-v1' ? 5 : 2);
  if (action === 'start') fields(body, ['partyId', 'partyRevision', 'requestId', 'mode', 'ruleset', 'leaderLoadoutRevision']);
  else if (action === 'cancel') fields(body, ['attemptId']);
  else fields(body, action === 'join' ? ['mode', 'ruleset'] : []);
  if (action === 'join' || action === 'start') {
    requirePublicQueueRuleset(env, requestedRuleset(body.ruleset), body.mode);
    // Reconcile a crashed/ended battle before reserveGroup's lobby-state
    // guard. Requiring a separate successful GET first stranded returning
    // players whose next request was Play.
    const reconciled = await partyMatchmaking(actor, 'get', {}, env);
    if (reconciled.status >= 400) throw new ApiError(reconciled.status,
      (reconciled.body as {error: string}).error);
  }

  const read = (result: {status: number; body: unknown}): GroupAdmissionAttempt | null => {
    if (result.status >= 400) throw new ApiError(result.status, (result.body as {error: string}).error);
    return result.body as GroupAdmissionAttempt | null;
  };
  let attempt = read(action === 'start' ? await social.reserveGroup(actor, body) :
    await social.getGroup(actor, action === 'cancel' && body.attemptId !== undefined ? {attemptId: body.attemptId} : {}));
  if (action === 'join' && attempt && groupActive(attempt)) throw new ApiError(409, 'party_attempt_active');
  if (!attempt || !groupActive(attempt)) {
    if (action === 'cancel' && body.attemptId !== undefined && !attempt) throw new ApiError(404, 'party_attempt_not_found');
    const result = await matcher.command(actor, action === 'join' ? 'join' : action === 'cancel' && body.attemptId === undefined ? 'cancel' : 'get', action === 'join' ? body : {});
    return {status: result.status, body: {...result.body, partyAttempt: attempt ? summaryFor(attempt, result.body) : null}};
  }
  if ((action === 'cancel' && attempt.phase !== 'battle') || (attempt.expiresAt <= Date.now() && attempt.phase !== 'battle')) {
    attempt = read(await social.requestCancelGroup(actor, {attemptId: attempt.attemptId}))!;
  }

  // A concurrent cancellation can become visible after admission confirmation.
  // Bound retries; pending/cancelling stays durable for the next own GET.
  let lastView: PolicyView | undefined;
  try {
    for (let pass = 0; pass < 3; pass++) {
      const cancel = attempt.phase === 'cancelling';
      let result = await matcher.group(actor, cancel ? 'cancel' : 'get', attempt);
      if ('error' in result.body) throw new ApiError(result.status, result.body.error);
      lastView = result.body.view;
      if (!result.body.attempt && attempt.phase === 'pending' && !cancel) {
        result = await matcher.group(actor, 'reserve', attempt);
        if ('error' in result.body) {
          const failure = result;
          // A definite rejection is still fenced with a tombstone before Social
          // unlocks: an earlier uncertain request may yet reach Matchmaker.
          attempt = read(await social.requestCancelGroup(actor, {attemptId: attempt.attemptId}))!;
          const stopped = await matcher.group(actor, 'cancel', attempt);
          if ('error' in stopped.body) throw new ApiError(stopped.status, stopped.body.error);
          if (stopped.body.attempt?.phase === 'battle') {
            attempt = read(await social.confirmGroup(actor, {attemptId: attempt.attemptId,
              assignmentId: stopped.body.attempt.assignmentId, battleId: stopped.body.attempt.battleId, matchmakerRevision: stopped.body.attempt.matchmakerRevision}))!;
            return {status: 409, body: {...stopped.body.view, error: 'party_already_claimed', partyAttempt: summaryFor(attempt, stopped.body.view)}};
          }
          attempt = read(await social.finishGroup(actor, {attemptId: attempt.attemptId,
            phase: attempt.expiresAt <= Date.now() ? 'expired' : 'failed'}))!;
          return {status: failure.status, body: {...stopped.body.view, error: (failure.body as {error: string}).error, partyAttempt: summaryFor(attempt, stopped.body.view)}};
        }
      }
      const remote = result.body.attempt;
      lastView = result.body.view;
      if (!remote) {
        attempt = read(await social.requestCancelGroup(actor, {attemptId: attempt.attemptId}))!;
        continue;
      }
      if (remote.phase === 'battle') {
        attempt = read(await social.confirmGroup(actor, {attemptId: attempt.attemptId,
          assignmentId: remote.assignmentId, battleId: remote.battleId, matchmakerRevision: remote.matchmakerRevision}))!;
        if (action === 'cancel') return {status: 409, body: {...result.body.view, error: 'party_already_claimed', partyAttempt: summaryFor(attempt, result.body.view)}};
        const finished = await matcher.group(actor, 'finish', attempt);
        if (!('error' in finished.body) && finished.body.attempt?.phase === 'completed') {
          attempt = read(await social.finishGroup(actor, {attemptId: attempt.attemptId, phase: 'completed'}))!;
          return {status: 200, body: {...finished.body.view, partyAttempt: summaryFor(attempt, finished.body.view)}};
        }
        if ('error' in finished.body && finished.status !== 409) throw new ApiError(finished.status, finished.body.error);
      } else if (!groupActive(remote)) {
        attempt = read(await social.finishGroup(actor, {attemptId: attempt.attemptId, phase: remote.phase}))!;
      } else {
        attempt = read(await social.confirmGroup(actor, {attemptId: attempt.attemptId,
          matchmakerRevision: remote.matchmakerRevision, ...(remote.assignmentId ? {assignmentId: remote.assignmentId} : {phase: 'queued'})}))!;
        if (attempt.phase === 'cancelling' || (attempt.matchmakerRevision ?? 0) > (remote.matchmakerRevision ?? 0)) continue;
      }
      return {status: action === 'start' && attempt.phase === 'queued' ? 202 : 200,
        body: {...result.body.view, partyAttempt: summaryFor(attempt, result.body.view)}};
    }
    throw new ApiError(503, 'party_attempt_reconciling');
  } catch (error) {
    throw new ApiError(error instanceof ApiError ? error.status : 503,
      error instanceof ApiError ? error.code : 'party_attempt_reconciling', {
        status: 'queued', nativeBattles: false, pollAfterMs: 2000, ticket: null, assignment: null,
        partyAttempt: summaryFor(attempt, lastView),
      });
  }
}

function summary(attempt: GroupAdmissionAttempt, userId: string, rosterPolicyVersion: 1 | 2 | 3 | 4 | 5) {
  return {attemptId: attempt.attemptId, partyId: attempt.partyId, phase: attempt.phase,
    mode: attempt.mode, ruleset: attempt.ruleset, memberIds: attempt.members.map(m => m.userId),
    memberCount: attempt.members.length, ownLoadoutRevision: attempt.members.find(m => m.userId === userId)!.loadoutRevision,
    createdAt: attempt.createdAt, expiresAt: attempt.expiresAt, rosterPolicyVersion,
    ...(attempt.assignmentId ? {assignmentId: attempt.assignmentId} : {}), ...(attempt.battleId ? {battleId: attempt.battleId} : {})};
}
