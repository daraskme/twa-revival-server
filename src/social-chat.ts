import {ApiError, fields, sha256Hex} from './http';
import type {Actor, Env} from './types';
import type {SocialData} from './social-state';

type Message = {id: string; senderId: string; displayName: string; text: string; sentAt: number};
type Receipt = {requestId: string; digest: string; id: string; sentAt: number};
const lifetime = 24 * 60 * 60_000;
export const validChatId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validId = validChatId;
export const validChatText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
  && new TextEncoder().encode(value).length <= 2048 && Array.from(value).every(char => {
    const n = char.codePointAt(0)!;
    return n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0xd7ff) || (n >= 0xe000 && n <= 0xfffd) || n >= 0x10000;
  });
const validText = validChatText;

export type ChannelMessage = Message & {sequence: number};
/** The owning DO must authorize current membership and serialize this call.
 * Chat uses separate storage, so sending never changes readiness or a roster. */
export async function channelChat(actor: Actor, action: 'chat' | 'messages', body: Record<string, unknown>,
  key: string, storage: DurableObjectStorage) {
  fields(body, action === 'chat' ? ['text', 'requestId'] : ['after']);
  const now = Date.now();
  const state = await storage.get<{sequence: number; messages: ChannelMessage[];
    receipts: Record<string, Receipt[]>}>(key) ?? {sequence: 0, messages: [], receipts: {}};
  state.messages = state.messages.filter(row => row.sentAt > now - lifetime);
  for (const [id, rows] of Object.entries(state.receipts)) {
    state.receipts[id] = rows.filter(row => row.sentAt > now - lifetime);
    if (!state.receipts[id].length) delete state.receipts[id];
  }
  if (action === 'messages') {
    if (!Number.isSafeInteger(body.after) || (body.after as number) < 0) throw new ApiError(400, 'invalid_chat_cursor');
    return {messages: state.messages.filter(row => row.sequence > (body.after as number))};
  }
  if (!validText(body.text) || !validId(body.requestId)) throw new ApiError(400, 'invalid_chat_message');
  const digest = await sha256Hex(body.text), receipts = state.receipts[actor.id] ?? [];
  const prior = receipts.find(row => row.requestId === body.requestId);
  if (prior) {
    if (prior.digest !== digest) throw new ApiError(409, 'chat_request_conflict');
    return {accepted: true, messageId: prior.id};
  }
  if (receipts.filter(row => row.sentAt > now - 60_000).length >= 20) throw new ApiError(429, 'chat_rate_limited');
  const message = {id: crypto.randomUUID(), senderId: actor.id, displayName: actor.displayName,
    text: body.text, sentAt: now, sequence: ++state.sequence};
  state.messages = [...state.messages, message].slice(-100);
  state.receipts[actor.id] = [...receipts, {requestId: body.requestId, digest, id: message.id, sentAt: now}].slice(-128);
  await storage.put(key, state);
  return {accepted: true, messageId: message.id};
}

/** Called only inside the authenticated Social object's serialization boundary.
 * Queues and retry receipts are separate from presence/party revision state.
 * Bodies never enter logs or another user's social snapshot. */
export async function socialChat(actor: Actor, action: string, body: Record<string, unknown>,
  env: Env, storage: DurableObjectStorage) {
  const now = Date.now(), ownKey = `chat:inbox:${actor.id}`;
  if (action === 'partychat' || action === 'partymessages') {
    fields(body, action === 'partychat' ? ['partyId', 'text', 'requestId'] : ['partyId', 'after']);
    if (!validId(body.partyId)) throw new ApiError(400, 'invalid_party_id');
    const social = await storage.get<SocialData>('social');
    const party = social && Object.hasOwn(social.parties, body.partyId) ? social.parties[body.partyId] : undefined;
    if (!party?.members.includes(actor.id)) throw new ApiError(403, 'party_membership_required');
    const {partyId, ...request} = body;
    return channelChat(actor, action === 'partychat' ? 'chat' : 'messages', request, `chat:party:${partyId}`, storage);
  }
  if (action === 'messages' || action === 'chatack') {
    fields(body, action === 'messages' ? [] : ['ids']);
    if (action === 'chatack' && (!Array.isArray(body.ids) || body.ids.length > 32 || !body.ids.every(validId))) {
      throw new ApiError(400, 'invalid_message_ack');
    }
    const inbox = (await storage.get<Message[]>(ownKey) ?? []).filter(row => row.sentAt > now - lifetime);
    const ids = new Set(action === 'chatack' ? body.ids as string[] : []);
    const remaining = inbox.filter(row => !ids.has(row.id));
    await storage.put(ownKey, remaining);
    return {messages: action === 'messages' ? remaining : []};
  }
  fields(body, ['target', 'text', 'requestId']);
  if (!validId(body.target) || body.target === actor.id) throw new ApiError(400, 'invalid_chat_target');
  if (!validId(body.requestId) || !validText(body.text)) throw new ApiError(400, 'invalid_chat_message');
  const target = body.target, text = body.text, requestId = body.requestId;
  const receiptKey = `chat:sent:${actor.id}`;
  const receipts = (await storage.get<Receipt[]>(receiptKey) ?? []).filter(row => row.sentAt > now - lifetime);
  const digest = await sha256Hex(JSON.stringify([target, text]));
  const prior = receipts.find(row => row.requestId === requestId);
  if (prior) {
    if (prior.digest !== digest) throw new ApiError(409, 'chat_request_conflict');
    return {messageId: prior.id, accepted: true};
  }
  if (receipts.filter(row => row.sentAt > now - 60_000).length >= 20) throw new ApiError(429, 'chat_rate_limited');
  const targetAccount = await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active'").bind(target).first();
  if (!targetAccount) throw new ApiError(404, 'player_not_found');
  const social = await storage.get<SocialData>('social');
  const friends = Object.values(social?.links ?? {}).some(link => link.accepted
    && ((link.a === actor.id && link.b === target) || (link.a === target && link.b === actor.id)));
  const sameParty = Object.values(social?.parties ?? {}).some(party => party.members.includes(actor.id) && party.members.includes(target));
  const recent = social?.recent[actor.id]?.some(row => row.id === target) ?? false;
  const battlePeer = !friends && !sameParty && !recent && await env.DB.prepare(`SELECT 1 AS shared
    FROM battle_participants a JOIN battle_participants b ON b.battle_id = a.battle_id
    JOIN battles battle ON battle.id = a.battle_id
    WHERE a.user_id = ? AND b.user_id = ? AND battle.expires_at > ? LIMIT 1`)
    .bind(actor.id, target, Math.floor(now / 1000)).first();
  if (!friends && !sameParty && !recent && !battlePeer) throw new ApiError(403, 'chat_contact_required');
  const targetKey = `chat:inbox:${target}`;
  const inbox = (await storage.get<Message[]>(targetKey) ?? []).filter(row => row.sentAt > now - lifetime);
  if (inbox.length >= 32) throw new ApiError(429, 'chat_inbox_full');
  const message = {id: crypto.randomUUID(), senderId: actor.id, displayName: actor.displayName, text, sentAt: now};
  await storage.transaction(async transaction => {
    await transaction.put(targetKey, [...inbox, message]);
    await transaction.put(receiptKey, [...receipts, {requestId, digest, id: message.id, sentAt: now}].slice(-128));
  });
  return {messageId: message.id, accepted: true};
}
