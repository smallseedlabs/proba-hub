import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeRedditOAuthServer } from '../testing/fake-reddit-oauth.js';
import { ProviderOAuthError } from './provider.js';
import { RedditConnectionAdapter } from './reddit.js';

const fake = new FakeRedditOAuthServer({
  clientId: 'cid',
  clientSecret: 'csecret',
  accounts: [
    { id: 'a2_one', name: 'One', currency: 'USD' },
    { id: 'a2_two', name: 'Two', currency: 'GBP' },
  ],
});
let adapter: RedditConnectionAdapter;

beforeAll(async () => {
  await fake.start();
  adapter = new RedditConnectionAdapter({
    clientId: 'cid',
    clientSecret: 'csecret',
    oauthBaseUrl: fake.baseUrl,
    adsApiBaseUrl: `${fake.baseUrl}/api/v3`,
  });
});
afterAll(() => fake.stop());

describe('Reddit connection adapter (FAKE Reddit OAuth server)', () => {
  it('builds a permanent authorize URL with the Ads scopes and the exact redirect URI', () => {
    const url = new URL(adapter.authorizeUrl({ state: 'st4te', redirectUri: 'http://localhost:5180/marketing/reddit/callback' }));
    expect(url.pathname).toBe('/api/v1/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('duration')).toBe('permanent');
    expect(url.searchParams.get('scope')).toBe('adsread,adsedit');
    expect(url.searchParams.get('state')).toBe('st4te');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:5180/marketing/reddit/callback');
    expect(url.toString()).not.toContain('csecret');
  });

  it('exchanges a code (HTTP Basic), lists ad accounts across businesses, refreshes and revokes', async () => {
    const tokens = await adapter.exchangeCode({ code: fake.issueCode(), redirectUri: 'http://x/cb' });
    expect(tokens.refreshToken).toMatch(/^fake-refresh-/);
    expect(tokens.scopes).toEqual(['adsread', 'adsedit']);
    const accounts = await adapter.listAccounts(tokens.accessToken);
    expect(accounts.map((a) => a.id)).toEqual(['a2_one', 'a2_two']);
    expect(accounts[0]).toMatchObject({ businessId: 'biz-1', businessName: 'Fake Business', currency: 'USD' });
    const refreshed = await adapter.refresh(tokens.refreshToken!);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    await adapter.revoke(tokens.refreshToken!);
    expect(fake.revoked).toContain(tokens.refreshToken);
    await expect(adapter.refresh(tokens.refreshToken!)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('maps a used code to invalid_grant and an outage to provider_unavailable', async () => {
    await expect(adapter.exchangeCode({ code: 'never-issued', redirectUri: 'http://x/cb' })).rejects.toBeInstanceOf(ProviderOAuthError);
    const offline = new RedditConnectionAdapter({ clientId: 'c', clientSecret: 's', oauthBaseUrl: 'http://127.0.0.1:9', timeoutMs: 500 });
    await expect(offline.refresh('r')).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('skips a business without ad account permission and still lists the readable ones', async () => {
    fake.forbiddenBusiness = true;
    try {
      const tokens = await adapter.exchangeCode({ code: fake.issueCode(), redirectUri: 'http://localhost:5180/marketing/reddit/callback' });
      const accounts = await adapter.listAccounts(tokens.accessToken);
      expect(accounts.map((a) => a.id)).toEqual(['a2_one', 'a2_two']);
    } finally {
      fake.forbiddenBusiness = false;
    }
  });

  it('reports a refused Ads API with status, path and Reddit error code, never the token', async () => {
    const tokens = await adapter.exchangeCode({ code: fake.issueCode(), redirectUri: 'http://localhost:5180/marketing/reddit/callback' });
    fake.adsApiRefusal = { status: 403, code: 'FORBIDDEN', message: `app has no Ads API access (token ${tokens.accessToken})` };
    try {
      const err = await adapter.listAccounts(tokens.accessToken).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderOAuthError);
      const e = err as ProviderOAuthError;
      expect(e.code).toBe('provider_refused');
      expect(e.detail).toMatchObject({ step: 'list_accounts', status: 403, path: '/me/businesses', providerCode: 'FORBIDDEN' });
      expect(JSON.stringify(e.detail)).not.toContain(tokens.accessToken);
      expect(e.message).not.toContain(tokens.accessToken);
    } finally {
      fake.adsApiRefusal = null;
    }
  });
});

describe('providerErrorFields (Reddit Ads API v3 error shapes)', () => {
  it('reads {error:{message, code:<int>}}, {success:false,error:{reason,explanation}} and {error:"..."}', async () => {
    const { providerErrorFields } = await import('./provider.js');
    expect(providerErrorFields({ error: { message: 'Member ID not found', code: 404 } })).toEqual({
      providerCode: '404',
      providerMessage: 'Member ID not found',
    });
    expect(providerErrorFields({ success: false, error: { reason: 'UNAUTHORIZED', explanation: 'could not verify' } })).toEqual({
      providerCode: 'UNAUTHORIZED',
      providerMessage: 'could not verify',
    });
    expect(providerErrorFields({ error: 'invalid_grant' })).toEqual({ providerCode: 'invalid_grant' });
  });
});
