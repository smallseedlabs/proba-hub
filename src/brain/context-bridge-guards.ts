import { config } from '../config.js';

/**
 * Production requires the bridge on and CONTEXT_BRIDGE_URL set. Local development
 * may set CONTEXT_BRIDGE_ENABLED=false to keep the legacy in-Hub context.
 */
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
