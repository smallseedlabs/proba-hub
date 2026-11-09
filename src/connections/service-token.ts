import { errors as joseErrors, decodeProtectedHeader, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { TokenVerificationError } from '../auth/assertions/errors.js';

/**
 * Service token Ads presents to the connection broker:
 * EdDSA, iss `proba-ads`, aud `proba-hub`, sub `ads`, claim `workspaceId`, jti, lifetime <= 120 s.
 * A jti is accepted once (in-memory replay guard until it expires).
 */
export const ADS_SERVICE_ISSUER = 'proba-ads';
export const ADS_SERVICE_SUBJECT = 'ads';
export const BROKER_AUDIENCE = 'proba-hub';
export const ADS_SERVICE_TOKEN_MAX_TTL_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;
const MAX_TOKEN_LENGTH = 8192;

export interface VerifiedAdsCaller {
  workspaceId: string;
  jti: string;
  keyId: string;
}

export class AdsServiceTokenVerifier {
  private readonly seen = new Map<string, number>();
  private readonly now: () => Date;

  constructor(
    private readonly keys: JWTVerifyGetKey,
    options: { now?: () => Date } = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async verify(token: string): Promise<VerifiedAdsCaller> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
      throw new TokenVerificationError('invalid_token', 'Malformed service token');
    }
    let kid: unknown;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      throw new TokenVerificationError('invalid_token', 'Malformed service token');
    }
    if (typeof kid !== 'string' || kid === '') throw new TokenVerificationError('invalid_token', 'Service token names no key id');
    const currentDate = this.now();
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: ADS_SERVICE_ISSUER,
        audience: BROKER_AUDIENCE,
        subject: ADS_SERVICE_SUBJECT,
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'jti'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new TokenVerificationError('token_expired', 'Service token has expired');
      if (error instanceof joseErrors.JOSEError) throw new TokenVerificationError('invalid_token', `Service token rejected: ${error.message}`);
      throw error;
    }
    const { jti, iat, exp, workspaceId } = payload as Record<string, unknown>;
    if (typeof jti !== 'string' || jti === '' || jti.length > 128) throw new TokenVerificationError('invalid_token', 'Service token has an invalid jti');
    if (typeof iat !== 'number' || typeof exp !== 'number' || exp <= iat) throw new TokenVerificationError('invalid_token', 'Service token has invalid iat or exp');
    if (exp - iat > ADS_SERVICE_TOKEN_MAX_TTL_SECONDS) throw new TokenVerificationError('invalid_token', 'Service token lives too long');
    if (typeof workspaceId !== 'string' || workspaceId === '') throw new TokenVerificationError('invalid_token', 'Service token names no workspace');
    const nowSec = Math.floor(currentDate.getTime() / 1000);
    for (const [id, until] of this.seen) if (until < nowSec) this.seen.delete(id);
    if (this.seen.has(jti)) throw new TokenVerificationError('invalid_token', 'Service token was already used');
    this.seen.set(jti, exp + CLOCK_SKEW_SECONDS);
    return { workspaceId, jti, keyId: kid };
  }
}
