import type { BrainPort, BrainContext } from '../types.js';
import type { CommandEnvelope, BrainOutput } from '@smallseedlabs/proba-protocol';

export abstract class BaseBrainPort implements BrainPort {
  abstract process(command: CommandEnvelope, context: BrainContext): Promise<BrainOutput[]>;
}
