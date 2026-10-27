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

describe('brain config', () => {
  it('is the mock brain with the stated limits by default', async () => {
    const config = await loadConfig({ BRAIN_PROVIDER: '', BRAIN_ALLOWED_TOOLS: '' });
    expect(config.brain.provider).toBe('mock');
    expect(config.brain.limits).toMatchObject({ maxToolCallsPerTurn: 2, maxActionSpend: 1000, maxPlanBudget: 10000, allowedTools: [] });
    expect(config.brain.deepseek).toMatchObject({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
  });

  it('reads the provider, DeepSeek settings and limits from the environment', async () => {
    const config = await loadConfig({
      BRAIN_PROVIDER: 'DeepSeek',
      DEEPSEEK_API_KEY: ' sk-abc ',
      DEEPSEEK_BASE_URL: 'https://llm.example/',
      DEEPSEEK_MODEL: 'deepseek-reasoner',
      BRAIN_MAX_TOOL_CALLS: '4',
      BRAIN_MAX_ACTION_SPEND: '250.5',
      BRAIN_MAX_PLAN_BUDGET: '0',
      BRAIN_ALLOWED_TOOLS: 'adjust_budget, pause_campaign',
    });
    expect(config.brain.provider).toBe('deepseek');
    expect(config.brain.deepseek).toMatchObject({ apiKey: 'sk-abc', baseUrl: 'https://llm.example', model: 'deepseek-reasoner' });
    expect(config.brain.limits).toMatchObject({
      maxToolCallsPerTurn: 4, maxActionSpend: 250.5, maxPlanBudget: 0, allowedTools: ['adjust_budget', 'pause_campaign'],
    });
  });

  it('rejects an unknown provider', async () => {
    await expect(loadConfig({ BRAIN_PROVIDER: 'gpt' })).rejects.toThrow(/BRAIN_PROVIDER must be one of mock, deepseek/);
  });
});
