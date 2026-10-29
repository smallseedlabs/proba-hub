import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import('./config.js')).config;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('context bridge config', () => {
  it('defaults enabled to true when CONTEXT_BRIDGE_URL is set', async () => {
    const config = await loadConfig({
      CONTEXT_BRIDGE_URL: 'http://127.0.0.1:3500',
      CONTEXT_BRIDGE_ENABLED: '',
    });
    expect(config.contextBridge.enabled).toBe(true);
    expect(config.contextBridge.url).toBe('http://127.0.0.1:3500');
    expect(config.contextBridge.maxNeedRounds).toBe(2);
    expect(config.contextBridge.onFailure).toBe('clarify');
  });

  it('allows the feature flag off when URL is set (local only)', async () => {
    const config = await loadConfig({
      CONTEXT_BRIDGE_URL: 'http://127.0.0.1:3500',
      CONTEXT_BRIDGE_ENABLED: 'false',
      CONTEXT_BRIDGE_MAX_NEED_ROUNDS: '3',
      CONTEXT_BRIDGE_ON_FAILURE: 'hold',
    });
    expect(config.contextBridge.enabled).toBe(false);
    expect(config.contextBridge.maxNeedRounds).toBe(3);
    expect(config.contextBridge.onFailure).toBe('hold');
  });

  it('defaults enabled to false when URL is empty', async () => {
    const config = await loadConfig({ CONTEXT_BRIDGE_URL: '', CONTEXT_BRIDGE_ENABLED: '' });
    expect(config.contextBridge.enabled).toBe(false);
  });

  it('rejects an unknown onFailure mode', async () => {
    await expect(loadConfig({ CONTEXT_BRIDGE_ON_FAILURE: 'retry' })).rejects.toThrow(
      /CONTEXT_BRIDGE_ON_FAILURE/
    );
  });
});

describe('assertContextBridgeProductionGuards', () => {
  it('refuses production with the feature flag off', async () => {
    vi.resetModules();
    const { assertContextBridgeProductionGuards } = await import('./app.js');
    expect(() =>
      assertContextBridgeProductionGuards({
        isProduction: true,
        contextBridge: {
          enabled: false,
          url: 'http://127.0.0.1:3500',
        } as never,
      })
    ).toThrow(/CONTEXT_BRIDGE_ENABLED cannot be false/);
  });

  it('refuses production without CONTEXT_BRIDGE_URL', async () => {
    vi.resetModules();
    const { assertContextBridgeProductionGuards } = await import('./app.js');
    expect(() =>
      assertContextBridgeProductionGuards({
        isProduction: true,
        contextBridge: { enabled: true, url: '' } as never,
      })
    ).toThrow(/CONTEXT_BRIDGE_URL is required/);
  });

  it('allows non-production with the flag off', async () => {
    vi.resetModules();
    const { assertContextBridgeProductionGuards } = await import('./app.js');
    expect(() =>
      assertContextBridgeProductionGuards({
        isProduction: false,
        contextBridge: { enabled: false, url: '' } as never,
      })
    ).not.toThrow();
  });
});
