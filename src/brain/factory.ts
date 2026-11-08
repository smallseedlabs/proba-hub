import { config, type BrainProviderKind } from '../config.js';
import { loadAssertionPrivateKey } from '../auth/assertions/private-key.js';
import { createAssertionMinter } from '../auth/assertions/mint.js';
import { createGatewayTokenMinter } from '../auth/gateway-token.js';
import { getAudit } from '../audit/service.js';
import type { BrainPort } from '../types.js';
import { MockBrain } from './mock-brain.js';
import { DeepSeekBrain } from './deepseek-brain.js';
import { GatewayBrain } from './gateway-brain.js';
import { createGatewayClient } from './http-gateway-client.js';
import { PostgresGatewayRunStore } from './postgres-gateway-run-store.js';
import { assertGatewayGuards } from './context-bridge-guards.js';

export interface CreateBrainOptions {
  /** Defaults to config.brain.provider (BRAIN_PROVIDER). */
  provider?: BrainProviderKind;
  /** Scripted scenario, used by the `mock` provider. Defaults to config.brain.scenario. */
  scenario?: string;
}

/** The brain behind the BrainPort for the configured provider. `mock` is the default. */
export function createBrain(options: CreateBrainOptions = {}): BrainPort {
  const provider = options.provider ?? config.brain.provider;
  switch (provider) {
    case 'deepseek':
      return new DeepSeekBrain({ ...config.brain.deepseek, limits: config.brain.limits });
    case 'mock':
      return new MockBrain(options.scenario ?? config.brain.scenario);
    default:
      throw new Error(`Unknown brain provider: ${String(provider)}`);
  }
}

/**
 * Runtime brain: gateway when GATEWAY_URL is enabled, otherwise mock/deepseek.
 * Gateway excludes DeepSeek/mock so there is no double model dispatch.
 */
export async function createRuntimeBrain(options: CreateBrainOptions = {}): Promise<BrainPort> {
  assertGatewayGuards();
  if (!config.gateway.enabled) return createBrain(options);
  if (!config.gateway.servicePrivateKeyFile) {
    throw new Error('HUB_GATEWAY_PRIVATE_KEY_FILE is required when GATEWAY_URL is enabled');
  }
  const signingKey = await loadAssertionPrivateKey(config.gateway.servicePrivateKeyFile, {
    envName: 'HUB_GATEWAY_PRIVATE_KEY_FILE',
    kid: config.gateway.serviceKeyId,
    nodeEnv: config.env,
  });
  let assertions = null;
  if (config.contextBridge.assertionPrivateKeyFile && config.contextBridge.assertionKeyId) {
    const assertionKey = await loadAssertionPrivateKey(config.contextBridge.assertionPrivateKeyFile, {
      envName: 'HUB_ASSERTION_PRIVATE_KEY_FILE',
      kid: config.contextBridge.assertionKeyId,
      nodeEnv: config.env,
    });
    assertions = createAssertionMinter({ signingKey: assertionKey });
  }
  return new GatewayBrain({
    client: createGatewayClient({ baseUrl: config.gateway.url, timeoutMs: config.gateway.timeoutMs }),
    serviceTokens: createGatewayTokenMinter({ signingKey }),
    assertions,
    workspaceId: config.audit.workspaceId,
    tokenTtlSeconds: config.gateway.tokenTtlSeconds,
    store: new PostgresGatewayRunStore(),
    audit: getAudit(),
    budget: {
      maxCompletionTokens: config.brain.limits.maxOutputTokens,
      maxToolCalls: config.brain.limits.maxToolCallsPerTurn,
    },
  });
}
