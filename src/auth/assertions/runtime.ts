import { createLocalJWKSet, type JSONWebKeySet } from 'jose';
import { loadAssertionPrivateKey, type AssertionSigningKey } from './private-key.js';
import { loadPublicKeySet, type PublicKeySet } from './public-key-set.js';
import { createAssertionMinter, type AssertionMinter } from './mint.js';
import { ActAsAssertionVerifier, ContextServiceTokenVerifier } from './verify.js';

export interface ContextBridgeHubAuth {
  /** Signs act-as assertions for the bridge. Absent when minting is not configured. */
  minter: AssertionMinter | null;
  /** Verifies Hub-minted assertions (rotation set). */
  assertions: ActAsAssertionVerifier | null;
  /** Verifies bridge service tokens. Absent when the context-reader role is off. */
  service: ContextServiceTokenVerifier | null;
  /** Public JWKS served at /.well-known/assertion-keys. */
  assertionJwks: JSONWebKeySet;
  readonly contextReaderEnabled: boolean;
}

export interface AssertionRuntimeConfig {
  env: string;
  contextReaderEnabled: boolean;
  contextBridgeUrl: string;
  assertionPrivateKeyFile: string;
  assertionKeyId: string;
  /** Optional JWKS for verification/rotation; when empty, derived from the private key. */
  assertionPublicKeyFile: string;
  contextServicePublicKeyFile: string;
}

export interface CreateAssertionRuntimeOptions {
  now?: () => Date;
}

/**
 * Loads assertion signing and context-reader verification keys.
 *
 * Production + CONTEXT_BRIDGE_URL: refuses to start without HUB_ASSERTION_PRIVATE_KEY_FILE
 * (and a usable key id). Context-reader enabled: both CONTEXT_SERVICE_PUBLIC_KEY_FILE and
 * assertion verification keys are required.
 */
export async function createAssertionRuntime(
  config: AssertionRuntimeConfig,
  options: CreateAssertionRuntimeOptions = {}
): Promise<ContextBridgeHubAuth> {
  const production = config.env === 'production';
  const bridgeConfigured = config.contextBridgeUrl.trim() !== '';

  if (production && bridgeConfigured && config.assertionPrivateKeyFile.trim() === '') {
    throw new Error(
      'HUB_ASSERTION_PRIVATE_KEY_FILE is required when NODE_ENV=production and CONTEXT_BRIDGE_URL is set'
    );
  }
  if (config.contextReaderEnabled) {
    if (config.contextServicePublicKeyFile.trim() === '') {
      throw new Error('CONTEXT_SERVICE_PUBLIC_KEY_FILE is required when HUB_CONTEXT_READER_ENABLED=true');
    }
    if (config.assertionPrivateKeyFile.trim() === '' && config.assertionPublicKeyFile.trim() === '') {
      throw new Error(
        'HUB_ASSERTION_PRIVATE_KEY_FILE or HUB_ASSERTION_PUBLIC_KEY_FILE is required when HUB_CONTEXT_READER_ENABLED=true'
      );
    }
  }

  let signingKey: AssertionSigningKey | null = null;
  if (config.assertionPrivateKeyFile.trim() !== '') {
    signingKey = await loadAssertionPrivateKey(config.assertionPrivateKeyFile, {
      kid: config.assertionKeyId,
      nodeEnv: config.env,
    });
  }

  let assertionKeys: PublicKeySet | null = null;
  if (config.assertionPublicKeyFile.trim() !== '') {
    assertionKeys = await loadPublicKeySet(config.assertionPublicKeyFile, {
      envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE',
      nodeEnv: config.env,
    });
  } else if (signingKey) {
    const jwks: JSONWebKeySet = { keys: [signingKey.publicJwk as JSONWebKeySet['keys'][number]] };
    assertionKeys = {
      keys: createLocalJWKSet(jwks),
      keyIds: [signingKey.kid],
      publicKeys: [String(signingKey.publicJwk.x)],
      jwks,
    };
  }

  let service: ContextServiceTokenVerifier | null = null;
  if (config.contextReaderEnabled) {
    const serviceKeys = await loadPublicKeySet(config.contextServicePublicKeyFile, {
      envName: 'CONTEXT_SERVICE_PUBLIC_KEY_FILE',
      nodeEnv: config.env,
    });
    if (production && assertionKeys && serviceKeys.publicKeys.some((x) => assertionKeys!.publicKeys.includes(x))) {
      throw new Error(
        'CONTEXT_SERVICE_PUBLIC_KEY_FILE and Hub assertion keys list the same key: the bridge and the Hub never share a key'
      );
    }
    service = new ContextServiceTokenVerifier({
      keys: serviceKeys.keys,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  const assertions =
    assertionKeys !== null
      ? new ActAsAssertionVerifier({
          keys: assertionKeys.keys,
          ...(options.now ? { now: options.now } : {}),
        })
      : null;

  return {
    minter: signingKey ? createAssertionMinter({ signingKey, ...(options.now ? { now: options.now } : {}) }) : null,
    assertions,
    service,
    assertionJwks: assertionKeys?.jwks ?? { keys: [] },
    contextReaderEnabled: config.contextReaderEnabled && service !== null && assertions !== null,
  };
}
