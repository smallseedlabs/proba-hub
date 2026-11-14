import { config, type BrainProviderKind } from '../config.js';
import { loadAssertionPrivateKey } from '../auth/assertions/private-key.js';
import { createAssertionMinter } from '../auth/assertions/mint.js';
import { createGatewayTokenMinter } from '../auth/gateway-token.js';
import { getAudit } from '../audit/service.js';
import { pool } from '../db/client.js';
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

export interface GatewayRuntime {
  client: ReturnType<typeof createGatewayClient>;
  serviceTokens: ReturnType<typeof createGatewayTokenMinter>;
  assertions: ReturnType<typeof createAssertionMinter> | null;
}

/** Gateway client + Hub service-token and act-as minters. Null when the gateway is disabled. */
export async function createGatewayRuntime(): Promise<GatewayRuntime | null> {
  assertGatewayGuards();
  if (!config.gateway.enabled) return null;
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
  return {
    client: createGatewayClient({ baseUrl: config.gateway.url, timeoutMs: config.gateway.timeoutMs }),
    serviceTokens: createGatewayTokenMinter({ signingKey }),
    assertions,
  };
}

/**
 * Runtime brain: gateway when GATEWAY_URL is enabled, otherwise mock/deepseek.
 * Gateway excludes DeepSeek/mock so there is no double model dispatch.
 */
export async function createRuntimeBrain(options: CreateBrainOptions = {}): Promise<BrainPort> {
  const runtime = await createGatewayRuntime();
  if (!runtime) return createBrain(options);
  return new GatewayBrain({
    client: runtime.client,
    serviceTokens: runtime.serviceTokens,
    assertions: runtime.assertions,
    workspaceId: config.audit.workspaceId,
    tokenTtlSeconds: config.gateway.tokenTtlSeconds,
    store: new PostgresGatewayRunStore(),
    audit: getAudit(),
    budget: {
      maxCompletionTokens: config.brain.limits.maxOutputTokens,
    },
    onCampaignCreated: async ({ workspaceId, userId, goalId, threadId, outcome }) => {
      const probaCampaignId = typeof outcome.probaCampaignId === 'string' ? outcome.probaCampaignId : undefined;
      if (!probaCampaignId || !goalId || !threadId) return;
      const platform = typeof outcome.platform === 'string' ? outcome.platform : 'reddit';
      const accountId = typeof outcome.providerAccountId === 'string' ? outcome.providerAccountId : null;
      const providerCampaignId = typeof outcome.providerCampaignId === 'string' ? outcome.providerCampaignId : null;
      const dailyBudget = typeof outcome.dailyBudget === 'number' && outcome.dailyBudget > 0 ? outcome.dailyBudget : null;
      const currency =
        typeof outcome.currency === 'string' && outcome.currency.length === 3 ? outcome.currency.toUpperCase() : null;
      await pool.query(
        `INSERT INTO analytics_campaigns
           (workspace_id, user_id, proba_campaign_id, goal_id, thread_id, platform, account_id,
            provider_campaign_id, current_daily_budget, currency, rules)
         VALUES (
           $1::text,$2,$3,$4,$5,$6::varchar,
           COALESCE($7::varchar, (SELECT provider_account_id FROM platform_connections WHERE workspace_id = $1::text AND provider = $6::varchar LIMIT 1)),
           $8,$9,$10,'{}'::jsonb
         )
         ON CONFLICT (workspace_id, user_id, proba_campaign_id) DO UPDATE SET
           account_id = COALESCE(EXCLUDED.account_id, analytics_campaigns.account_id),
           provider_campaign_id = COALESCE(EXCLUDED.provider_campaign_id, analytics_campaigns.provider_campaign_id),
           current_daily_budget = COALESCE(EXCLUDED.current_daily_budget, analytics_campaigns.current_daily_budget),
           currency = COALESCE(EXCLUDED.currency, analytics_campaigns.currency),
           updated_at = NOW()`,
        [workspaceId, userId, probaCampaignId, goalId, threadId, platform, accountId, providerCampaignId, dailyBudget, currency]
      );
    },
  });
}
