import { describe, expect, it, vi } from 'vitest';
import { MetaConnectionAdapter } from './meta.js';

describe('MetaConnectionAdapter', () => {
  it('builds authorize URL with marketing scopes', () => {
    const adapter = new MetaConnectionAdapter({ clientId: 'app_1', clientSecret: 'sec_1' });
    const url = new URL(adapter.authorizeUrl({ state: 'st_1', redirectUri: 'http://localhost:3300/cb' }));
    expect(url.origin).toBe('https://www.facebook.com');
    expect(url.pathname).toBe('/v21.0/dialog/oauth');
    expect(url.searchParams.get('client_id')).toBe('app_1');
    expect(url.searchParams.get('state')).toBe('st_1');
    expect(url.searchParams.get('scope')).toContain('ads_management');
  });

  it('exchanges code for long-lived token and lists ad accounts', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('fb_exchange_token')) {
        return new Response(JSON.stringify({ access_token: 'long_tok', expires_in: 5184000 }), { status: 200 });
      }
      if (url.includes('/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'short_tok', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('/me/adaccounts')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'act_123', account_id: '123', name: 'SmallSeed Meta', currency: 'USD', business: { id: 'biz_1', name: 'SmallSeed' } }],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });

    const adapter = new MetaConnectionAdapter({
      clientId: 'app_1',
      clientSecret: 'sec_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const tokens = await adapter.exchangeCode({ code: 'code_1', redirectUri: 'http://localhost:3300/cb' });
    expect(tokens.accessToken).toBe('long_tok');
    expect(tokens.refreshToken).toBe('long_tok');

    const accounts = await adapter.listAccounts('long_tok');
    expect(accounts).toEqual([
      { id: 'act_123', name: 'SmallSeed Meta', currency: 'USD', businessId: 'biz_1', businessName: 'SmallSeed' },
    ]);
  });
});
