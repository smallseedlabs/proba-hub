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

describe('gateway config', () => {
  it('defaults enabled to true when GATEWAY_URL is set', async () => {
    const config = await loadConfig({ GATEWAY_URL: 'http://127.0.0.1:3700', GATEWAY_ENABLED: '' });
    expect(config.gateway.enabled).toBe(true);
    expect(config.gateway.url).toBe('http://127.0.0.1:3700');
    expect(config.gateway.tokenTtlSeconds).toBe(120);
  });

  it('stays disabled when URL is empty', async () => {
    const config = await loadConfig({ GATEWAY_URL: '', GATEWAY_ENABLED: '' });
    expect(config.gateway.enabled).toBe(false);
  });

  it('allows an explicit off switch while a URL is present', async () => {
    const config = await loadConfig({ GATEWAY_URL: 'http://127.0.0.1:3700', GATEWAY_ENABLED: 'false' });
    expect(config.gateway.enabled).toBe(false);
  });
});

describe('assertGatewayGuards', () => {
  it('refuses enabled-without-URL and deepseek dual dispatch', async () => {
    vi.resetModules();
    const { assertGatewayGuards } = await import('./brain/context-bridge-guards.js');
    expect(() =>
      assertGatewayGuards({
        brain: { provider: 'mock' } as never,
        gateway: { enabled: true, url: '' } as never,
      })
    ).toThrow(/GATEWAY_URL is required/);
    expect(() =>
      assertGatewayGuards({
        brain: { provider: 'deepseek' } as never,
        gateway: { enabled: true, url: 'http://127.0.0.1:3700' } as never,
      })
    ).toThrow(/double model dispatch/);
  });

  it('allows disabled gateway with mock brain', async () => {
    vi.resetModules();
    const { assertGatewayGuards } = await import('./brain/context-bridge-guards.js');
    expect(() =>
      assertGatewayGuards({
        brain: { provider: 'mock' } as never,
        gateway: { enabled: false, url: '' } as never,
      })
    ).not.toThrow();
  });
});
