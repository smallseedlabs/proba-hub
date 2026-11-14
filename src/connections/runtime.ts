import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { getAudit } from '../audit/service.js';
import { loadPublicKeySet } from '../auth/assertions/public-key-set.js';
import { logger } from '../logger.js';
import { loadTokenCipher } from './crypto.js';
import type { ConnectionProviderAdapter, ConnectionProviderId } from './provider.js';
import { MetaConnectionAdapter } from './meta.js';
import { RedditConnectionAdapter } from './reddit.js';
import { ConnectionsService } from './service.js';
import { AdsServiceTokenVerifier } from './service-token.js';

export interface ConnectionsRuntime {
  service: ConnectionsService;
  /** Null when HUB_ADS_SERVICE_PUBLIC_KEY_FILE is not set: the internal token route is not registered. */
  adsVerifier: AdsServiceTokenVerifier | null;
}

function readSecretFile(envName: string, file: string): string {
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (!value) throw new Error('empty');
    return value;
  } catch (err) {
    throw new Error(`${envName}: cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
}

function checkRedirectUri(uri: string): string {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error('HUB_REDDIT_REDIRECT_URI is not a URL');
  }
  if (config.isProduction && url.protocol !== 'https:') throw new Error('HUB_REDDIT_REDIRECT_URI must be https in production');
  if (url.hash || url.search) throw new Error('HUB_REDDIT_REDIRECT_URI must not have a query or fragment');
  return uri;
}

function checkBase(name: string, value: string): string {
  if (config.isProduction && !value.startsWith('https://')) throw new Error(`${name} must be https in production`);
  return value;
}

/**
 * Build the broker from config. Returns null (Marketing shows "not set up") when
 * HUB_CONNECTIONS_KEY_FILE is not configured. A provider is available only when its app
 * credentials (files) and redirect URI are set; nothing is defaulted.
 */
export async function createConnectionsRuntime(): Promise<ConnectionsRuntime | null> {
  const c = config.connections;
  if (!c.keyFile) {
    if (!config.isTest) logger.info('HUB_CONNECTIONS_KEY_FILE is not set: platform connections (Marketing) are off');
    return null;
  }
  const cipher = loadTokenCipher(c.keyFile, (config.isProduction ? 'production' : 'development'));
  const providers: Partial<Record<ConnectionProviderId, ConnectionProviderAdapter>> = {};
  const redirectUris: Partial<Record<ConnectionProviderId, string>> = {};
  if (c.reddit.clientIdFile && c.reddit.clientSecretFile && c.reddit.redirectUri) {
    providers.reddit = new RedditConnectionAdapter({
      clientId: readSecretFile('HUB_REDDIT_CLIENT_ID_FILE', c.reddit.clientIdFile),
      clientSecret: readSecretFile('HUB_REDDIT_CLIENT_SECRET_FILE', c.reddit.clientSecretFile),
      oauthBaseUrl: checkBase('HUB_REDDIT_OAUTH_BASE_URL', c.reddit.oauthBaseUrl),
      adsApiBaseUrl: checkBase('HUB_REDDIT_ADS_API_BASE_URL', c.reddit.adsApiBaseUrl),
    });
    redirectUris.reddit = checkRedirectUri(c.reddit.redirectUri);
  } else if (!config.isTest) {
    logger.info('Reddit connection is off: set HUB_REDDIT_CLIENT_ID_FILE, HUB_REDDIT_CLIENT_SECRET_FILE and HUB_REDDIT_REDIRECT_URI');
  }
  if (c.meta.clientIdFile && c.meta.clientSecretFile && c.meta.redirectUri) {
    providers.meta = new MetaConnectionAdapter({
      clientId: readSecretFile('HUB_META_CLIENT_ID_FILE', c.meta.clientIdFile),
      clientSecret: readSecretFile('HUB_META_CLIENT_SECRET_FILE', c.meta.clientSecretFile),
      oauthBaseUrl: checkBase('HUB_META_OAUTH_BASE_URL', c.meta.oauthBaseUrl),
      graphApiBaseUrl: checkBase('HUB_META_GRAPH_API_BASE_URL', c.meta.graphApiBaseUrl),
    });
    redirectUris.meta = checkRedirectUri(c.meta.redirectUri);
  } else if (!config.isTest) {
    logger.info('Meta connection is off: set HUB_META_CLIENT_ID_FILE, HUB_META_CLIENT_SECRET_FILE and HUB_META_REDIRECT_URI');
  }
  const service = new ConnectionsService({
    workspaceId: config.audit.workspaceId,
    providers,
    redirectUris,
    cipher,
    audit: getAudit(),
    stateTtlSeconds: c.stateTtlSeconds,
  });
  let adsVerifier: AdsServiceTokenVerifier | null = null;
  if (c.adsServicePublicKeyFile) {
    const set = await loadPublicKeySet(c.adsServicePublicKeyFile, {
      envName: 'HUB_ADS_SERVICE_PUBLIC_KEY_FILE',
      nodeEnv: (config.isProduction ? 'production' : 'development'),
    });
    adsVerifier = new AdsServiceTokenVerifier(set.keys);
  }
  return { service, adsVerifier };
}
