import { config } from '../config.js';

/**
 * Production requires the bridge on and CONTEXT_BRIDGE_URL set. Local development
 * may set CONTEXT_BRIDGE_ENABLED=false to keep the legacy in-Hub context.
 */
/**
 * Gateway is optional. When GATEWAY_ENABLED (or GATEWAY_URL) is on, the URL is
 * required in every environment. DeepSeek/mock must not run beside it.
 */
export function assertGatewayGuards(
  cfg: Pick<typeof config, 'brain' | 'gateway'> = config
): void {
  if (!cfg.gateway.enabled) return;
  if (!cfg.gateway.url.trim()) {
    throw new Error('GATEWAY_URL is required when GATEWAY_ENABLED is on');
  }
  if (cfg.brain.provider === 'deepseek') {
    throw new Error('BRAIN_PROVIDER=deepseek cannot be combined with GATEWAY_URL (double model dispatch)');
  }
}

export function assertContextBridgeProductionGuards(
  cfg: Pick<typeof config, 'isProduction' | 'contextBridge'> = config
): void {
  if (!cfg.isProduction) return;
  if (!cfg.contextBridge.enabled) {
    throw new Error(
      'CONTEXT_BRIDGE_ENABLED cannot be false when NODE_ENV=production (local-only opt-out)'
    );
  }
  if (!cfg.contextBridge.url.trim()) {
    throw new Error('CONTEXT_BRIDGE_URL is required when NODE_ENV=production');
  }
}
