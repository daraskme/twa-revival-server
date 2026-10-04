import {DurableObject} from 'cloudflare:workers';
import {fields, ApiError} from './http';
import type {Actor,Env} from './types';
import {SocialState,SocialError,emptySocial,type SocialData} from './social-state';
import {readPartyPresentations} from './party-presentation';
import {readGroupAdmissionMembers, type GroupAdmissionRequest} from './group-admission';
import {socialChat} from './social-chat';
import {requirePublicQueueRuleset} from './native-release';

const actions: Record<string,string[]> = {
  get:[], heartbeat:['state'], search:['name'], request:['target'], respond:['target','accept'],
  remove:['target'], create:[], invite:['target'], join:['partyId','accept'],
  leave:['target'], transfer:['target'], settings:['mode','ruleset','partyId'], ready:['ready','partyId'],
};

// One serialized social graph for this internal test deployment. No public
// fetch handler exposes caller-controlled actor identities or storage keys.
export class Social extends DurableObject<Env> {
  /** Internal RPCs are deliberately separate from command(): no public social
   * action can confirm/cancel a lease or provide trusted members/loadouts. No
   * cross-DO call runs while this Social transaction is held. */
  private async groupCommand(actor: Actor, action: 'reserve' | 'get' | 'confirm' | 'requestCancel' | 'finish', body: Record<string, unknown>) {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        fields(body, {reserve: ['partyId', 'partyRevision', 'requestId', 'mode', 'ruleset', 'leaderLoadoutRevision'],
          get: ['attemptId'], confirm: ['attemptId', 'assignmentId', 'battleId', 'phase', 'matchmakerRevision'], requestCancel: ['attemptId'],
          finish: ['attemptId', 'phase']}[action]);
        const stored = await this.ctx.storage.get<SocialData>('social');
        if (stored && stored.version !== 1) throw new ApiError(503, 'unsupported_social_state');
        const now = Date.now(), state = new SocialState(structuredClone(stored ?? emptySocial()), now, () => crypto.randomUUID());
        let result;
        if (action === 'reserve') {
          const request = body as unknown as GroupAdmissionRequest;
          result = state.replayGroup(actor.id, request);
          if (!result) {
            const party = state.groupReservationParty(actor.id, request);
            const members = await readGroupAdmissionMembers(party.members, this.env, now);
            result = state.reserveGroup(actor.id, request, members);
          }
        } else if (action === 'get') result = state.getGroup(actor.id, body.attemptId);
        else if (action === 'confirm') result = state.confirmGroup(actor.id, body.attemptId, body.assignmentId, body.battleId, body.phase, body.matchmakerRevision);
        else if (action === 'requestCancel') result = state.requestCancelGroup(actor.id, body.attemptId);
        else result = state.finishGroup(actor.id, body.attemptId, body.phase);
        await this.ctx.storage.put('social', state.data);
        return {status: 200, body: result};
      } catch (error) {
        if (error instanceof ApiError || error instanceof SocialError) return {status: error.status, body: {error: error.code}};
        throw error;
      }
    });
  }
  async reserveGroup(actor: Actor, body: Record<string, unknown>) { return this.groupCommand(actor, 'reserve', body); }
  async getGroup(actor: Actor, body: Record<string, unknown> = {}) { return this.groupCommand(actor, 'get', body); }
  async confirmGroup(actor: Actor, body: Record<string, unknown>) { return this.groupCommand(actor, 'confirm', body); }
  async requestCancelGroup(actor: Actor, body: Record<string, unknown>) { return this.groupCommand(actor, 'requestCancel', body); }
  async finishGroup(actor: Actor, body: Record<string, unknown>) { return this.groupCommand(actor, 'finish', body); }
  async command(actor:Actor,action:string,body:Record<string,unknown>) {
    return this.ctx.blockConcurrencyWhile(async()=>{
      try {
        if (['chat', 'messages', 'chatack', 'partychat', 'partymessages'].includes(action)) {
          return {status: 200, body: await socialChat(actor, action, body, this.env, this.ctx.storage)};
        }
        if(!Object.hasOwn(actions,action))throw new ApiError(404,'social_action_not_found');
        fields(body,actions[action]);
        if(action==='settings')requirePublicQueueRuleset(this.env,
          typeof body.ruleset==='string'?body.ruleset:'',body.mode);
        const stored=await this.ctx.storage.get<SocialData>('social');
        if(stored && stored.version!==1)throw new ApiError(503,'unsupported_social_state');
        const state=new SocialState(structuredClone(stored??emptySocial()),Date.now(),()=>crypto.randomUUID());
        state.register({id:actor.id,displayName:actor.displayName});
        if(action==='get'){
          // Only server-recorded human participants who submitted a completed
          // result enter history. CPU fill has no account/settlement rows.
          const history=await this.env.DB.prepare(`SELECT peer.user_id AS id, u.display_name, own.battle_id,
            own.settled_at * 1000 AS played_at FROM battle_settlements own
            JOIN battle_settlements peer ON peer.battle_id=own.battle_id AND peer.user_id!=own.user_id
            JOIN users u ON u.id=peer.user_id AND u.status='active'
            WHERE own.user_id=? AND own.result!='aborted' AND peer.result!='aborted'
            ORDER BY own.settled_at DESC, peer.user_id LIMIT 200`).bind(actor.id)
            .all<{id:string;display_name:string;battle_id:string;played_at:number}>();
          for(const row of history.results)state.recordBattle(row.battle_id,
            [{id:actor.id,displayName:actor.displayName},{id:row.id,displayName:row.display_name}],row.played_at);
        }
        // Names and existence come from account storage, never supplied by a
        // prospective friend or by a forged nickname in a native stanza.
        if(typeof body.target==='string' && action!=='leave' && action!=='transfer'){
          const person=await this.env.DB.prepare("SELECT id, display_name FROM users WHERE id = ? AND status = 'active'")
            .bind(body.target).first<{id:string;display_name:string}>();
          if(!person)throw new ApiError(404,'player_not_found');
          state.register({id:person.id,displayName:person.display_name});
        }
        const refreshParty = async () => {
          const party=state.snapshot(actor.id).party;
          if(party?.state==='lobby')state.updatePresentations(actor.id,
            await readPartyPresentations(party.members.map(member=>member.id),this.env));
        };
        // Observe a selection change before accepting ready. A second read
        // below also clears ready if a concurrent D1 update occurred meanwhile.
        if(action==='ready' && body.ready===true)await refreshParty();
        let result:unknown;
        switch(action){
          case 'search':{
            if(typeof body.name!=='string'||body.name.trim().length<2||body.name.length>64)throw new ApiError(400,'invalid_search');
            // Exact display-name search avoids exposing a browsable account directory.
            const rows=await this.env.DB.prepare("SELECT id, display_name FROM users WHERE display_name = ? AND status = 'active' LIMIT 20")
              .bind(body.name.trim()).all<{id:string;display_name:string}>();
            result={players:rows.results.filter(p=>p.id!==actor.id).map(p=>({id:p.id,displayName:p.display_name}))};break;
          }
          case 'heartbeat':state.heartbeat(actor.id,body.state);break;
          case 'request':state.request(actor.id,body.target);break;
          case 'respond':state.respond(actor.id,body.target,body.accept);break;
          case 'remove':state.removeFriend(actor.id,body.target);break;
          case 'create':state.create(actor.id);break;
          case 'invite':state.invite(actor.id,body.target);break;
          case 'join':state.join(actor.id,body.partyId,body.accept);break;
          case 'leave':state.leave(actor.id,body.target??actor.id);break;
          case 'transfer':state.transfer(actor.id,body.target);break;
          case 'settings':state.settings(actor.id,body.mode,body.ruleset,body.partyId);break;
          case 'ready':state.ready(actor.id,body.ready,body.partyId);break;
        }
        // Leaving, declining and becoming unready must still work when a
        // stored selection is unavailable. None of these actions admits play.
        if(action!=='leave' && !(action==='join' && body.accept===false) &&
            !(action==='ready' && body.ready===false))await refreshParty();
        const snapshot=state.snapshot(actor.id);
        if(action==='get'){
          // Stored recent rows already contain server-recorded battle IDs.
          // Resolve maps from battles, including history retained in the DO
          // beyond the settlement query window. Never accept client metadata.
          const ids=[...new Set(snapshot.recent.map(row=>row.battleId))];
          const maps=new Map<string,string>();
          if(ids.length){
            const battles=await this.env.DB.prepare(`SELECT id, map_key FROM battles WHERE id IN (${ids.map(()=>'?').join(',')})`)
              .bind(...ids).all<{id:string;map_key:string}>();
            for(const battle of battles.results)maps.set(battle.id,battle.map_key);
          }
          result={...snapshot,recent:snapshot.recent.map(row=>({...row,mapKey:maps.get(row.battleId)??null}))};
        }
        await this.ctx.storage.put('social',state.data);
        return {status:200,body:result??snapshot};
      }catch(error){
        if(error instanceof ApiError||error instanceof SocialError)return {status:error.status,body:{error:error.code}};
        throw error;
      }
    });
  }
}
