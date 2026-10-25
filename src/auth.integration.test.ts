import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { hashToken } from './auth/tokens.js';
import { createFirebaseTokenVerifier } from './auth/firebase.js';
import { createFakeFirebaseIssuer, type FakeFirebaseIssuer, type MintOptions } from './auth/firebase-testing.js';
import { createGoalCommand } from './test-helpers.js';

/**
 * Firebase sign-in: POST /v1/auth/session exchanges a Firebase ID token for a
 * revocable Hub session. Tokens are minted with a local key pair and verified
 * against a local JWKS (no network, no Firebase project).
 */
const firebase: FakeFirebaseIssuer = await createFakeFirebaseIssuer('proba-integration');
const verifier = createFirebaseTokenVerifier({ projectId: firebase.projectId, keys: firebase.keys });

const app: FastifyInstance = await buildApp({
  startBackgroundJobs: false,
  firebaseVerifier: verifier,
  allowedEmailDomains: [],
  authRateLimit: { rateLimitMax: 1000, rateLimitWindowMs: 60_000 },
});

let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

function exchange(idToken: unknown, target: FastifyInstance = app, ip = nextIp()) {
  return target.inject({ method: 'POST', url: '/v1/auth/session', payload: { idToken }, remoteAddress: ip });
}

async function signIn(options: MintOptions = {}) {
  const res = await exchange(await firebase.mint(options));
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as {
    token: string;
    user: { id: string; email: string; name: string };
    workspaces: unknown[];
    expiresAt: string;
  };
}

const email = () => `fb-${randomUUID()}@example.com`;

afterAll(async () => {
  await app.close();
});

describe('POST /v1/auth/session', () => {
  it('exchanges a valid ID token for a Hub session (proba-web contract)', async () => {
    const uid = `uid-${randomUUID()}`;
    const address = email();
    const idToken = await firebase.mint({ uid, email: address, name: 'Ana Example', provider: 'google.com' });
    const res = await exchange(idToken);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe(idToken);
    expect(body.user).toEqual({ id: expect.any(String), email: address, name: 'Ana Example' });
    expect(body.workspaces).toEqual([{ id: 'seedbed', name: 'Seedbed' }]);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const row = await pool.query(
      'SELECT firebase_uid, email, name, email_verified, last_sign_in_at FROM users WHERE id = $1',
      [body.user.id]
    );
    expect(row.rows[0]).toMatchObject({ firebase_uid: uid, email: address, name: 'Ana Example', email_verified: true });
    expect(row.rows[0].last_sign_in_at).toBeInstanceOf(Date);

    // Only a hash of the Hub token is stored.
    const sessions = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [body.user.id]);
    expect(sessions.rows.map((r) => r.token_hash)).toEqual([hashToken(body.token)]);
  });

  it('upserts by Firebase uid: same user on every sign-in, profile kept current', async () => {
    const uid = `uid-${randomUUID()}`;
    const first = await signIn({ uid, email: email(), name: 'Old Name', emailVerified: false });
    const newEmail = email().toUpperCase();
    const second = await signIn({ uid, email: newEmail, name: 'New Name', emailVerified: true });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user).toMatchObject({ email: newEmail.toLowerCase(), name: 'New Name' });
    const row = await pool.query('SELECT email_verified FROM users WHERE id = $1', [first.user.id]);
    expect(row.rows[0].email_verified).toBe(true);
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE firebase_uid = $1', [uid]);
    expect(count.rows[0].n).toBe(1);
  });

  it('falls back to the email local part when Firebase has no display name', async () => {
    const address = email();
    const { user } = await signIn({ email: address });
    expect(user.name).toBe(address.split('@')[0]);
  });

  it('handles concurrent first sign-ins for the same uid', async () => {
    const uid = `uid-${randomUUID()}`;
    const address = email();
    const results = await Promise.all(
      [0, 1, 2].map(async () => exchange(await firebase.mint({ uid, email: address })))
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => JSON.parse(r.body).user.id)).size).toBe(1);
  });

  it('links an existing (pre-Firebase) account by verified email', async () => {
    const address = email();
    const legacy = await pool.query("INSERT INTO users (email, name) VALUES ($1, 'Legacy') RETURNING id", [address]);
    const { user } = await signIn({ email: address.toUpperCase(), emailVerified: true, name: 'Legacy User' });
    expect(user.id).toBe(legacy.rows[0].id);
  });

  it('does not link an existing account to an unverified email', async () => {
    const address = email();
    await pool.query("INSERT INTO users (email, name) VALUES ($1, 'Legacy')", [address]);
    const res = await exchange(await firebase.mint({ email: address, emailVerified: false }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('email_not_verified');
  });

  it('refuses an email already linked to another Firebase user', async () => {
    const address = email();
    await signIn({ email: address });
    const res = await exchange(await firebase.mint({ email: address }));
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('account_conflict');
  });

  it('requires an email claim', async () => {
    const res = await exchange(await firebase.mint({ email: null }));
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe('email_required');
  });

  it.each([
    ['wrong audience', { aud: 'another-project' }, 'invalid_token'],
    ['wrong issuer', { iss: 'https://securetoken.google.com/another-project' }, 'invalid_token'],
    ['expired', { iatOffset: -7200, expOffset: -3600 }, 'token_expired'],
    ['future auth_time', { authTimeOffset: 3600 }, 'invalid_token'],
    ['missing auth_time', { omitAuthTime: true }, 'invalid_token'],
    ['empty subject', { sub: '' }, 'invalid_token'],
    ['unknown signing key', { foreignKey: true }, 'invalid_token'],
  ] as const)('rejects a token with %s (401 %s) and creates no session', async (_label, options, code) => {
    const uid = `uid-${randomUUID()}`;
    const res = await exchange(await firebase.mint({ uid, ...options }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe(code);
    const users = await pool.query('SELECT 1 FROM users WHERE firebase_uid = $1', [uid]);
    expect(users.rows).toHaveLength(0);
  });

  it('rejects a token from another Firebase project signed with a valid key', async () => {
    const other = await createFakeFirebaseIssuer('another-project');
    const res = await exchange(await other.mint());
    expect(res.statusCode).toBe(401);
  });

  it('rejects malformed bodies with 400 without echoing input', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: { idToken: '' } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_request');
    const missing = await app.inject({ method: 'POST', url: '/v1/auth/session', payload: {} });
    expect(missing.statusCode).toBe(400);
  });

  it('a Firebase ID token is not itself a Hub bearer token', async () => {
    const idToken = await firebase.mint();
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${idToken}` } });
    expect(res.statusCode).toBe(401);
  });

  it('the password endpoint is gone', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'a@example.com', password: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Hub sessions issued from Firebase sign-in', () => {
  let session: Awaited<ReturnType<typeof signIn>>;

  beforeAll(async () => {
    session = await signIn({ email: email(), name: 'Session User' });
  });

  it('works for commands and events (header and query param)', async () => {
    const { token } = await signIn({ email: email() });
    const header = await app.inject({
      method: 'GET',
      url: '/v1/events?after=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(header.statusCode).toBe(200);
    const query = await app.inject({ method: 'GET', url: `/v1/events?after=0&token=${encodeURIComponent(token)}` });
    expect(query.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(JSON.parse(me.body).user.email).toBeTruthy();
  });

  it('logout invalidates the session token everywhere it was accepted', async () => {
    const { token } = await signIn({ email: email() });
    const auth = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/threads', headers: auth })).statusCode).toBe(200);

    const out = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: auth });
    expect(out.statusCode).toBe(204);

    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/threads', headers: auth })).statusCode).toBe(401);
    const cmd = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: auth,
      payload: createGoalCommand(randomUUID()),
    });
    expect(cmd.statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/v1/events?after=0&token=${encodeURIComponent(token)}` })).statusCode
    ).toBe(401);
  });

  it('logging out one session leaves other sessions valid', async () => {
    const uid = `uid-${randomUUID()}`;
    const address = email();
    const a = (await signIn({ uid, email: address })).token;
    const b = (await signIn({ uid, email: address })).token;
    expect(a).not.toBe(b);
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${a}` } });
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${b}` } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects expired sessions', async () => {
    const { token } = await signIn({ email: email() });
    await pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [
      hashToken(token),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['GET', '/v1/threads'],
    ['GET', '/v1/goals'],
    ['GET', '/v1/inbox'],
    ['GET', '/v1/events?after=0'],
    ['POST', '/v1/commands'],
    ['POST', '/v1/auth/logout'],
    ['GET', '/v1/auth/me'],
  ] as const)('%s %s rejects missing, invalid and unissued tokens', async (method, url) => {
    const missing = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(missing.statusCode).toBe(401);
    expect(JSON.parse(missing.body).error).toBe('missing_token');

    const garbage = await app.inject({ method, url, headers: { authorization: 'Bearer not-a-jwt' } });
    expect(garbage.statusCode).toBe(401);

    const forged = app.jwt.sign({ userId: session.user.id, jti: randomUUID() });
    const unissued = await app.inject({ method, url, headers: { authorization: `Bearer ${forged}` } });
    expect(unissued.statusCode).toBe(401);
    expect(JSON.parse(unissued.body).error).toBe('invalid_token');
  });
});

describe('sign-in configuration', () => {
  it('answers 503 when FIREBASE_PROJECT_ID is not configured', async () => {
    const unconfigured = await buildApp({ startBackgroundJobs: false, firebaseVerifier: null });
    try {
      const res = await exchange(await firebase.mint(), unconfigured);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe('auth_not_configured');
    } finally {
      await unconfigured.close();
    }
  });

  it('restricts sign-in to allowed email domains (verified emails only)', async () => {
    const restricted = await buildApp({
      startBackgroundJobs: false,
      firebaseVerifier: verifier,
      allowedEmailDomains: ['proba.example'],
    });
    try {
      const ok = await exchange(await firebase.mint({ email: `a-${randomUUID()}@Proba.Example` }), restricted);
      expect(ok.statusCode).toBe(200);
      const otherDomain = await exchange(await firebase.mint({ email: email() }), restricted);
      expect(otherDomain.statusCode).toBe(403);
      expect(JSON.parse(otherDomain.body).error).toBe('not_allowed');
      const unverified = await exchange(
        await firebase.mint({ email: `b-${randomUUID()}@proba.example`, emailVerified: false }),
        restricted
      );
      expect(unverified.statusCode).toBe(403);
    } finally {
      await restricted.close();
    }
  });

  it('rate-limits repeated failed exchanges per IP', async () => {
    const limited = await buildApp({
      startBackgroundJobs: false,
      firebaseVerifier: verifier,
      authRateLimit: { rateLimitMax: 2, rateLimitWindowMs: 60_000 },
    });
    try {
      const bad = await firebase.mint({ aud: 'wrong' });
      expect((await exchange(bad, limited, '10.9.9.9')).statusCode).toBe(401);
      expect((await exchange(bad, limited, '10.9.9.9')).statusCode).toBe(401);
      const blocked = await exchange(await firebase.mint(), limited, '10.9.9.9');
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect((await exchange(await firebase.mint(), limited, '10.9.9.10')).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });
});

describe('/dev/login gating', () => {
  it('is not registered when disabled', async () => {
    const prodLike = await buildApp({ startBackgroundJobs: false, devLogin: false, firebaseVerifier: null });
    try {
      const res = await prodLike.inject({ method: 'POST', url: '/dev/login', payload: { email: 'x@example.com' } });
      expect(res.statusCode).toBe(404);
    } finally {
      await prodLike.close();
    }
  });
});
