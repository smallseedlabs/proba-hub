import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Firebase ID token verification without a service account.
 *
 * Firebase ID tokens are RS256 JWTs signed by Google's `securetoken` service
 * account. We verify them against Google's published JWKS (cached and rotated
 * by jose's createRemoteJWKSet) and apply the checks Firebase documents:
 * https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
 *
 * Not covered (needs the Admin SDK and a service account): checking whether the
 * refresh token was revoked or the account disabled after the ID token was minted.
 * ID tokens live for one hour, and Hub sessions are revocable on their own.
 */

export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export const firebaseIssuer = (projectId: string) => `https://securetoken.google.com/${projectId}`;

export interface FirebaseIdentity {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  /** Firebase sign-in provider, e.g. "password" or "google.com". */
  signInProvider: string | null;
  authTime: Date;
}

export type FirebaseTokenErrorCode = 'invalid_token' | 'token_expired';

export class FirebaseTokenError extends Error {
  constructor(
    readonly code: FirebaseTokenErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'FirebaseTokenError';
  }
}

export type FirebaseTokenVerifier = (idToken: string) => Promise<FirebaseIdentity>;

export interface FirebaseVerifierOptions {
  projectId: string;
  /** Key source. Defaults to Google's remote JWKS; tests inject a local key set. */
  keys?: JWTVerifyGetKey;
  /** fetch used for the remote JWKS (tests mock Google's endpoint with it). */
  fetchJwks?: FetchImplementation;
  /** Allowed clock skew in seconds (default 5). */
  clockToleranceSec?: number;
  /** Clock override for tests. */
  now?: () => Date;
}

const MAX_UID_LENGTH = 128;

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function createFirebaseTokenVerifier(options: FirebaseVerifierOptions): FirebaseTokenVerifier {
  const projectId = options.projectId.trim();
  if (!projectId) throw new Error('A Firebase project ID is required to verify Firebase ID tokens');

  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(FIREBASE_JWKS_URL), options.fetchJwks ? { [customFetch]: options.fetchJwks } : {});
  const tolerance = options.clockToleranceSec ?? 5;
  const now = options.now ?? (() => new Date());
  const issuer = firebaseIssuer(projectId);

  return async (idToken: string): Promise<FirebaseIdentity> => {
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
      throw new FirebaseTokenError('invalid_token', 'Malformed ID token');
    }

    const currentDate = now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        algorithms: ['RS256'],
        issuer,
        audience: projectId,
        clockTolerance: tolerance,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw new FirebaseTokenError('token_expired', 'ID token has expired');
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new FirebaseTokenError('invalid_token', `ID token rejected: ${reason}`);
    }

    const nowSec = Math.floor(currentDate.getTime() / 1000);
    const { sub, iat, auth_time: authTime } = payload as JWTPayload & { auth_time?: unknown };

    if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_UID_LENGTH) {
      throw new FirebaseTokenError('invalid_token', 'ID token has an invalid subject');
    }
    if (!isPositiveNumber(iat) || iat > nowSec + tolerance) {
      throw new FirebaseTokenError('invalid_token', 'ID token was issued in the future');
    }
    if (!isPositiveNumber(authTime) || authTime > nowSec + tolerance) {
      throw new FirebaseTokenError('invalid_token', 'ID token has an invalid auth_time');
    }

    const claims = payload as JWTPayload & {
      email?: unknown;
      email_verified?: unknown;
      name?: unknown;
      firebase?: { sign_in_provider?: unknown };
    };

    return {
      uid: sub,
      email: typeof claims.email === 'string' && claims.email ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
      signInProvider:
        typeof claims.firebase?.sign_in_provider === 'string' ? claims.firebase.sign_in_provider : null,
      authTime: new Date(authTime * 1000),
    };
  };
}
