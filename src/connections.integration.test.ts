/**
 * Platform connections broker contract tests.
 * REAL: Hub routes, ConnectionsService, Postgres, AES-GCM at rest, Ads service-token verification, audit outbox.
 * FAKE: Reddit (FakeRedditOAuthServer on 127.0.0.1). No Reddit, no Ads, no network, no spend.
 */
import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SignJWT, createLocalJWKSet, exportJWK, type JSONWebKeySet } from 'jose';
import { buildApp } from './app.js';
import { config } from './config.js';
import { getAudit } from './audit/service.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createTokenCipher } from './connections/crypto.js';
import { RedditConnectionAdapter } from './connections/reddit.js';
import { ConnectionsService } from './connections/service.js';
import { AdsServiceTokenVerifier } from './connections/service-token.js';
import { FAKE_REDDIT_LABEL, FakeRedditOAuthServer } from './testing/fake-reddit-oauth.js';
import { createTestUser, type TestUser } from './test-helpers.js';

const REDIRECT = 'http://localhost:5180/marketing/reddit/callback';
const fake = new FakeRedditOAuthServer({
  clientId: 'test-client',
  clientSecret: 'test-secret',
  accounts: [
    { id: 'a2_first', name: 'First', currency: 'USD' },
    { id: 'a2_second', name: 'Second', currency: 'USD' },
  ],
});
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
let jwks: JSONWebKeySet;
let clock = new Date();

async function adsToken(workspaceId = config.audit.workspaceId, overrides: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ workspaceId, ...overrides })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'ads-svc-1' })
    .setIssuer('proba-ads')
    .setAudience('proba-hub')
    .setSubject('ads')
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .setJti(randomUUID())
    .sign(privateKey);
}

describe('platform connections broker (FAKE Reddit OAuth, real Postgres)', () => {
  let app: FastifyInstance;
  let owner: TestUser;
  let other: TestUser;
  const inject = (u: TestUser, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${u.token}` }, ...(payload ? { payload } : {}) });
  const issue = async (token: string, body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/internal/connections/reddit/access-token',
      headers: { authorization: `Bearer ${token}` },
      payload: { workspaceId: config.audit.workspaceId, purpose: 'mutate', initiatedBy: 'user', ...body },
    });

  async function connect(u: TestUser) {
    const start = await inject(u, 'POST', '/v1/connections/reddit/start');
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().authorizeUrl).searchParams.get('state')!;
    return inject(u, 'POST', '/v1/connections/reddit/callback', { state, code: fake.issueCode() });
  }

  beforeAll(async () => {
    await runMigrations();
    await pool.query('DELETE FROM platform_connections');
    await fake.start();
    jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'ads-svc-1', alg: 'EdDSA', use: 'sig' }] } as JSONWebKeySet;
    const service = new ConnectionsService({
      workspaceId: config.audit.workspaceId,
      providers: {
        reddit: new RedditConnectionAdapter({
          clientId: 'test-client',
          clientSecret: 'test-secret',
          oauthBaseUrl: fake.baseUrl,
          adsApiBaseUrl: `${fake.baseUrl}/api/v3`,
        }),
      },
      redirectUris: { reddit: REDIRECT },
      cipher: createTokenCipher(randomBytes(32)),
      audit: getAudit(),
      now: () => clock,
    });
    app = await buildApp({
      connections: { service, adsVerifier: new AdsServiceTokenVerifier(createLocalJWKSet(jwks)) },
      analytics: null,
      startBackgroundJobs: false,
    });
    owner = await createTestUser(app, 'conn-owner');
    other = await createTestUser(app, 'conn-other');
  });

  afterAll(async () => {
    await app.close();
    await fake.stop();
  });

  it('lists providers generically with only Reddit available', async () => {
    expect(fake.label).toBe(FAKE_REDDIT_LABEL);
    const res = await inject(owner, 'GET', '/v1/connections');
    expect(res.statusCode).toBe(200);
    const list = res.json().connections as Array<{ provider: string; available: boolean; status: string }>;
    expect(list.map((c) => c.provider)).toEqual(['reddit', 'meta', 'google', 'microsoft', 'linkedin']);
    expect(list.filter((c) => c.available).map((c) => c.provider)).toEqual(['reddit']);
    expect(list.every((c) => c.status === 'not_connected')).toBe(true);
    expect((await inject(owner, 'POST', '/v1/connections/meta/start')).json().error).toBe('provider_unavailable');
  });

  it('binds the OAuth state to the user: another user, a reused or a forged state is refused', async () => {
    const start = await inject(owner, 'POST', '/v1/connections/reddit/start');
    const url = new URL(start.json().authorizeUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('duration')).toBe('permanent');
    const state = url.searchParams.get('state')!;
    const stolen = await inject(other, 'POST', '/v1/connections/reddit/callback', { state, code: fake.issueCode() });
    expect(stolen.json().error).toBe('invalid_state');
    const forged = await inject(owner, 'POST', '/v1/connections/reddit/callback', { state: 'x'.repeat(43), code: fake.issueCode() });
    expect(forged.json().error).toBe('invalid_state');
    const denied = await inject(owner, 'POST', '/v1/connections/reddit/callback', { state, error: 'access_denied' });
    expect(denied.json().error).toBe('access_denied');
    const reused = await inject(owner, 'POST', '/v1/connections/reddit/callback', { state, code: fake.issueCode() });
    expect(reused.json().error).toBe('invalid_state');
  });

  it('connects, stores only ciphertext, needs an account pick, then brokers cached short-lived tokens', async () => {
    const res = await connect(owner);
    expect(res.statusCode).toBe(200);
    const conn = res.json().connection;
    expect(conn).toMatchObject({ provider: 'reddit', status: 'pending_account', connectedByMe: true });
    expect(conn.accounts.map((a: { id: string }) => a.id)).toEqual(['a2_first', 'a2_second']);

    const row = await pool.query('SELECT refresh_token_enc FROM platform_connections WHERE id = $1', [conn.connectionId]);
    for (const rt of fake.refreshTokens) expect(row.rows[0].refresh_token_enc).not.toContain(rt);

    expect((await issue(await adsToken())).json().error).toBe('account_not_selected');
    const otherView = (await inject(other, 'GET', '/v1/connections')).json().connections[0];
    expect(otherView.accounts).toBeUndefined();
    expect((await inject(other, 'PUT', '/v1/connections/reddit/account', { accountId: 'a2_first' })).json().error).toBe('not_owner');
    expect((await inject(owner, 'PUT', '/v1/connections/reddit/account', { accountId: 'a2_nope' })).json().error).toBe('account_not_found');
    const picked = await inject(owner, 'PUT', '/v1/connections/reddit/account', { accountId: 'a2_second' });
    expect(picked.json().connection).toMatchObject({ status: 'connected', accountId: 'a2_second' });

    const refreshesBefore = fake.calls.filter((c) => c.grant === 'refresh_token').length;
    const first = await issue(await adsToken());
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.json()).toMatchObject({ connectionId: conn.connectionId, provider: 'reddit', accountId: 'a2_second', connectedBy: owner.userId });
    const second = await issue(await adsToken(), { purpose: 'metrics', initiatedBy: 'policy' });
    expect(second.json().accessToken).toBe(first.json().accessToken);
    expect(fake.calls.filter((c) => c.grant === 'refresh_token').length).toBe(refreshesBefore);
  });

  it('refuses unauthenticated, replayed, wrong-audience and cross-workspace broker calls', async () => {
    expect((await issue('not-a-jwt')).statusCode).toBe(401);
    const token = await adsToken();
    expect((await issue(token)).statusCode).toBe(200);
    expect((await issue(token)).statusCode).toBe(401);
    const iat = Math.floor(Date.now() / 1000);
    const wrongAud = await new SignJWT({ workspaceId: config.audit.workspaceId })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ads-svc-1' })
      .setIssuer('proba-ads').setAudience('proba-gateway').setSubject('ads')
      .setIssuedAt(iat).setExpirationTime(iat + 60).setJti(randomUUID()).sign(privateKey);
    expect((await issue(wrongAud)).statusCode).toBe(401);
    expect((await issue(await adsToken('other-ws'), { workspaceId: 'other-ws' })).json().error).toBe('workspace_mismatch');
    expect((await issue(await adsToken('other-ws'))).statusCode).toBe(403);
    const session = await app.inject({
      method: 'POST',
      url: '/v1/internal/connections/reddit/access-token',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { workspaceId: config.audit.workspaceId, purpose: 'mutate' },
    });
    expect(session.statusCode).toBe(401);
  });

  it('a refused refresh marks the connection needs_reconnect and audits it without token values', async () => {
    clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000); // past the cached token's expiry
    fake.failNextRefresh = '500';
    expect((await issue(await adsToken())).json().error).toBe('provider_unavailable');
    expect((await inject(owner, 'GET', '/v1/connections')).json().connections[0].status).toBe('connected');
    const refreshed = await issue(await adsToken());
    expect(refreshed.statusCode).toBe(200);
    clock = new Date(clock.getTime() + 2 * 60 * 60 * 1000);
    fake.failNextRefresh = 'invalid_grant';
    expect((await issue(await adsToken(), { userId: owner.userId })).json().error).toBe('needs_reconnect');
    const after = (await inject(owner, 'GET', '/v1/connections')).json().connections[0];
    expect(after).toMatchObject({ status: 'needs_reconnect', lastErrorCode: 'invalid_grant' });
    expect((await issue(await adsToken())).json().error).toBe('needs_reconnect');

    const audit = await pool.query<{ payload: string }>(
      `SELECT payload::text AS payload FROM audit_outbox WHERE payload::text LIKE '%platform_connection%' ORDER BY id`
    );
    const text = audit.rows.map((r) => r.payload).join('\n');
    expect(text).toContain('token_refresh_failed');
    expect(text).toContain('account_selected');
    for (const t of [...fake.refreshTokens, ...fake.accessTokens]) expect(text).not.toContain(t);
  });

  it('a changed encryption key fails closed (needs_reconnect), never a silent success', async () => {
    const rotated = new ConnectionsService({
      workspaceId: config.audit.workspaceId,
      providers: {
        reddit: new RedditConnectionAdapter({ clientId: 'test-client', clientSecret: 'test-secret', oauthBaseUrl: fake.baseUrl, adsApiBaseUrl: `${fake.baseUrl}/api/v3` }),
      },
      redirectUris: { reddit: REDIRECT },
      cipher: createTokenCipher(randomBytes(32)),
      audit: getAudit(),
    });
    await expect(
      rotated.issueAccessToken({ workspaceId: config.audit.workspaceId, provider: 'reddit', purpose: 'metrics' })
    ).rejects.toMatchObject({ code: 'needs_reconnect' });
  });

  it('reconnect replaces the grant (new connection id, old one revoked); disconnect revokes and deletes', async () => {
    const before = (await inject(owner, 'GET', '/v1/connections')).json().connections[0];
    expect((await inject(other, 'POST', '/v1/connections/reddit/start')).json().error).toBe('connected_by_other');
    const revokedBefore = fake.revoked.length;
    const again = await connect(owner);
    const conn = again.json().connection;
    expect(conn.connectionId).not.toBe(before.connectionId);
    // The old grant was encrypted with this app's key, so it is revoked at the provider.
    expect(fake.revoked.length).toBe(revokedBefore + 1);
    await inject(owner, 'PUT', '/v1/connections/reddit/account', { accountId: 'a2_first' });
    expect((await inject(other, 'DELETE', '/v1/connections/reddit')).json().error).toBe('not_owner');
    const gone = await inject(owner, 'DELETE', '/v1/connections/reddit');
    expect(gone.json().connection.status).toBe('not_connected');
    expect(fake.revoked.length).toBe(revokedBefore + 2);
    expect((await pool.query('SELECT 1 FROM platform_connections')).rowCount).toBe(0);
    expect((await issue(await adsToken())).json().error).toBe('not_connected');
    const audit = await pool.query(`SELECT 1 FROM audit_outbox WHERE payload::text LIKE '%disconnected%' AND payload::text LIKE $1`, [
      `%${conn.connectionId}%`,
    ]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });
});
