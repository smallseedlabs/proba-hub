import { describe, it, expect } from 'vitest';
import { createBrain } from './factory.js';
import { MockBrain } from './mock-brain.js';
import { DeepSeekBrain } from './deepseek-brain.js';
import { config } from '../config.js';

describe('createBrain', () => {
  it('defaults to the mock brain', () => {
    expect(config.brain.provider).toBe('mock');
    expect(createBrain()).toBeInstanceOf(MockBrain);
    expect(createBrain({ scenario: 'approval_edit' })).toBeInstanceOf(MockBrain);
  });

  it('builds the DeepSeek brain only when asked for, and then needs an API key', () => {
    if (config.brain.deepseek.apiKey) {
      expect(createBrain({ provider: 'deepseek' })).toBeInstanceOf(DeepSeekBrain);
    } else {
      expect(() => createBrain({ provider: 'deepseek' })).toThrow(/DEEPSEEK_API_KEY/);
    }
  });

  it('rejects an unknown provider', () => {
    expect(() => createBrain({ provider: 'nope' as never })).toThrow(/Unknown brain provider/);
  });
});
