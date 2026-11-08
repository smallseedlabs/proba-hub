import type { BrainPort, GatewayAbortReason } from '../types.js';

/**
 * When the gateway brain owns context/preflight/tools, Hub must not also call
 * the context bridge (that would duplicate enrichment and can double-dispatch).
 */
export function shouldAttachHubContext(bridgeEnabled: boolean, brain: BrainPort): boolean {
  return bridgeEnabled && brain.ownsExternalContext !== true;
}

export function controlAbortReason(action: string): GatewayAbortReason | undefined {
  if (action === 'pause') return 'hub_pause';
  if (action === 'kill') return 'emergency_stop';
  return undefined;
}
