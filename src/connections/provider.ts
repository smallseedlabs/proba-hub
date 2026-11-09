/**
 * Provider-generic OAuth / credential-broker port. Reddit is the first adapter; Meta,
 * Google, Microsoft and LinkedIn plug in behind the same interface. Adapters only talk
 * to the provider; storage, encryption, CSRF state, caching and audit live in
 * ConnectionsService. Client secrets and refresh tokens never leave the Hub.
 */

export const CONNECTION_PROVIDERS = ['reddit', 'meta', 'google', 'microsoft', 'linkedin'] as const;
export type ConnectionProviderId = (typeof CONNECTION_PROVIDERS)[number];

export const PROVIDER_DISPLAY_NAMES: Record<ConnectionProviderId, string> = {
  reddit: 'Reddit Ads',
  meta: 'Meta Ads',
  google: 'Google Ads',
  microsoft: 'Microsoft Advertising',
  linkedin: 'LinkedIn Ads',
};

export function isConnectionProvider(value: string): value is ConnectionProviderId {
  return (CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

export interface OAuthTokenSet {
  accessToken: string;
  expiresInSeconds: number;
  /** Present on the code exchange; on refresh only when the provider rotates it. */
  refreshToken?: string;
  scopes: string[];
}

export interface ProviderAccount {
  id: string;
  name: string;
  currency?: string;
  businessId?: string;
  businessName?: string;
}

export type ProviderOAuthErrorCode =
  | 'invalid_grant'
  | 'access_denied'
  | 'provider_refused'
  | 'provider_unavailable'
  | 'bad_response';

/**
 * Safe diagnostics for a provider refusal: HTTP status, the provider's own error code and a
 * short message, and the API path (no query). Never tokens, codes or response bodies.
 */
export interface ProviderErrorDetail {
  step: 'connect_start' | 'token_exchange' | 'token_refresh' | 'revoke' | 'list_accounts';
  status?: number;
  path?: string;
  providerCode?: string;
  providerMessage?: string;
}

export class ProviderOAuthError extends Error {
  constructor(
    readonly code: ProviderOAuthErrorCode,
    message: string,
    readonly status?: number,
    readonly detail?: ProviderErrorDetail
  ) {
    super(message);
    this.name = 'ProviderOAuthError';
  }
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SECRETISH = /(bearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{20,})/gi;

function maskKnown(text: string, secrets: string[]): string {
  return secrets.filter((x) => x.length >= 6).reduce((t, x) => t.split(x).join('[masked]'), text);
}

/** Pull a provider error code/message out of a JSON error body, bounded and with token-like strings masked. */
export function providerErrorFields(body: unknown, secrets: string[] = []): { providerCode?: string; providerMessage?: string } {
  if (!body || typeof body !== 'object') return {};
  const root = body as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : undefined;
  const pick = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string' && v.trim() !== '');
  const code = pick(nested?.code, nested?.type, typeof root.error === 'string' ? root.error : undefined, root.code, root.reason);
  const message = pick(nested?.message, root.message, root.error_description, root.explanation);
  return {
    ...(code && SAFE_CODE.test(code) ? { providerCode: code } : {}),
    ...(message ? { providerMessage: maskKnown(message, secrets).replace(SECRETISH, '[masked]').slice(0, 200) } : {}),
  };
}

export interface ConnectionProviderAdapter {
  readonly id: ConnectionProviderId;
  /** Scopes requested and required (a grant missing one is refused and revoked). */
  readonly scopes: readonly string[];
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string }): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
  revoke(refreshToken: string): Promise<void>;
  listAccounts(accessToken: string): Promise<ProviderAccount[]>;
}
