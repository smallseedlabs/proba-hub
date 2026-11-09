import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool, transaction } from '../db/client.js';
import type { HubAudit } from '../audit/service.js';
import { logger } from '../logger.js';
import { connectionAad, type TokenCipher } from './crypto.js';
import {
  CONNECTION_PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  ProviderOAuthError,
  type ConnectionProviderAdapter,
  type ConnectionProviderId,
  type ProviderAccount,
} from './provider.js';

/**
 * Credential broker for ad platform connections (one per workspace and provider).
 *
 * - The owner connects from the web Marketing section: start() returns the provider's
 *   authorize URL with a single-use CSRF state bound to the user, workspace and provider;
 *   complete() is called by the signed-in web app with the code and state.
 * - The refresh token is encrypted at rest; access tokens are minted on demand from it and
 *   cached in memory until 60 s before expiry (one refresh in flight per connection).
 * - Ads asks for an access token through an authenticated internal call (issueAccessToken)
 *   and receives the connection id and account it must attribute its actions to.
 * - Audit events carry ids, provider, scopes and outcomes, never a token.
 */

export class ConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export type ConnectionStatus = 'pending_account' | 'connected' | 'needs_reconnect';

export interface ConnectionView {
  provider: ConnectionProviderId;
  displayName: string;
  /** False when this Hub has no app credentials for the provider (or no adapter yet). */
  available: boolean;
  status: 'not_connected' | ConnectionStatus;
  connectionId?: string;
  connectedByMe?: boolean;
  accountId?: string | null;
  accountName?: string | null;
  /** Ad accounts the grant can manage; only shown to the member who connected. */
  accounts?: ProviderAccount[];
  scopes?: string[];
  connectedAt?: string;
  lastErrorCode?: string | null;
}

export interface IssuedAccessToken {
  connectionId: string;
  provider: ConnectionProviderId;
  accountId: string;
  accessToken: string;
  expiresAt: string;
  connectedBy: string;
  scopes: string[];
}

export interface IssueAccessTokenInput {
  workspaceId: string;
  provider: ConnectionProviderId;
  purpose: 'mutate' | 'metrics' | 'preflight' | 'billing';
  /** Who the provider call is made for (audit attribution; not an authorization grant). */
  userId?: string;
  initiatedBy?: 'user' | 'policy' | 'system';
  traceId?: string;
}

interface ConnectionRow {
  id: string;
  workspace_id: string;
  provider: ConnectionProviderId;
  status: ConnectionStatus;
  connected_by: string;
  provider_account_id: string | null;
  provider_account_name: string | null;
  available_accounts: ProviderAccount[];
  scopes: string[];
  refresh_token_enc: string;
  key_id: string;
  last_error_code: string | null;
  connected_at: Date;
}

export interface ConnectionsServiceOptions {
  workspaceId: string;
  providers: Partial<Record<ConnectionProviderId, ConnectionProviderAdapter>>;
  /** Exact redirect URI registered with each provider app. */
  redirectUris: Partial<Record<ConnectionProviderId, string>>;
  cipher: TokenCipher;
  audit: HubAudit;
  stateTtlSeconds?: number;
  now?: () => Date;
}

const REFRESH_MARGIN_MS = 60_000;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class ConnectionsService {
  private readonly cache = new Map<string, { accessToken: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<{ accessToken: string; expiresAt: number }>>();
  private readonly now: () => Date;
  private readonly stateTtlMs: number;

  constructor(private readonly options: ConnectionsServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.stateTtlMs = (options.stateTtlSeconds ?? 600) * 1000;
  }

  get workspaceId(): string {
    return this.options.workspaceId;
  }

  private adapter(provider: ConnectionProviderId): ConnectionProviderAdapter {
    const adapter = this.options.providers[provider];
    const redirectUri = this.options.redirectUris[provider];
    if (!adapter || !redirectUri) {
      throw new ConnectionError('provider_unavailable', `${PROVIDER_DISPLAY_NAMES[provider]} is not configured on this Hub`, 503);
    }
    return adapter;
  }

  private async load(provider: ConnectionProviderId): Promise<ConnectionRow | undefined> {
    const result = await pool.query<ConnectionRow>(
      'SELECT * FROM platform_connections WHERE workspace_id = $1 AND provider = $2',
      [this.options.workspaceId, provider]
    );
    return result.rows[0];
  }

  private view(provider: ConnectionProviderId, row: ConnectionRow | undefined, userId: string): ConnectionView {
    const available = !!this.options.providers[provider] && !!this.options.redirectUris[provider];
    const base = { provider, displayName: PROVIDER_DISPLAY_NAMES[provider], available };
    if (!row) return { ...base, status: 'not_connected' };
    const mine = row.connected_by === userId;
    return {
      ...base,
      status: row.status,
      connectionId: row.id,
      connectedByMe: mine,
      accountId: row.provider_account_id,
      accountName: row.provider_account_name,
      ...(mine ? { accounts: row.available_accounts } : {}),
      scopes: row.scopes,
      connectedAt: row.connected_at.toISOString(),
      lastErrorCode: row.last_error_code,
    };
  }

  async list(userId: string): Promise<ConnectionView[]> {
    const result = await pool.query<ConnectionRow>('SELECT * FROM platform_connections WHERE workspace_id = $1', [
      this.options.workspaceId,
    ]);
    return CONNECTION_PROVIDERS.map((provider) =>
      this.view(
        provider,
        result.rows.find((r) => r.provider === provider),
        userId
      )
    );
  }

  /** Begin OAuth: a fresh single-use state bound to this user, workspace and provider. */
  async start(userId: string, provider: ConnectionProviderId): Promise<{ authorizeUrl: string; expiresAt: string }> {
    const adapter = this.adapter(provider);
    const existing = await this.load(provider);
    if (existing && existing.connected_by !== userId) {
      throw new ConnectionError('connected_by_other', 'Another member connected this provider; they must disconnect it first', 409);
    }
    const redirectUri = this.options.redirectUris[provider]!;
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + this.stateTtlMs);
    await pool.query('DELETE FROM platform_oauth_states WHERE expires_at < $1', [this.now()]);
    await pool.query(
      `INSERT INTO platform_oauth_states (state_hash, workspace_id, provider, user_id, redirect_uri, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [sha256(state), this.options.workspaceId, provider, userId, redirectUri, expiresAt]
    );
    return { authorizeUrl: adapter.authorizeUrl({ state, redirectUri }), expiresAt: expiresAt.toISOString() };
  }

  /** Finish OAuth: validate and consume the state, exchange the code, store the grant. */
  async complete(
    userId: string,
    provider: ConnectionProviderId,
    input: { code?: string; state: string; error?: string }
  ): Promise<ConnectionView> {
    const adapter = this.adapter(provider);
    const consumed = await pool.query<{ redirect_uri: string }>(
      `UPDATE platform_oauth_states SET consumed_at = $5
         WHERE state_hash = $1 AND workspace_id = $2 AND provider = $3 AND user_id = $4
           AND consumed_at IS NULL AND expires_at > $5
       RETURNING redirect_uri`,
      [sha256(input.state), this.options.workspaceId, provider, userId, this.now()]
    );
    const stateRow = consumed.rows[0];
    if (!stateRow) {
      await this.auditConnect(userId, provider, undefined, 'denied', 'invalid_state');
      throw new ConnectionError('invalid_state', 'This sign-in link is invalid, expired or was already used. Start again.', 400);
    }
    if (input.error || !input.code) {
      const code = input.error === 'access_denied' ? 'access_denied' : 'provider_error';
      await this.auditConnect(userId, provider, undefined, 'denied', code);
      throw new ConnectionError(code, input.error === 'access_denied' ? 'Access was not granted on the provider.' : 'The provider did not return a code.', 400);
    }

    let tokens;
    let accounts: ProviderAccount[];
    try {
      tokens = await adapter.exchangeCode({ code: input.code, redirectUri: stateRow.redirect_uri });
    } catch (err) {
      const code = err instanceof ProviderOAuthError ? err.code : 'provider_unavailable';
      await this.auditConnect(userId, provider, undefined, 'failure', code);
      throw new ConnectionError(code, 'The provider did not accept the sign-in. Start again.', 502);
    }
    const missing = adapter.scopes.filter((s) => tokens.scopes.length > 0 && !tokens.scopes.includes(s));
    if (missing.length > 0) {
      await adapter.revoke(tokens.refreshToken!).catch(() => undefined);
      await this.auditConnect(userId, provider, undefined, 'denied', 'scope_missing', { missingScopes: missing });
      throw new ConnectionError('scope_missing', `The grant is missing required scopes: ${missing.join(', ')}`, 400);
    }
    try {
      accounts = await adapter.listAccounts(tokens.accessToken);
    } catch (err) {
      await adapter.revoke(tokens.refreshToken!).catch(() => undefined);
      const code = err instanceof ProviderOAuthError ? err.code : 'provider_unavailable';
      await this.auditConnect(userId, provider, undefined, 'failure', code);
      throw new ConnectionError('accounts_unavailable', 'Could not list your ad accounts on the provider. Start again.', 502);
    }

    const connectionId = randomUUID();
    const cipher = this.options.cipher;
    const enc = cipher.encrypt(tokens.refreshToken!, connectionAad(this.options.workspaceId, provider, connectionId));
    const single = accounts.length === 1 ? accounts[0]! : undefined;
    const status: ConnectionStatus = single ? 'connected' : 'pending_account';
    const previous = await transaction(async (client) => {
      const prior = await client.query<ConnectionRow>(
        'SELECT * FROM platform_connections WHERE workspace_id = $1 AND provider = $2 FOR UPDATE',
        [this.options.workspaceId, provider]
      );
      const old = prior.rows[0];
      if (old && old.connected_by !== userId) {
        throw new ConnectionError('connected_by_other', 'Another member connected this provider meanwhile', 409);
      }
      if (old) await client.query('DELETE FROM platform_connections WHERE id = $1', [old.id]);
      await client.query(
        `INSERT INTO platform_connections
           (id, workspace_id, provider, status, connected_by, provider_account_id, provider_account_name,
            available_accounts, scopes, refresh_token_enc, key_id, connected_at, account_selected_at, last_refreshed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$12,$12)`,
        [
          connectionId,
          this.options.workspaceId,
          provider,
          status,
          userId,
          single?.id ?? null,
          single?.name ?? null,
          JSON.stringify(accounts),
          tokens.scopes.length > 0 ? tokens.scopes : [...adapter.scopes],
          enc,
          cipher.keyId,
          this.now(),
          single ? this.now() : null,
        ]
      );
      return old;
    }).catch(async (err) => {
      await adapter.revoke(tokens.refreshToken!).catch(() => undefined);
      throw err;
    });
    if (previous) {
      this.cache.delete(previous.id);
      await this.revokeRow(adapter, previous);
    }
    this.cache.set(connectionId, {
      accessToken: tokens.accessToken,
      expiresAt: this.now().getTime() + tokens.expiresInSeconds * 1000,
    });
    await this.auditConnect(userId, provider, connectionId, 'success', undefined, {
      accountCount: accounts.length,
      accountSelected: !!single,
      ...(single ? { providerAccountId: single.id } : {}),
      replacedConnectionId: previous?.id,
    });
    return this.view(provider, await this.load(provider), userId);
  }

  /** Pick the ad account this workspace's campaigns run on (one of the listed accounts). */
  async selectAccount(userId: string, provider: ConnectionProviderId, accountId: string): Promise<ConnectionView> {
    const row = await this.load(provider);
    if (!row) throw new ConnectionError('not_connected', 'Connect the provider first', 404);
    if (row.connected_by !== userId) throw new ConnectionError('not_owner', 'Only the member who connected can choose the account', 403);
    if (row.status === 'needs_reconnect') throw new ConnectionError('needs_reconnect', 'Reconnect the provider first', 409);
    const account = row.available_accounts.find((a) => a.id === accountId);
    if (!account) throw new ConnectionError('account_not_found', 'That account is not one this connection can manage', 400);
    await pool.query(
      `UPDATE platform_connections SET provider_account_id = $2, provider_account_name = $3, status = 'connected',
         account_selected_at = $4, updated_at = $4 WHERE id = $1`,
      [row.id, account.id, account.name, this.now()]
    );
    await this.options.audit.emit(
      {
        action: 'auth.session_issued',
        outcome: 'success',
        userId,
        workspaceId: this.options.workspaceId,
        target: { type: 'platform_connection', id: row.id },
        details: {
          kind: 'platform_connection',
          event: 'account_selected',
          provider,
          connectionId: row.id,
          providerAccountId: account.id,
          previousProviderAccountId: row.provider_account_id,
        },
      },
      { bestEffort: true }
    );
    return this.view(provider, await this.load(provider), userId);
  }

  /** Revoke the grant at the provider (best effort) and delete the stored connection. */
  async disconnect(userId: string, provider: ConnectionProviderId): Promise<ConnectionView> {
    const row = await this.load(provider);
    if (!row) return this.view(provider, undefined, userId);
    if (row.connected_by !== userId) throw new ConnectionError('not_owner', 'Only the member who connected can disconnect', 403);
    const adapter = this.options.providers[provider];
    const revoked = adapter ? await this.revokeRow(adapter, row) : false;
    await pool.query('DELETE FROM platform_connections WHERE id = $1', [row.id]);
    this.cache.delete(row.id);
    await this.options.audit.emit(
      {
        action: 'auth.session_revoked',
        outcome: 'success',
        userId,
        workspaceId: this.options.workspaceId,
        target: { type: 'platform_connection', id: row.id },
        details: {
          kind: 'platform_connection',
          event: 'disconnected',
          provider,
          connectionId: row.id,
          providerAccountId: row.provider_account_id,
          revokedAtProvider: revoked,
        },
      },
      { bestEffort: true }
    );
    return this.view(provider, undefined, userId);
  }

  /**
   * Short-lived access token for an internal service (Ads). Fails closed with a code the
   * caller maps to "unconfigured": not_connected, account_not_selected, needs_reconnect.
   */
  async issueAccessToken(input: IssueAccessTokenInput): Promise<IssuedAccessToken> {
    if (input.workspaceId !== this.options.workspaceId) {
      throw new ConnectionError('workspace_mismatch', 'unknown workspace', 403);
    }
    const adapter = this.adapter(input.provider);
    const row = await this.load(input.provider);
    if (!row) throw new ConnectionError('not_connected', `${PROVIDER_DISPLAY_NAMES[input.provider]} is not connected for this workspace`, 409);
    if (row.status === 'needs_reconnect') throw new ConnectionError('needs_reconnect', 'The provider connection must be reconnected', 409);
    if (row.status !== 'connected' || !row.provider_account_id) {
      throw new ConnectionError('account_not_selected', 'Choose an ad account in Marketing first', 409);
    }
    if (row.key_id !== this.options.cipher.keyId) {
      await this.markNeedsReconnect(row, 'key_changed', input);
      throw new ConnectionError('needs_reconnect', 'The connection key changed; reconnect the provider', 409);
    }
    const token = await this.accessToken(adapter, row, input);
    return {
      connectionId: row.id,
      provider: input.provider,
      accountId: row.provider_account_id,
      accessToken: token.accessToken,
      expiresAt: new Date(token.expiresAt).toISOString(),
      connectedBy: row.connected_by,
      scopes: row.scopes,
    };
  }

  private async accessToken(adapter: ConnectionProviderAdapter, row: ConnectionRow, input: IssueAccessTokenInput) {
    const cached = this.cache.get(row.id);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now().getTime()) return cached;
    const pending = this.inflight.get(row.id);
    if (pending) return pending;
    const run = this.refreshRow(adapter, row, input).finally(() => this.inflight.delete(row.id));
    this.inflight.set(row.id, run);
    return run;
  }

  private async refreshRow(adapter: ConnectionProviderAdapter, row: ConnectionRow, input: IssueAccessTokenInput) {
    const aad = connectionAad(row.workspace_id, row.provider, row.id);
    let refreshToken: string;
    try {
      refreshToken = this.options.cipher.decrypt(row.refresh_token_enc, aad);
    } catch {
      await this.markNeedsReconnect(row, 'decrypt_failed', input);
      throw new ConnectionError('needs_reconnect', 'The stored grant cannot be read; reconnect the provider', 409);
    }
    let tokens;
    try {
      tokens = await adapter.refresh(refreshToken);
    } catch (err) {
      const code = err instanceof ProviderOAuthError ? err.code : 'provider_unavailable';
      if (code === 'invalid_grant' || code === 'access_denied') {
        await this.markNeedsReconnect(row, code, input);
        throw new ConnectionError('needs_reconnect', 'The provider refused the stored grant; reconnect it in Marketing', 409);
      }
      await this.auditRefreshFailure(row, code, input);
      throw new ConnectionError('provider_unavailable', 'The provider is unavailable; try again later', 503);
    }
    const expiresAt = this.now().getTime() + tokens.expiresInSeconds * 1000;
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      await pool.query(
        `UPDATE platform_connections SET refresh_token_enc = $2, last_refreshed_at = $3, last_error_code = NULL, updated_at = $3 WHERE id = $1`,
        [row.id, this.options.cipher.encrypt(tokens.refreshToken, aad), this.now()]
      );
    } else {
      await pool.query(
        `UPDATE platform_connections SET last_refreshed_at = $2, last_error_code = NULL WHERE id = $1`,
        [row.id, this.now()]
      );
    }
    const entry = { accessToken: tokens.accessToken, expiresAt };
    this.cache.set(row.id, entry);
    return entry;
  }

  private async markNeedsReconnect(row: ConnectionRow, code: string, input: IssueAccessTokenInput) {
    await pool.query(
      `UPDATE platform_connections SET status = 'needs_reconnect', last_error_code = $2, updated_at = $3 WHERE id = $1`,
      [row.id, code, this.now()]
    );
    this.cache.delete(row.id);
    await this.auditRefreshFailure(row, code, input);
  }

  private async auditRefreshFailure(row: ConnectionRow, code: string, input: IssueAccessTokenInput) {
    await this.options.audit.emit(
      {
        action: 'system.job_failed',
        outcome: 'failure',
        actor: { type: 'service', id: 'connection-broker' },
        ...(input.userId ? { userId: input.userId } : {}),
        workspaceId: row.workspace_id,
        target: { type: 'platform_connection', id: row.id },
        errorCode: 'token_refresh_failed',
        details: {
          kind: 'platform_connection',
          event: 'token_refresh_failed',
          job: 'provider_token_refresh',
          provider: row.provider,
          connectionId: row.id,
          providerAccountId: row.provider_account_id,
          reason: code,
          purpose: input.purpose,
          initiatedBy: input.initiatedBy ?? 'system',
          ...(input.traceId ? { callerTraceId: input.traceId } : {}),
        },
      },
      { bestEffort: true }
    );
  }

  private async revokeRow(adapter: ConnectionProviderAdapter, row: ConnectionRow): Promise<boolean> {
    try {
      const refreshToken = this.options.cipher.decrypt(row.refresh_token_enc, connectionAad(row.workspace_id, row.provider, row.id));
      await adapter.revoke(refreshToken);
      return true;
    } catch (err) {
      logger.warn(
        { provider: row.provider, connectionId: row.id, error: err instanceof ProviderOAuthError ? err.code : 'error' },
        'provider revoke failed; the stored grant is deleted anyway'
      );
      return false;
    }
  }

  private async auditConnect(
    userId: string,
    provider: ConnectionProviderId,
    connectionId: string | undefined,
    outcome: 'success' | 'failure' | 'denied',
    errorCode?: string,
    extra: Record<string, unknown> = {}
  ) {
    await this.options.audit.emit(
      {
        action: outcome === 'success' ? 'auth.session_issued' : 'auth.denied',
        outcome,
        userId,
        workspaceId: this.options.workspaceId,
        ...(connectionId ? { target: { type: 'platform_connection', id: connectionId } } : {}),
        ...(errorCode ? { errorCode } : {}),
        details: { kind: 'platform_connection', event: 'connect', provider, ...(connectionId ? { connectionId } : {}), ...extra },
      },
      { bestEffort: true }
    );
  }
}
