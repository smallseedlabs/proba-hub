import { config, type BrainProviderKind } from '../config.js';
import type { BrainPort } from '../types.js';
import { MockBrain } from './mock-brain.js';
import { DeepSeekBrain } from './deepseek-brain.js';

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
