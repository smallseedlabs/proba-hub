import { errors as joseErrors, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { actAsAssertionClaimsSchema, type ActAsAssertionClaims } from '@smallseedlabs/proba-protocol';
import {
  ACT_AS_ASSERTION_MAX_TTL_SECONDS,
  ACT_AS_ISSUER,
  CONTEXT_CLOCK_SKEW_SECONDS,
  CONTEXT_HUB_AUDIENCE,
  CONTEXT_READER_ROLE,
  CONTEXT_SERVICE_ISSUER,
  CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS,
} from './constants.js';
import { TokenVerificationError } from './errors.js';

const MAX_TOKEN_LENGTH = 8192;
const MAX_JTI_LENGTH = 128;

export interface ContextServiceToken {
  jti: string;
  keyId: string;
  expiresAt: Date;
}

export interface BridgeVerifierOptions {
  keys: JWTVerifyGetKey;
  now?: () => Date;
}

function checkShape(token: string, what: string): void {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
    throw new TokenVerificationError('invalid_token', `Malformed ${what}`);
  }
  let kid: unknown;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new TokenVerificationError('invalid_token', `Malformed ${what}`);
  }
  if (typeof kid !== 'string' || kid === '') throw new TokenVerificationError('invalid_token', `${what} names no key id`);
}

function rejection(error: unknown, what: string): never {
  if (error instanceof joseErrors.JWTExpired) throw new TokenVerificationError('token_expired', `${what} has expired`);
  if (!(error instanceof joseErrors.JOSEError)) throw error;
  throw new TokenVerificationError('invalid_token', `${what} rejected: ${error.message}`);
}

const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** The unverified payload of a JWT, or undefined when it is not one. */
export function peekPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bridge service token: EdDSA, iss `proba-context`, aud `proba-hub`, sub `context-reader`,
 * jti, lifetime ≤ 2 minutes.
 */
export class ContextServiceTokenVerifier {
  readonly name = 'context-service';
  private readonly keys: JWTVerifyGetKey;
  private readonly now: () => Date;

  constructor(options: BridgeVerifierOptions) {
    this.keys = options.keys;
    this.now = options.now ?? (() => new Date());
  }

  claimsToBeBridge(token: string): boolean {
    return peekPayload(token)?.iss === CONTEXT_SERVICE_ISSUER;
  }

  async verify(token: string): Promise<ContextServiceToken> {
    checkShape(token, 'service token');
    const currentDate = this.now();
    let payload: JWTPayload;
    let keyId: string;
    try {
      const result = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: CONTEXT_SERVICE_ISSUER,
        audience: CONTEXT_HUB_AUDIENCE,
        subject: CONTEXT_READER_ROLE,
        clockTolerance: CONTEXT_CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      });
      payload = result.payload;
      keyId = result.protectedHeader.kid as string;
    } catch (error) {
      return rejection(error, 'Service token');
    }
    const { jti, iat, exp } = payload;
    const nowSec = Math.floor(currentDate.getTime() / 1000);
    if (typeof jti !== 'string' || jti === '' || jti.length > MAX_JTI_LENGTH) {
      throw new TokenVerificationError('invalid_token', 'Service token has an invalid jti');
    }
    if (!isPositiveNumber(iat) || !isPositiveNumber(exp) || exp <= iat) {
      throw new TokenVerificationError('invalid_token', 'Service token has invalid iat or exp');
    }
    if (exp - iat > CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS) {
      throw new TokenVerificationError(
        'invalid_token',
        `Service token lives longer than ${CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS} seconds`
      );
    }
    if (iat > nowSec + CONTEXT_CLOCK_SKEW_SECONDS) {
      throw new TokenVerificationError('invalid_token', 'Service token was issued in the future');
    }
    return { jti, keyId, expiresAt: new Date(exp * 1000) };
  }
}

/**
 * Hub act-as assertion: EdDSA, iss `proba-hub`, aud containing `proba-hub`,
 * protocol ActAsAssertionClaims, lifetime ≤ 5 minutes.
 */
export class ActAsAssertionVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly now: () => Date;

  constructor(options: BridgeVerifierOptions) {
    this.keys = options.keys;
    this.now = options.now ?? (() => new Date());
  }

  async verify(token: string): Promise<ActAsAssertionClaims> {
    checkShape(token, 'act-as assertion');
    const currentDate = this.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: ACT_AS_ISSUER,
        audience: CONTEXT_HUB_AUDIENCE,
        clockTolerance: CONTEXT_CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      }));
    } catch (error) {
      return rejection(error, 'Act-as assertion');
    }
    const claims = actAsAssertionClaimsSchema.safeParse(payload);
    if (!claims.success) throw new TokenVerificationError('invalid_token', 'Act-as assertion claims are not valid');
    if (claims.data.jti.length > MAX_JTI_LENGTH) {
      throw new TokenVerificationError('invalid_token', 'Act-as assertion has an invalid jti');
    }
    if (claims.data.exp - claims.data.iat > ACT_AS_ASSERTION_MAX_TTL_SECONDS) {
      throw new TokenVerificationError('invalid_token', 'Act-as assertion lives longer than five minutes');
    }
    if (claims.data.iat > Math.floor(currentDate.getTime() / 1000) + CONTEXT_CLOCK_SKEW_SECONDS) {
      throw new TokenVerificationError('invalid_token', 'Act-as assertion was issued in the future');
    }
    return claims.data;
  }
}
