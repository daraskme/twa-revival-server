// Shared social state. The caller identity is supplied by the authenticated
// Worker, never by native-client JSON. Persistence belongs to the DO adapter.
import type {PartyPresentation} from './party-presentation';
import {GROUP_ADMISSION_CAPACITY, GROUP_ADMISSION_LIFETIME_MS, GROUP_ADMISSION_RETENTION_MS,
  groupActive, groupIdentifier, groupRequestIdentifier, type GroupAdmissionAttempt, type GroupAdmissionMember,
  type GroupAdmissionRequest, type GroupAdmissionTerminalPhase} from './group-admission';
export type Presence = 'offline' | 'online' | 'in_party' | 'matchmaking' | 'in_battle';
export interface Person { id: string; displayName: string }
export interface Party {
  id: string; leader: string; members: string[]; ready: string[];
  invitations: Record<string, number>; mode: 'pve' | 'pvp'; ruleset: 'territory' | 'annihilation';
  revision: number; state: 'lobby' | 'matchmaking' | 'battle';
  presentations?: Record<string, PartyPresentation | null>;
  groupAttemptId?: string;
}
export interface SocialData {
  version: 1; revision: number;
  people: Record<string, Person>;
  links: Record<string, { a: string; b: string; requestedBy: string; accepted: boolean }>;
  presence: Record<string, { state: Presence; expires: number }>;
  parties: Record<string, Party>;
  recent: Record<string, Array<{id:string; battleId:string; playedAt:number}>>;
  groupAttempts?: Record<string, GroupAdmissionAttempt>;
}
export class SocialError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new SocialError(status, code); };
const key = (a: string, b: string) => JSON.stringify([a, b].sort());
export const emptySocial = (): SocialData => ({version: 1, revision: 0, people: {}, links: {}, presence: {}, parties: {}, recent:{}});
const inviteLifetime = 300_000;
const presenceLifetime = 45_000;
const relationshipLimit = 200;
// Native lobby parties have four slots; battle roster limits are separate.
const partyMemberLimit = 4;

export class SocialState {
  constructor(public data: SocialData, private now: number, private uuid: () => string) {}
  private touch() { this.data.revision++; }
  private party(id: string) { return Object.values(this.data.parties).find(p => p.members.includes(id)); }
  private person(id: unknown): Person {
    if (typeof id !== 'string' || !Object.hasOwn(this.data.people, id)) return fail(404, 'player_not_found');
    return this.data.people[id];
  }
  register(actor: Person) {
    if (!actor.id || !actor.displayName || actor.id.length > 128 || actor.displayName.length > 128) fail(400, 'invalid_actor');
    if (this.data.people[actor.id]?.displayName !== actor.displayName) { this.data.people[actor.id] = {...actor}; this.touch(); }
  }
  // Called only by the server's verified battle participant path. Never offer
  // a client route that accepts an arbitrary list of recent players.
  recordBattle(battleId:string, participants:Person[], playedAt:number) {
    if(!battleId || battleId.length>128 || !Number.isSafeInteger(playedAt) || playedAt<0 || playedAt>this.now) fail(400,'invalid_recent_battle');
    if(participants.length>20 || new Set(participants.map(p=>p.id)).size!==participants.length) fail(400,'invalid_recent_participants');
    let changed=false;
    for(const p of participants)this.register(p);
    for(const p of participants){
      const recent=this.data.recent[p.id]??[];
      for(const other of participants){
        if(other.id===p.id)continue;
        const old=recent.find(row=>row.id===other.id);
        if(old){if(old.playedAt<playedAt){Object.assign(old,{battleId,playedAt});changed=true;}}
        else {recent.push({id:other.id,battleId,playedAt});changed=true;}
      }
      this.data.recent[p.id]=recent.sort((a,b)=>b.playedAt-a.playedAt||a.id.localeCompare(b.id)).slice(0,50);
    }
    if(changed)this.touch();
  }
  private link(a: string, b: string) { return this.data.links[key(a,b)]; }
  private assertLobby(p: Party) { if (p.state !== 'lobby') fail(409, 'party_busy'); }
  private ownParty(actor: string, expectedPartyId?: unknown): Party {
    // Omission preserves the legacy actor-current-party API. New native
    // readiness requests always bind to the party observed before the POST.
    if (expectedPartyId !== undefined && (typeof expectedPartyId !== 'string'
        || !/^[A-Za-z0-9_-]{1,128}$/.test(expectedPartyId))) fail(400, 'invalid_party_id');
    const p=this.party(actor) ?? fail(409, 'not_in_party');
    if (expectedPartyId !== undefined && p.id !== expectedPartyId) fail(409, 'party_membership_mismatch');
    return p;
  }
  private leader(actor: string): Party {
    const p=this.ownParty(actor); if (p.leader !== actor) fail(403, 'party_leader_required'); return p;
  }
  private changed(p: Party) { p.revision++; p.ready=[]; this.touch(); }
  status(id: string): Presence {
    const presence=this.data.presence[id];
    if (!presence || presence.expires <= this.now || presence.state === 'offline') return 'offline';
    const p=this.party(id);
    if (p?.state === 'battle') return 'in_battle';
    if (p?.state === 'matchmaking') return 'matchmaking';
    if (presence.state === 'in_battle' || presence.state === 'matchmaking') return presence.state;
    return p ? 'in_party' : 'online';
  }
  heartbeat(actor: string, state: unknown) {
    if (!['offline','online','matchmaking','in_battle'].includes(String(state))) fail(400,'invalid_presence');
    this.data.presence[actor]={state: state as Presence, expires: this.now+presenceLifetime};
  }
  request(actor: string, target: unknown) {
    const id=this.person(target).id;
    if (actor === id) fail(400,'cannot_friend_self');
    if (this.link(actor,id)) return;
    for (const player of [actor,id]) if (Object.values(this.data.links).filter(l=>l.a===player||l.b===player).length >= relationshipLimit) fail(409,'friend_limit');
    this.data.links[key(actor,id)]={a:actor,b:id,requestedBy:actor,accepted:false}; this.touch();
  }
  respond(actor: string, target: unknown, accept: unknown) {
    if (typeof accept !== 'boolean') fail(400,'invalid_accept');
    const id=this.person(target).id, l=this.link(actor,id);
    if (!l || l.requestedBy === actor) fail(403,'incoming_request_required');
    if (l.accepted) return;
    if (accept) l.accepted=true; else delete this.data.links[key(actor,id)];
    this.touch();
  }
  removeFriend(actor: string, target: unknown) {
    const id=this.person(target).id;
    delete this.data.links[key(actor,id)];
    for (const p of Object.values(this.data.parties)) if (p.leader===actor) delete p.invitations[id]; else if (p.leader===id) delete p.invitations[actor];
    this.touch();
  }
  create(actor: string) {
    const old=this.party(actor); if(old) return old;
    const id=this.uuid();
    const p: Party={id,leader:actor,members:[actor],ready:[],invitations:{},mode:'pvp',ruleset:'territory',revision:1,state:'lobby'};
    this.data.parties[id]=p; this.touch(); return p;
  }
  invite(actor: string, target: unknown) {
    const id=this.person(target).id, p=this.leader(actor); this.assertLobby(p);
    if (!this.link(actor,id)?.accepted) fail(403,'friend_required');
    if (this.party(id)) fail(409,'already_in_party');
    if (this.status(id)==='offline') fail(409,'player_offline');
    if (p.members.length>=partyMemberLimit) fail(409,'party_full');
    if (Object.keys(p.invitations).length>=relationshipLimit && !p.invitations[id]) fail(409,'invitation_limit');
    p.invitations[id]=this.now+inviteLifetime; this.touch();
  }
  join(actor: string, partyId: unknown, accept: unknown) {
    if (typeof accept!=='boolean' || typeof partyId!=='string') fail(400,'invalid_invitation_response');
    const p=this.data.parties[partyId as string];
    if(p?.members.includes(actor) && accept===true)return;
    if (!p || !(p.invitations[actor]>this.now)) fail(403,'valid_invitation_required');
    this.assertLobby(p);
    if (accept) {
      if (this.party(actor)) fail(409,'already_in_party');
      if (p.members.length>=partyMemberLimit) fail(409,'party_full');
      if (!this.link(p.leader,actor)?.accepted) fail(403,'friend_required');
      p.members.push(actor); this.changed(p);
    }
    delete p.invitations[actor]; this.touch();
  }
  leave(actor: string, target: unknown=actor) {
    const p=this.ownParty(actor); this.assertLobby(p);
    if (typeof target!=='string' || !p.members.includes(target)) fail(404,'party_member_not_found');
    if (target!==actor && p.leader!==actor) fail(403,'party_leader_required');
    p.members=p.members.filter(id=>id!==target);
    if (!p.members.length) delete this.data.parties[p.id];
    else { if (p.leader===target) {p.leader=p.members[0];p.invitations={};} this.changed(p); }
    this.touch();
  }
  transfer(actor: string, target: unknown) {
    const p=this.leader(actor); this.assertLobby(p);
    if (typeof target!=='string' || !p.members.includes(target)) fail(404,'party_member_not_found');
    p.leader=target as string; p.invitations={}; this.changed(p);
  }
  settings(actor: string, mode: unknown, ruleset: unknown, expectedPartyId?: unknown) {
    const p=this.ownParty(actor,expectedPartyId);
    if(p.leader!==actor)fail(403,'party_leader_required');
    this.assertLobby(p);
    if ((mode!=='pve'&&mode!=='pvp') || (ruleset!=='territory'&&ruleset!=='annihilation')) fail(400,'invalid_party_settings');
    // Restored clients can repeat the current mode. Preserve readiness and
    // revision for that retry; a real mode change requires everyone to Ready.
    if(p.mode===mode && p.ruleset===ruleset)return;
    p.mode=mode as Party['mode'];p.ruleset=ruleset as Party['ruleset'];this.changed(p);
  }
  ready(actor: string, ready: unknown, expectedPartyId?: unknown) {
    if (typeof ready!=='boolean') fail(400,'invalid_ready');
    const p=this.ownParty(actor,expectedPartyId);this.assertLobby(p);
    p.ready=p.ready.filter(id=>id!==actor);if(ready)p.ready.push(actor);p.revision++;this.touch();
  }
  // Server-only refresh. A changed selection invalidates that member's ready
  // state and changes the member DTO so native subscribers receive an update.
  updatePresentations(actor: string, values: Record<string, PartyPresentation | null>) {
    const p=this.ownParty(actor);
    if(p.state!=='lobby')return;
    if(Object.keys(values).length!==p.members.length || p.members.some(id=>!Object.hasOwn(values,id))) {
      fail(503,'invalid_party_selection');
    }
    let changed=p.presentations===undefined;
    for(const id of p.members) {
      if(JSON.stringify(p.presentations?.[id]??null)!==JSON.stringify(values[id])) {
        p.ready=p.ready.filter(member=>member!==id);changed=true;
      }
    }
    p.presentations=structuredClone(values);
    if(changed){p.revision++;this.touch();}
  }
  /** Only the authenticated Worker orchestration can call these admission
   * methods. Membership and the attempt owner are always derived here. */
  groupReservationParty(actor: string, request: GroupAdmissionRequest) {
    if (!groupIdentifier(request.partyId)) fail(400, 'invalid_party_id');
    if (!groupRequestIdentifier(request.requestId)) fail(400, 'invalid_group_request_id');
    if (!Number.isSafeInteger(request.partyRevision) || request.partyRevision < 1) fail(400, 'invalid_party_revision');
    if (!Number.isSafeInteger(request.leaderLoadoutRevision) || request.leaderLoadoutRevision < 0) fail(400, 'invalid_loadout_revision');
    if ((request.mode !== 'pve' && request.mode !== 'pvp') ||
        (request.ruleset !== 'territory' && request.ruleset !== 'annihilation')) fail(400, 'invalid_party_settings');
    const p = this.ownParty(actor, request.partyId);
    if (p.leader !== actor) fail(403, 'party_leader_required');
    return p;
  }
  replayGroup(actor: string, request: GroupAdmissionRequest): GroupAdmissionAttempt | null {
    const p = this.groupReservationParty(actor, request);
    const previous = Object.values(this.data.groupAttempts ?? {}).find(attempt =>
      attempt.ownerId === actor && attempt.requestId === request.requestId);
    if (previous) {
      if (previous.partyId !== request.partyId || previous.partyRevision !== request.partyRevision ||
          previous.leaderLoadoutRevision !== request.leaderLoadoutRevision || previous.mode !== request.mode ||
          previous.ruleset !== request.ruleset) fail(409, 'group_request_conflict');
      return structuredClone(previous);
    }
    const active = p.groupAttemptId ? this.data.groupAttempts?.[p.groupAttemptId] : undefined;
    if (active && groupActive(active)) {
      if (active.ownerId !== actor || active.mode !== request.mode || active.ruleset !== request.ruleset ||
          active.leaderLoadoutRevision !== request.leaderLoadoutRevision ||
          (request.partyRevision !== active.partyRevision && request.partyRevision !== p.revision)) fail(409, 'group_request_conflict');
      return structuredClone(active);
    }
    return null;
  }
  reserveGroup(actor: string, request: GroupAdmissionRequest, members: GroupAdmissionMember[]): GroupAdmissionAttempt {
    const previous = this.replayGroup(actor, request);
    if (previous) return previous;
    const p = this.groupReservationParty(actor, request);
    this.assertLobby(p);
    if (p.revision !== request.partyRevision) fail(409, 'party_revision_conflict');
    if (p.mode !== request.mode || p.ruleset !== request.ruleset) fail(409, 'party_settings_conflict');
    // Clicking Play is the authenticated leader's ready intent. Followers
    // must already have readied the exact selection that is frozen below.
    if (!p.members.every(id => id === actor || p.ready.includes(id))) fail(409, 'party_not_ready');
    if (members.length !== p.members.length || members.some((member, index) => member.userId !== p.members[index])) {
      fail(503, 'invalid_party_members');
    }
    const leader = members.find(member => member.userId === actor)!;
    if (leader.loadoutRevision !== request.leaderLoadoutRevision) fail(409, 'party_selection_changed');
    for (const member of members) {
      const presentation = p.presentations?.[member.userId];
      if (!presentation || presentation.commanderId !== member.loadout.commanderId ||
          presentation.loadoutRevision !== member.loadoutRevision || presentation.units.length !== 3 ||
          presentation.units.some((unit, index) => unit !== member.loadout.units[index]?.key)) {
        fail(409, 'party_selection_changed');
      }
    }
    // Retain terminal idempotency receipts for a full day. Active leases are
    // never collected by age: an in-flight RPC may already have queued seats.
    const attempts = this.data.groupAttempts ?? {};
    const retained = Object.fromEntries(Object.entries(attempts).filter(([, attempt]) =>
      groupActive(attempt) || attempt.expiresAt + GROUP_ADMISSION_RETENTION_MS > this.now));
    if (Object.keys(retained).length >= GROUP_ADMISSION_CAPACITY) fail(503, 'group_admission_capacity');
    const attempt: GroupAdmissionAttempt = {attemptId: this.uuid(), requestId: request.requestId,
      partyId: p.id, partyRevision: p.revision, leaderLoadoutRevision: request.leaderLoadoutRevision,
      ownerId: p.leader, mode: p.mode, ruleset: p.ruleset,
      members: structuredClone(members), phase: 'pending', createdAt: this.now,
      expiresAt: this.now + GROUP_ADMISSION_LIFETIME_MS};
    retained[attempt.attemptId] = attempt;
    this.data.groupAttempts = retained;
    // Accepted Play also readies the leader's frozen selection. Native party
    // UI uses the own-member ready flag to start its queue clock.
    p.ready = [...p.members];
    p.groupAttemptId = attempt.attemptId; p.state = 'matchmaking'; p.revision++; this.touch();
    return structuredClone(attempt);
  }
  getGroup(actor: string, attemptId?: unknown): GroupAdmissionAttempt | null {
    if (attemptId !== undefined && !groupIdentifier(attemptId)) fail(400, 'invalid_group_attempt_id');
    const id = attemptId ?? this.party(actor)?.groupAttemptId;
    if (id === undefined) return null;
    const attempts = this.data.groupAttempts ?? {};
    const attempt = (Object.hasOwn(attempts, id as string) ? attempts[id as string] : undefined)
      ?? fail(404, 'group_attempt_not_found');
    if (!attempt.members.some(member => member.userId === actor)) fail(404, 'group_attempt_not_found');
    return structuredClone(attempt);
  }
  private mutableGroup(actor: string, attemptId: unknown): GroupAdmissionAttempt {
    if (attemptId === undefined) fail(400, 'invalid_group_attempt_id');
    const attempt = this.getGroup(actor, attemptId) ?? fail(404, 'group_attempt_not_found');
    return this.data.groupAttempts![attempt.attemptId];
  }
  confirmGroup(actor: string, attemptId: unknown, assignmentId?: unknown, battleId?: unknown, phaseHint?: unknown,
      matchmakerRevision?: unknown): GroupAdmissionAttempt {
    const attempt = this.mutableGroup(actor, attemptId);
    if (assignmentId !== undefined && !groupIdentifier(assignmentId)) fail(400, 'invalid_assignment_id');
    if (battleId !== undefined && !groupIdentifier(battleId)) fail(400, 'invalid_battle_id');
    if (phaseHint !== undefined && phaseHint !== 'queued') fail(400, 'invalid_group_confirmation');
    if (phaseHint === 'queued' && (assignmentId !== undefined || battleId !== undefined)) fail(400, 'invalid_group_confirmation');
    if (matchmakerRevision !== undefined) {
      if (typeof matchmakerRevision !== 'number' || !Number.isSafeInteger(matchmakerRevision) || matchmakerRevision < 0) {
        fail(400, 'invalid_matchmaker_revision');
      }
      const revision = matchmakerRevision as number;
      if (attempt.matchmakerRevision !== undefined && revision < attempt.matchmakerRevision) return structuredClone(attempt);
      if (!groupActive(attempt)) fail(409, 'group_attempt_closed');
      const observedPhase = battleId !== undefined ? 'battle' : assignmentId !== undefined ? 'assigned' : 'queued';
      const observedAssignment = assignmentId as string | undefined;
      const observedBattle = battleId as string | undefined;
      if (observedPhase === 'battle' && observedAssignment === undefined) fail(400, 'assignment_required');
      const priorPhase = attempt.phase === 'cancelling'
        ? attempt.battleId ? 'battle' : attempt.assignmentId ? 'assigned' : 'queued' : attempt.phase;
      if (attempt.matchmakerRevision === revision) {
        if (observedPhase !== priorPhase || observedAssignment !== attempt.assignmentId || observedBattle !== attempt.battleId) {
          fail(409, 'group_confirmation_conflict');
        }
        return structuredClone(attempt);
      }
      if (attempt.phase === 'battle' && (observedPhase !== 'battle' || observedAssignment !== attempt.assignmentId ||
          observedBattle !== attempt.battleId)) fail(409, 'group_battle_active');
      const p = this.data.parties[attempt.partyId];
      if (!p || p.groupAttemptId !== attempt.attemptId) fail(503, 'group_lease_mismatch');
      attempt.matchmakerRevision = revision;
      if (observedAssignment === undefined) delete attempt.assignmentId; else attempt.assignmentId = observedAssignment;
      if (observedBattle === undefined) delete attempt.battleId; else attempt.battleId = observedBattle;
      if (attempt.phase !== 'cancelling' || observedPhase === 'battle') attempt.phase = observedPhase;
      p.state = attempt.phase === 'battle' ? 'battle' : 'matchmaking'; p.revision++; this.touch();
      return structuredClone(attempt);
    }
    if (attempt.matchmakerRevision !== undefined) fail(400, 'matchmaker_revision_required');
    if (phaseHint === 'queued' && attempt.phase === 'cancelling') return structuredClone(attempt);
    if (!groupActive(attempt) || (attempt.phase === 'cancelling' && battleId === undefined)) fail(409, 'group_attempt_closed');
    if (assignmentId !== undefined && attempt.assignmentId !== undefined && assignmentId !== attempt.assignmentId) {
      fail(409, 'group_assignment_conflict');
    }
    if (battleId !== undefined && attempt.battleId !== undefined && battleId !== attempt.battleId) fail(409, 'group_battle_conflict');
    if (battleId !== undefined && assignmentId === undefined && attempt.assignmentId === undefined) fail(400, 'assignment_required');
    const p = this.data.parties[attempt.partyId];
    if (!p || p.groupAttemptId !== attempt.attemptId) fail(503, 'group_lease_mismatch');
    // A different group leaving a mixed assignment can atomically requeue us.
    // Only the Worker acknowledgement of that durable Matchmaker result may
    // clear assigned metadata; it cannot reverse a battle or cancellation.
    if (phaseHint === 'queued') {
      if (attempt.phase === 'battle') fail(409, 'group_battle_active');
      if (attempt.phase !== 'queued' || attempt.assignmentId !== undefined) {
        attempt.phase = 'queued'; delete attempt.assignmentId;
        p.state = 'matchmaking'; p.revision++; this.touch();
      }
      return structuredClone(attempt);
    }
    const phase = battleId !== undefined ? 'battle' : assignmentId !== undefined ? 'assigned' : 'queued';
    const rank = {pending: 0, queued: 1, assigned: 2, battle: 3, cancelling: 4, cancelled: 5, expired: 5, completed: 5, failed: 5};
    let changed = false;
    if (assignmentId !== undefined && attempt.assignmentId === undefined) {attempt.assignmentId = assignmentId as string; changed = true;}
    if (battleId !== undefined && attempt.battleId === undefined) {attempt.battleId = battleId as string; changed = true;}
    if (rank[phase] > rank[attempt.phase] || (attempt.phase === 'cancelling' && phase === 'battle')) {attempt.phase = phase; changed = true;}
    if (changed) {
      p.state = attempt.phase === 'battle' ? 'battle' : 'matchmaking'; p.revision++; this.touch();
    }
    return structuredClone(attempt);
  }
  requestCancelGroup(actor: string, attemptId: unknown): GroupAdmissionAttempt {
    const attempt = this.mutableGroup(actor, attemptId);
    if (!groupActive(attempt) || attempt.phase === 'cancelling') return structuredClone(attempt);
    if (attempt.phase === 'battle') fail(409, 'group_battle_active');
    attempt.phase = 'cancelling'; this.touch();
    return structuredClone(attempt);
  }
  /** Finish is a trusted acknowledgement of a durable Matchmaker tombstone or
   * terminal D1 battle. Wall-clock expiry alone never releases this lease. */
  finishGroup(actor: string, attemptId: unknown, phase: unknown): GroupAdmissionAttempt {
    const attempt = this.mutableGroup(actor, attemptId);
    if (typeof phase !== 'string' || !['cancelled', 'expired', 'completed', 'failed'].includes(phase)) fail(400, 'invalid_group_terminal_phase');
    if (!groupActive(attempt)) {
      if (attempt.phase !== phase) fail(409, 'group_attempt_closed');
      return structuredClone(attempt);
    }
    const p = this.data.parties[attempt.partyId];
    if (!p || p.groupAttemptId !== attempt.attemptId) fail(503, 'group_lease_mismatch');
    attempt.phase = phase as GroupAdmissionTerminalPhase;
    p.state = 'lobby'; p.ready = []; p.revision++; this.touch();
    return structuredClone(attempt);
  }
  snapshot(actor: string) {
    const rows=Object.values(this.data.links).filter(l=>l.a===actor||l.b===actor);
    const friendView=(id:string)=>({...this.data.people[id],status:this.status(id)});
    const p=this.party(actor);
    return {revision:this.data.revision,
      friends:rows.filter(l=>l.accepted).map(l=>friendView(l.a===actor?l.b:l.a)),
      incoming:rows.filter(l=>!l.accepted&&l.requestedBy!==actor).map(l=>({...this.data.people[l.requestedBy]})),
      outgoing:rows.filter(l=>!l.accepted&&l.requestedBy===actor).map(l=>({...this.data.people[l.a===actor?l.b:l.a]})),
      recent:(this.data.recent[actor]??[]).map(row=>({...this.data.people[row.id],battleId:row.battleId,playedAt:row.playedAt,
        relationship:this.link(actor,row.id)?.accepted?'friend':this.link(actor,row.id)?'pending':'none'})),
      party:p?{id:p.id,leader:p.leader,revision:p.revision,mode:p.mode,ruleset:p.ruleset,state:p.state,
        members:p.members.map(id=>({...friendView(id),ready:p.ready.includes(id),
          ...(p.presentations?{presentation:p.presentations[id]??null}:{})}))}:null,
      invitations:Object.values(this.data.parties).filter(p=>p.invitations[actor]>this.now)
        .map(p=>({partyId:p.id,leader:{...this.data.people[p.leader]},expiresAt:p.invitations[actor]}))};
  }
}
