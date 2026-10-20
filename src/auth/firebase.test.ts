import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createLocalJWKSet } from 'jose';
import {
  createFirebaseTokenVerifier,
  FIREBASE_JWKS_URL,
  FirebaseTokenError,
  type FirebaseTokenVerifier,
} from './firebase.js';
import { createFakeFirebaseIssuer, type FakeFirebaseIssuer } from './firebase-testing.js';

const PROJECT = 'proba-unit';

let issuer: FakeFirebaseIssuer;
let verify: FirebaseTokenVerifier;

beforeAll(async () => {
  issuer = await createFakeFirebaseIssuer(PROJECT);
  verify = createFirebaseTokenVerifier({ projectId: PROJECT, keys: issuer.keys });
});

async function rejection(token: string, v: FirebaseTokenVerifier = verify): Promise<FirebaseTokenError> {
  const error = await v(token).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(FirebaseTokenError);
  return error as FirebaseTokenError;
}

describe('createFirebaseTokenVerifier', () => {
  it('accepts a valid token and maps the identity', async () => {
    const token = await issuer.mint({
      uid: 'abc123',
      email: 'Ana@Example.com',
      name: 'Ana Example',
      provider: 'google.com',
    });
    const identity = await verify(token);
    expect(identity).toMatchObject({
      uid: 'abc123',
      email: 'Ana@Example.com',
      emailVerified: true,
      name: 'Ana Example',
      signInProvider: 'google.com',
    });
    expect(identity.authTime.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reports unverified emails and missing names', async () => {
    const identity = await verify(await issuer.mint({ emailVerified: false }));
    expect(identity.emailVerified).toBe(false);
    expect(identity.name).toBeNull();
  });

  it('rejects a token for another project (aud)', async () => {
    const error = await rejection(await issuer.mint({ aud: 'someone-else' }));
    expect(error.code).toBe('invalid_token');
    expect(error.message).toMatch(/aud/);
  });

  it('rejects the wrong issuer', async () => {
    const error = await rejection(await issuer.mint({ iss: 'https://securetoken.google.com/someone-else' }));
    expect(error.code).toBe('invalid_token');
    expect(error.message).toMatch(/iss/);
  });

  it('rejects an expired token with token_expired', async () => {
    const error = await rejection(await issuer.mint({ iatOffset: -7200, expOffset: -3600 }));
    expect(error.code).toBe('token_expired');
  });

  it('tolerates small clock skew only', async () => {
    await expect(verify(await issuer.mint({ expOffset: -2 }))).resolves.toBeTruthy();
    expect((await rejection(await issuer.mint({ expOffset: -30 }))).code).toBe('token_expired');
  });

  it('rejects a missing or future auth_time', async () => {
    expect((await rejection(await issuer.mint({ omitAuthTime: true }))).code).toBe('invalid_token');
    expect((await rejection(await issuer.mint({ authTimeOffset: 600 }))).message).toMatch(/auth_time/);
  });

  it('rejects a token issued in the future', async () => {
    expect((await rejection(await issuer.mint({ iatOffset: 600 }))).code).toBe('invalid_token');
  });

  it('rejects an empty subject', async () => {
    expect((await rejection(await issuer.mint({ sub: '' }))).code).toBe('invalid_token');
  });

  it('rejects a token signed by a key that is not in the JWKS', async () => {
    expect((await rejection(await issuer.mint({ foreignKey: true }))).code).toBe('invalid_token');
  });

  it('rejects tampered and malformed tokens', async () => {
    const token = await issuer.mint({ uid: 'victim' });
    const [h, p, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'attacker' })).toString('base64url');
    expect((await rejection(`${h}.${forged}.${sig}`)).code).toBe('invalid_token');
    expect((await rejection('not-a-jwt')).code).toBe('invalid_token');
    expect((await rejection('')).code).toBe('invalid_token');
  });

  it('rejects unsigned (alg none) and HS256 tokens', async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const claims = enc({
      iss: `https://securetoken.google.com/${PROJECT}`,
      aud: PROJECT,
      sub: 'x',
      iat: now,
      exp: now + 3600,
      auth_time: now,
    });
    expect((await rejection(`${enc({ alg: 'none' })}.${claims}.`)).code).toBe('invalid_token');
    expect((await rejection(`${enc({ alg: 'HS256', kid: issuer.jwks.keys[0].kid })}.${claims}.c2ln`)).code).toBe(
      'invalid_token'
    );
  });

  it('requires a project id', () => {
    expect(() => createFirebaseTokenVerifier({ projectId: ' ', keys: createLocalJWKSet({ keys: [] }) })).toThrow();
  });

  it('fetches keys from Google securetoken JWKS by default (mocked fetch, no network)', async () => {
    const fetchJwks = vi.fn(async (_url: string) =>
      new Response(JSON.stringify(issuer.jwks), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const remote = createFirebaseTokenVerifier({ projectId: PROJECT, fetchJwks });
    const identity = await remote(await issuer.mint({ uid: 'remote-user' }));
    expect(identity.uid).toBe('remote-user');
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(String(fetchJwks.mock.calls[0][0])).toBe(FIREBASE_JWKS_URL);

    // Keys are cached: a second verification does not refetch.
    await remote(await issuer.mint());
    expect(fetchJwks).toHaveBeenCalledTimes(1);
  });

  it('rejects (does not hang) when the JWKS endpoint fails', async () => {
    const fetchJwks = vi.fn(async () => new Response('nope', { status: 500 }));
    const remote = createFirebaseTokenVerifier({ projectId: PROJECT, fetchJwks });
    expect((await rejection(await issuer.mint(), remote)).code).toBe('invalid_token');
  });
});
