import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { createUserWithPassword, UserExistsError } from './auth/users.js';
import { hashToken } from './auth/tokens.js';
import { createGoalCommand } from './test-helpers.js';

const app: FastifyInstance = await buildApp({
  startBackgroundJobs: false,
  authRateLimit: { rateLimitMax: 3, rateLimitWindowMs: 60_000 },
});

function login(email: string, password: string, ip = '10.0.0.1') {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
    remoteAddress: ip,
  });
}

describe('Password auth (/v1/auth/*)', () => {
  let email: string;
  let password: string;
  let userId: string;

  beforeAll(async () => {
    email = `auth-${randomUUID()}@example.com`;
    const created = await createUserWithPassword({ email, name: 'Auth Test' });
    password = created.password;
    userId = created.user.id;
    expect(created.created).toBe(true);
  });

  afterAll(async () => {
    await app.close();
  });

  it('signs in with the right password and returns the proba-web contract', async () => {
    const res = await login(email, password);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.token).toBe('string');
    expect(body.user).toEqual({ id: userId, email, name: 'Auth Test' });
    expect(body.workspaces).toEqual([{ id: 'default', name: 'My workspace' }]);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(body)).not.toContain('password');

    // Only a hash of the token is stored.
    const sessions = await pool.query('SELECT token_hash FROM sessions WHERE user_id = $1', [userId]);
    expect(sessions.rows.map((r) => r.token_hash)).toContain(hashToken(body.token));
    expect(sessions.rows.map((r) => r.token_hash)).not.toContain(body.token);
  });

  it('matches emails case-insensitively', async () => {
    const res = await login(email.toUpperCase(), password, '10.0.0.2');
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await login(email, 'not-the-password', '10.0.0.3');
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_credentials', message: 'Invalid email or password.' });
  });

  it('returns the same 401 for unknown emails and for password-less dev accounts', async () => {
    const unknown = await login(`nobody-${randomUUID()}@example.com`, 'whatever', '10.0.0.4');
    expect(unknown.statusCode).toBe(401);

    const devEmail = `dev-${randomUUID()}@example.com`;
    await app.inject({ method: 'POST', url: '/dev/login', payload: { email: devEmail } });
    const devAccount = await login(devEmail, 'anything', '10.0.0.4');
    expect(devAccount.statusCode).toBe(401);
    expect(devAccount.body).toBe(unknown.body);
  });

  it('rejects malformed bodies with 400 without echoing input', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(email);
  });

  it('rate-limits repeated failures for an email', async () => {
    const target = `limited-${randomUUID()}@example.com`;
    await createUserWithPassword({ email: target, name: 'Limited' });
    for (let i = 0; i < 3; i++) {
      expect((await login(target, 'wrong', `10.1.0.${i}`)).statusCode).toBe(401);
    }
    const blocked = await login(target, 'wrong', '10.1.0.9');
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('logout invalidates the session token', async () => {
    const { token } = JSON.parse((await login(email, password, '10.0.0.5')).body);
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
    // SSE/polling with the token in the query string is rejected too.
    expect(
      (await app.inject({ method: 'GET', url: `/v1/events?after=0&token=${encodeURIComponent(token)}` })).statusCode
    ).toBe(401);
  });

  it('logging out one session leaves other sessions valid', async () => {
    const a = JSON.parse((await login(email, password, '10.0.0.6')).body).token;
    const b = JSON.parse((await login(email, password, '10.0.0.6')).body).token;
    expect(a).not.toBe(b);
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { authorization: `Bearer ${a}` } });
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${b}` } });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the login token for commands and events (header and query param)', async () => {
    const { token } = JSON.parse((await login(email, password, '10.0.0.7')).body);
    const header = await app.inject({
      method: 'GET',
      url: '/v1/events?after=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(header.statusCode).toBe(200);
    const query = await app.inject({ method: 'GET', url: `/v1/events?after=0&token=${encodeURIComponent(token)}` });
    expect(query.statusCode).toBe(200);
  });

  it.each([
    ['GET', '/v1/threads'],
    ['GET', '/v1/goals'],
    ['GET', '/v1/inbox'],
    ['GET', '/v1/events?after=0'],
    ['POST', '/v1/commands'],
    ['POST', '/v1/auth/logout'],
    ['GET', '/v1/auth/me'],
  ] as const)('%s %s rejects missing and invalid tokens', async (method, url) => {
    const missing = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(missing.statusCode).toBe(401);
    expect(JSON.parse(missing.body).error).toBe('missing_token');

    const garbage = await app.inject({ method, url, headers: { authorization: 'Bearer not-a-jwt' } });
    expect(garbage.statusCode).toBe(401);

    // Correctly signed but never issued (no session row): rejected.
    const forged = app.jwt.sign({ userId, jti: randomUUID() });
    const unissued = await app.inject({ method, url, headers: { authorization: `Bearer ${forged}` } });
    expect(unissued.statusCode).toBe(401);
    expect(JSON.parse(unissued.body).error).toBe('invalid_token');
  });

  it('rejects expired sessions', async () => {
    const { token } = JSON.parse((await login(email, password, '10.0.0.8')).body);
    await pool.query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [
      hashToken(token),
    ]);
    const res = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('user:create refuses duplicates unless resetting, and reset revokes sessions', async () => {
    await expect(createUserWithPassword({ email, name: 'Again' })).rejects.toBeInstanceOf(UserExistsError);

    const { token } = JSON.parse((await login(email, password, '10.0.0.9')).body);
    const reset = await createUserWithPassword({ email, name: 'Auth Test', resetPassword: true });
    expect(reset.created).toBe(false);
    expect(reset.password).not.toBe(password);

    const old = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(old.statusCode).toBe(401);
    expect((await login(email, password, '10.0.0.10')).statusCode).toBe(401);
    expect((await login(email, reset.password, '10.0.0.10')).statusCode).toBe(200);
    password = reset.password;
  });
});

describe('/dev/login gating', () => {
  it('is not registered when disabled', async () => {
    const prodLike = await buildApp({ startBackgroundJobs: false, devLogin: false });
    try {
      const res = await prodLike.inject({ method: 'POST', url: '/dev/login', payload: { email: 'x@example.com' } });
      expect(res.statusCode).toBe(404);
    } finally {
      await prodLike.close();
    }
  });
});
