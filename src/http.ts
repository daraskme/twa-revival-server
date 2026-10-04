export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: Record<string, unknown>) { super(code); }
}

export const DEFAULT_BODY_LIMIT = 16384;

export function json(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(value, { status, headers: {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  } });
}

export async function readJson(request: Request, limit = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'json_required');
  }
  // Bound actual streamed bytes, not merely the caller-controlled Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'body_required');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiError(413, 'body_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new ApiError(400, 'invalid_json'); }
}

export function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'unknown_field');
}

/** Serialized UTF-8 size of an already parsed JSON value. */
export function serializedSize(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Deterministic JSON with recursively sorted keys. Shared by the request
 * fingerprints used for exactly-once settlement and by the update manifest
 * signature contract (`scripts/manifest-lib.mjs` must stay byte-compatible).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new ApiError(400, 'invalid_json');
    if (value === undefined || typeof value === 'function') throw new ApiError(400, 'invalid_json');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
