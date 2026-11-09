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

export class ProviderOAuthError extends Error {
  constructor(
    readonly code: ProviderOAuthErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderOAuthError';
  }
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
