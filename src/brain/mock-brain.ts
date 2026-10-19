import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { BaseBrainPort } from './port.js';
import { logger } from '../logger.js';
import type { BrainContext } from '../types.js';
import type { CommandEnvelope, BrainOutput } from '@smallseedlabs/proba-protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ScenarioTrigger {
  type: string;
  askType?: string;
  choice?: string;
  approved?: boolean;
  round?: number;
}

interface ScenarioStep {
  trigger: ScenarioTrigger;
  outputs: BrainOutput[];
}

interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

export class MockBrain extends BaseBrainPort {
  private scenario: Scenario | null = null;
  private scenarioName: string;
  private stepIndex = 0;
  private clarificationRound = 0;

  constructor(scenarioName: string) {
    super();
    this.scenarioName = scenarioName;
  }

  async loadScenario(): Promise<void> {
    if (this.scenario) return;
    
    try {
      const scenarioPath = join(__dirname, 'scenarios', `${this.scenarioName}.yaml`);
      const content = await readFile(scenarioPath, 'utf-8');
      this.scenario = yaml.load(content) as Scenario;
      logger.info({ scenario: this.scenarioName }, 'Loaded brain scenario');
    } catch (error) {
      logger.error({ error, scenario: this.scenarioName }, 'Failed to load scenario');
      throw error;
    }
  }

  async process(command: CommandEnvelope, _context: BrainContext): Promise<BrainOutput[]> {
    await this.loadScenario();
    
    if (!this.scenario) {
      throw new Error('Scenario not loaded');
    }

    if (command.type === 'control') {
      return [
        {
          type: 'reply',
          text: `Control action ${(command.payload as Record<string, unknown>).action} acknowledged`,
        },
      ];
    }

    if (command.type === 'answer_ask') {
      const payload = command.payload as Record<string, unknown>;
      if (payload.choice !== 'approve' && payload.askType === 'clarify') {
        this.clarificationRound++;
      }
    }

    for (let i = this.stepIndex; i < this.scenario.steps.length; i++) {
      const step = this.scenario.steps[i];
      
      if (this.matchesTrigger(step.trigger, command)) {
        this.stepIndex = i + 1;
        
        const outputs = step.outputs.map(output => {
          if (output.type === 'clarify' && 'expiresIn' in output) {
            const { expiresIn: _expiresIn, onExpire: _onExpire, ...rest } = output as Record<string, unknown>;
            return rest as unknown as BrainOutput;
          }
          return output;
        });
        
        logger.info(
          { 
            scenario: this.scenarioName, 
            step: i, 
            trigger: step.trigger,
            outputCount: outputs.length 
          }, 
          'Matched scenario step'
        );
        
        return outputs;
      }
    }

    return [
      {
        type: 'reply',
        text: 'Understood. Processing your request.',
      },
    ];
  }

  private matchesTrigger(trigger: ScenarioTrigger, command: CommandEnvelope): boolean {
    if (trigger.type !== command.type) {
      return false;
    }

    if (trigger.askType && command.type === 'answer_ask') {
      const payload = command.payload as Record<string, unknown>;
      if (payload.askType !== trigger.askType) {
        return false;
      }
    }

    if (trigger.choice && command.type === 'answer_ask') {
      const payload = command.payload as Record<string, unknown>;
      if (payload.choice !== trigger.choice) {
        return false;
      }
    }

    if (trigger.approved !== undefined && command.type === 'approve_plan') {
      const payload = command.payload as Record<string, unknown>;
      if (payload.approved !== trigger.approved) {
        return false;
      }
    }

    if (trigger.round !== undefined && command.type === 'answer_ask') {
      if (this.clarificationRound !== trigger.round) {
        return false;
      }
    }

    return true;
  }
}
