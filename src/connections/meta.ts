import {
  ProviderOAuthError,
  providerErrorFields,
  type ConnectionProviderAdapter,
  type OAuthTokenSet,
  type ProviderAccount,
} from './provider.js';

/**
 * Meta Marketing API OAuth adapter (Facebook Login for Business / Marketing API).
 *   authorize   GET    {oauthBase}/v21.0/dialog/oauth
 *   token       GET    {graphBase}/v21.0/oauth/access_token (code -> short-lived -> 60-day long-lived token)
 *   revoke      DELETE {graphBase}/v21.0/me/permissions
 *   accounts    GET    {graphBase}/v21.0/me/adaccounts
 */

export const META_OAUTH_BASE = 'https://www.facebook.com';
export const META_GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';
export const META_SCOPES = ['ads_management', 'ads_read', 'pages_show_list', 'pages_read_engagement'] as const;

export interface MetaOAuthConfig {
  clientId: string;
  clientSecret: string;
  oauthBaseUrl?: string;
  graphApiBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export class MetaConnectionAdapter implements ConnectionProviderAdapter {
  readonly id = 'meta' as const;
  readonly scopes = META_SCOPES;
  private readonly oauthBase: string;
  private readonly graphBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: MetaOAuthConfig) {
    if (!config.clientId || !config.clientSecret) throw new Error('Meta app id and secret are required');
    this.oauthBase = trimBase(config.oauthBaseUrl || META_OAUTH_BASE);
    this.graphBase = trimBase(config.graphApiBaseUrl || META_GRAPH_API_BASE);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      response_type: 'code',
      scope: this.scopes.join(','),
    });
    return `${this.oauthBase}/v21.0/dialog/oauth?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const shortLived = await this.tokenExchange({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    }, 'token_exchange');

    // Upgrade short-lived code token to a 60-day long-lived token so ConnectionsService can store and refresh it.
    try {
      const longLived = await this.tokenExchange({
        grant_type: 'fb_exchange_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        fb_exchange_token: shortLived.accessToken,
      }, 'token_exchange');
      return {
        ...longLived,
        refreshToken: longLived.accessToken,
      };
    } catch {
      return {
        ...shortLived,
        refreshToken: shortLived.accessToken,
      };
    }
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    const refreshed = await this.tokenExchange({
      grant_type: 'fb_exchange_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      fb_exchange_token: refreshToken,
    }, 'token_refresh');
    return {
      ...refreshed,
      refreshToken: refreshed.accessToken,
    };
  }

  async revoke(refreshToken: string): Promise<void> {
    const res = await this.send(`${this.graphBase}/me/permissions`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${refreshToken}`,
        accept: 'application/json',
      },
    });
    if (res.status >= 500) {
      throw new ProviderOAuthError('provider_unavailable', `Meta revoke answered ${res.status}`, res.status, {
        step: 'revoke',
        status: res.status,
        path: '/me/permissions',
      });
    }
  }

  async listAccounts(accessToken: string): Promise<ProviderAccount[]> {
    const url = `${this.graphBase}/me/adaccounts?fields=id,account_id,name,currency,account_status,business{id,name}&limit=200`;
    const res = await this.send(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    });
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{
        id?: string;
        account_id?: string;
        name?: string;
        currency?: string;
        business?: { id?: string; name?: string };
      }>;
      error?: unknown;
    } | null;
    if (res.status >= 400 || !body || !Array.isArray(body.data)) {
      const fields = providerErrorFields(body, [accessToken, this.config.clientSecret]);
      throw new ProviderOAuthError(
        res.status >= 500 ? 'provider_unavailable' : 'provider_refused',
        fields.providerMessage || `Meta ad accounts answered ${res.status}`,
        res.status,
        { step: 'list_accounts', status: res.status, path: '/me/adaccounts', ...fields }
      );
    }

    return body.data
      .filter((row) => typeof row.id === 'string' && row.id.trim() !== '')
      .map((row) => ({
        id: row.id!.trim(),
        name: (row.name || row.account_id || row.id!).trim(),
        ...(row.currency ? { currency: row.currency } : {}),
        ...(row.business?.id ? { businessId: row.business.id } : {}),
        ...(row.business?.name ? { businessName: row.business.name } : {}),
      }));
  }

  private async tokenExchange(paramsObj: Record<string, string>, step: 'token_exchange' | 'token_refresh'): Promise<OAuthTokenSet> {
    const params = new URLSearchParams(paramsObj);
    const res = await this.send(`${this.graphBase}/oauth/access_token?${params.toString()}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: unknown;
    } | null;
    if (res.status >= 400 || !body?.access_token) {
      const fields = providerErrorFields(body, [this.config.clientSecret, paramsObj.fb_exchange_token ?? '']);
      throw new ProviderOAuthError(
        res.status >= 500 ? 'provider_unavailable' : 'invalid_grant',
        fields.providerMessage || `Meta token endpoint answered ${res.status}`,
        res.status,
        { step, status: res.status, path: '/oauth/access_token', ...fields }
      );
    }
    return {
      accessToken: body.access_token,
      expiresInSeconds: typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 5_184_000,
      scopes: [...this.scopes],
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ProviderOAuthError(
        'provider_unavailable',
        err instanceof Error ? err.message : 'Meta network error'
      );
    }
  }
}
