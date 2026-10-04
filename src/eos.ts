import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { ApiError } from './http';
import type { Env, IdentityVerifier } from './types';

const CONNECT_JWKS = new URL('https://api.epicgames.dev/auth/v1/oauth/jwks');
const RSA_ALGORITHMS = ['RS256', 'RS384', 'RS512'];
const CLOCK_TOLERANCE_SECONDS = 30;
const MAX_TOKEN_LENGTH = 16_384;

interface ConnectConfig {
  product: string;
  sandbox: string;
  deployment: string;
  issuer: string;
  clients: string[];
  externalTypes: Set<string>;
}

function configurationError(): ApiError {
  return new ApiError(503, 'eos_not_configured');
}

function invalidToken(): ApiError {
  return new ApiError(401, 'invalid_eos_token');
}

function setting(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048
      || /REPLACE_ME|YOUR_|[<>\x00-\x1f\x7f]/i.test(value)) {
    throw configurationError();
  }
  return value.trim();
}

function identifier(value: unknown): string {
  const result = setting(value);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(result)) throw configurationError();
  return result;
}

function identifiers(value: unknown): string[] {
  const entries = setting(value).split(',').map(identifier);
  if (entries.length > 32) throw configurationError();
  return [...new Set(entries)];
}

function configuration(env: Env): ConnectConfig {
  const issuer = setting(env.EOS_EXPECTED_ISSUER);
  let url: URL;
  try { url = new URL(issuer); } catch { throw configurationError(); }
  // Check the original authority too: URL normalizes an explicit :443 port.
  if (!/^https:\/\/api\.epicgames\.dev(?:\/|$)/.test(issuer)
      || /[\\?#]/.test(issuer)
      || url.protocol !== 'https:' || url.hostname !== 'api.epicgames.dev'
      || url.port || url.username || url.password || url.search || url.hash) {
    throw configurationError();
  }
  const externalTypes = identifiers(env.EOS_ALLOWED_EXTERNAL_TYPES);
  if (externalTypes.some(value => !/^[a-z][a-z0-9_]{0,31}$/.test(value))) {
    throw configurationError();
  }
  return {
    product: identifier(env.EOS_PRODUCT_ID),
    sandbox: identifier(env.EOS_SANDBOX_ID),
    deployment: identifier(env.EOS_DEPLOYMENT_ID),
    issuer,
    clients: identifiers(env.EOS_ALLOWED_CLIENT_IDS),
    externalTypes: new Set(externalTypes),
  };
}

/** Explicit key injection is for tests; production always uses Epic Connect JWKS. */
export function createConnectVerifier(keyResolver: JWTVerifyGetKey): IdentityVerifier {
  return async (token, env) => {
    const config = configuration(env);
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
      throw invalidToken();
    }
    try {
      const header = decodeProtectedHeader(token);
      if (typeof header.alg !== 'string' || !RSA_ALGORITHMS.includes(header.alg)
          || typeof header.kid !== 'string' || !header.kid
          || header.kid.length > 256 || /[\x00-\x20\x7f]/.test(header.kid)) {
        throw invalidToken();
      }
    } catch { throw invalidToken(); }

    try {
      const now = Math.floor(Date.now() / 1000);
      const { payload } = await jwtVerify(token, async (...args) => {
        try { return await keyResolver(...args); }
        catch (error) {
          if (error instanceof errors.JWKSNoMatchingKey) throw invalidToken();
          // Network errors, timeouts, or a malformed upstream JWKS are outages.
          throw new ApiError(503, 'eos_keys_unavailable');
        }
      }, {
        algorithms: RSA_ALGORITHMS,
        issuer: config.issuer,
        audience: config.clients,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(now * 1000),
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'pfpid', 'pfsid', 'pfdid', 'act'],
      });

      // Connect's documented audience is a client ID string. Product scoping
      // also prevents an Auth ID token or another environment's token reuse.
      const verifiedAt = Math.floor(Date.now() / 1000);
      if (typeof payload.aud !== 'string' || !config.clients.includes(payload.aud)
          || payload.pfpid !== config.product || payload.pfsid !== config.sandbox
          || payload.pfdid !== config.deployment
          || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.sub)
          || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || (payload.iat as number) < 0
          || (payload.iat as number) > now + CLOCK_TOLERANCE_SECONDS
          || (payload.exp as number) <= verifiedAt
          || (payload.exp as number) <= (payload.iat as number)) {
        throw invalidToken();
      }
      const act = payload.act;
      if (!act || typeof act !== 'object' || Array.isArray(act)
          || !('eat' in act) || typeof act.eat !== 'string'
          || !config.externalTypes.has(act.eat)) {
        throw invalidToken();
      }
      return { productUserId: payload.sub, expiresAt: payload.exp as number };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof errors.JOSEError) throw invalidToken();
      throw new ApiError(503, 'eos_verification_unavailable');
    }
  };
}

// One resolver per isolate shares the bounded cache and key-rotation cooldown.
// No request header, JWT URL, or environment setting can replace this endpoint.
export const verifyConnectIdToken: IdentityVerifier = createConnectVerifier(
  createRemoteJWKSet(CONNECT_JWKS, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  }),
);
