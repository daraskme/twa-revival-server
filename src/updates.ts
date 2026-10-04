import { ApiError } from './http';
import type { Env } from './types';

export const UPDATE_CHANNELS = ['stable', 'beta'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Object keys are operator-supplied, so the path is validated before it can
 * reach R2: no traversal, no absolute path, no empty segment, no backslash.
 */
const OBJECT_KEY = /^[A-Za-z0-9._/-]{1,200}$/;

export function validObjectKey(key: string): boolean {
  if (!OBJECT_KEY.test(key)) return false;
  if (key.startsWith('/') || key.endsWith('/') || key.includes('//')) return false;
  return key.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

export function requestedChannel(url: URL): UpdateChannel {
  const parameters = [...url.searchParams.keys()];
  if (parameters.some(key => key !== 'channel') || parameters.length > 1) throw new ApiError(400, 'query_not_supported');
  const channel = url.searchParams.get('channel') ?? 'stable';
  if (!(UPDATE_CHANNELS as readonly string[]).includes(channel)) throw new ApiError(400, 'invalid_channel');
  return channel as UpdateChannel;
}

function security(headers: Headers): Headers {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return headers;
}

/** Unauthenticated passthrough: the companion must be able to self-update
 * before it holds a session. Manifests are signed and contain no secrets.
 */
export async function updateManifest(url: URL, env: Env): Promise<Response> {
  return storedManifest(url, env, 'manifests');
}

export async function launcherUpdateManifest(url: URL, env: Env): Promise<Response> {
  return storedManifest(url, env, 'launcher-manifests');
}

export async function baseGameManifest(url: URL, env: Env): Promise<Response> {
  return storedManifest(url, env, 'base-game-manifests');
}

async function storedManifest(url: URL, env: Env, prefix: string): Promise<Response> {
  const channel = requestedChannel(url);
  if (!env.PATCHES) throw new ApiError(503, 'updates_not_configured');
  const object = await env.PATCHES.get(`${prefix}/${channel}.json`);
  if (!object) throw new ApiError(404, 'manifest_not_found');
  const headers = security(new Headers());
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-cache');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { status: 200, headers });
}

export async function updateObject(path: string, env: Env): Promise<Response> {
  let key: string;
  try { key = decodeURIComponent(path); } catch { throw new ApiError(400, 'invalid_object_key'); }
  if (!validObjectKey(key)) throw new ApiError(400, 'invalid_object_key');
  if (!env.PATCHES) throw new ApiError(503, 'updates_not_configured');
  const object = await env.PATCHES.get(`objects/${key}`);
  if (!object) throw new ApiError(404, 'object_not_found');
  const headers = security(new Headers());
  headers.set('Content-Type', 'application/octet-stream');
  headers.set('Content-Length', String(object.size));
  headers.set('ETag', object.httpEtag);
  // Manifest entries are version-scoped and content-hashed by the client.
  headers.set('Cache-Control', 'public, max-age=3600');
  return new Response(object.body, { status: 200, headers });
}
