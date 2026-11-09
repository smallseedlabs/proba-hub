import {
  ProviderOAuthError,
  type ConnectionProviderAdapter,
  type OAuthTokenSet,
  type ProviderAccount,
} from './provider.js';

/**
 * Reddit Ads OAuth adapter ("web app" type Reddit application).
 *   authorize   GET  {oauthBase}/api/v1/authorize   duration=permanent, scope=adsread,adsedit
 *   token       POST {oauthBase}/api/v1/access_token (HTTP Basic client_id:client_secret)
 *   revoke      POST {oauthBase}/api/v1/revoke_token
 *   accounts    GET  {adsApiBase}/me/businesses, then /businesses/{id}/ad_accounts
 * Base URLs are configurable so tests run against a fake OAuth server; production requires https.
 */

export const REDDIT_OAUTH_BASE = 'https://www.reddit.com';
export const REDDIT_ADS_API_BASE = 'https://ads-api.reddit.com/api/v3';
/** adsread lists businesses and ad accounts and reads reports; adsedit creates and updates campaigns. */
export const REDDIT_SCOPES = ['adsread', 'adsedit'] as const;
const USER_AGENT = 'web:proba-hub:0.1.0 (Proba connection broker)';
const MAX_BUSINESSES = 25;
const MAX_ACCOUNTS = 200;

export interface RedditOAuthConfig {
  clientId: string;
  clientSecret: string;
  oauthBaseUrl?: string;
  adsApiBaseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

export class RedditConnectionAdapter implements ConnectionProviderAdapter {
  readonly id = 'reddit' as const;
  readonly scopes = REDDIT_SCOPES;
  private readonly oauthBase: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: RedditOAuthConfig) {
    if (!config.clientId || !config.clientSecret) throw new Error('Reddit client id and secret are required');
    this.oauthBase = trimBase(config.oauthBaseUrl || REDDIT_OAUTH_BASE);
    this.apiBase = trimBase(config.adsApiBaseUrl || REDDIT_ADS_API_BASE);
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      state: input.state,
      redirect_uri: input.redirectUri,
      duration: 'permanent',
      scope: this.scopes.join(','),
    });
    return `${this.oauthBase}/api/v1/authorize?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokenSet> {
    const set = await this.tokenRequest({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri });
    if (!set.refreshToken) throw new ProviderOAuthError('bad_response', 'Reddit returned no refresh token (duration=permanent is required)');
    return set;
  }

  refresh(refreshToken: string): Promise<OAuthTokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<void> {
    const response = await this.send(`${this.oauthBase}/api/v1/revoke_token`, {
      method: 'POST',
      headers: this.basicHeaders(),
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token' }).toString(),
    });
    if (response.status >= 400) {
      throw new ProviderOAuthError(response.status >= 500 ? 'provider_unavailable' : 'provider_refused', `Reddit revoke answered ${response.status}`, response.status);
    }
  }

  async listAccounts(accessToken: string): Promise<ProviderAccount[]> {
    const businesses = await this.apiGet(accessToken, '/me/businesses');
    const accounts: ProviderAccount[] = [];
    for (const business of asArray(businesses).slice(0, MAX_BUSINESSES)) {
      const businessId = str(business.id);
      if (!businessId) continue;
      const listed = await this.apiGet(accessToken, `/businesses/${encodeURIComponent(businessId)}/ad_accounts`);
      for (const account of asArray(listed)) {
        const id = str(account.id);
        if (!id || accounts.some((a) => a.id === id)) continue;
        accounts.push({
          id,
          name: str(account.name) ?? id,
          ...(str(account.currency) ? { currency: str(account.currency)! } : {}),
          businessId,
          ...(str(business.name) ? { businessName: str(business.name)! } : {}),
        });
        if (accounts.length >= MAX_ACCOUNTS) return accounts;
      }
    }
    return accounts;
  }

  private basicHeaders(): Record<string, string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, 'utf8').toString('base64');
    return {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
  }

  private async tokenRequest(form: Record<string, string>): Promise<OAuthTokenSet> {
    const response = await this.send(`${this.oauthBase}/api/v1/access_token`, {
      method: 'POST',
      headers: this.basicHeaders(),
      body: new URLSearchParams(form).toString(),
    });
    const body = await readJson(response);
    const error = str(body?.error);
    if (response.status >= 500) throw new ProviderOAuthError('provider_unavailable', `Reddit token endpoint answered ${response.status}`, response.status);
    if (error === 'invalid_grant') throw new ProviderOAuthError('invalid_grant', 'Reddit refused the grant (expired, used or revoked)', response.status);
    if (response.status >= 400 || error) {
      throw new ProviderOAuthError('provider_refused', `Reddit token endpoint refused the request (${error ?? response.status})`, response.status);
    }
    const accessToken = str(body?.access_token);
    const expiresIn = Number(body?.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new ProviderOAuthError('bad_response', 'Reddit token response is missing access_token or expires_in');
    }
    const scope = str(body?.scope) ?? '';
    const refreshToken = str(body?.refresh_token);
    return {
      accessToken,
      expiresInSeconds: expiresIn,
      ...(refreshToken ? { refreshToken } : {}),
      scopes: scope.split(/[\s,]+/).filter(Boolean),
    };
  }

  private async apiGet(accessToken: string, path: string): Promise<unknown> {
    const response = await this.send(`${this.apiBase}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (response.status === 401 || response.status === 403) {
      throw new ProviderOAuthError('provider_refused', `Reddit Ads API refused ${path} (${response.status}); check the granted scopes`, response.status);
    }
    if (response.status >= 400) {
      throw new ProviderOAuthError(response.status >= 500 ? 'provider_unavailable' : 'provider_refused', `Reddit Ads API answered ${response.status} for ${path}`, response.status);
    }
    const body = await readJson(response);
    return body && 'data' in body ? body.data : body;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new ProviderOAuthError('provider_unavailable', `Reddit is unreachable (${(err as Error).name})`);
    }
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
