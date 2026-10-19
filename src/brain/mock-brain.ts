import { readFile } from 'fs/promises';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { BaseBrainPort } from './port.js';
import { logger } from '../logger.js';
import type { BrainContext, BrainGoalUpdate } from '../types.js';
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
  /** Optional goal progress/metrics reported when this step runs (mock only). */
  goal?: BrainGoalUpdate;
}

interface Scenario {
  name: string;
  description: string;
  steps: ScenarioStep[];
}

interface ThreadState {
  stepIndex: number;
  clarificationRound: number;
  scenarioName: string;
  pendingGoalUpdate?: BrainGoalUpdate;
}

/** `#scenario_name` in a goal title/description or first message picks the scenario for that thread. */
const SCENARIO_TAG = /#([a-z][a-z0-9_]{1,63})\b/gi;
const SCENARIO_NAME = /^[a-z][a-z0-9_]{1,63}$/;

export class MockBrain extends BaseBrainPort {
  private scenarios: Map<string, Scenario> = new Map();
  private scenarioName: string;
  private threadStates: Map<string, ThreadState> = new Map();

  constructor(scenarioName: string) {
    super();
    this.scenarioName = scenarioName;
  }

  private getThreadState(threadId: string, command: CommandEnvelope): ThreadState {
    let state = this.threadStates.get(threadId);
    if (!state) {
      state = { stepIndex: 0, clarificationRound: 0, scenarioName: this.pickScenario(command) };
      this.threadStates.set(threadId, state);
      logger.debug({ threadId, scenario: state.scenarioName }, 'Created new thread state');
    }
    return state;
  }

  /** Default scenario, unless the conversation opens with a `#scenario_name` tag for a known scenario. */
  private pickScenario(command: CommandEnvelope): string {
    const payload = (command.payload ?? {}) as Record<string, unknown>;
    const text = [payload.title, payload.description, payload.text].filter((v) => typeof v === 'string').join(' ');
    for (const match of text.matchAll(SCENARIO_TAG)) {
      const name = match[1].toLowerCase();
      if (MockBrain.availableScenarios().includes(name)) return name;
    }
    return this.scenarioName;
  }

  /** Scenario names shipped in src/brain/scenarios. */
  static availableScenarios(): string[] {
    return readdirSync(join(__dirname, 'scenarios'))
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => f.replace(/\.yaml$/, ''))
      .sort();
  }

  takeGoalUpdate(threadId: string): BrainGoalUpdate | undefined {
    const state = this.threadStates.get(threadId);
    const update = state?.pendingGoalUpdate;
    if (state) state.pendingGoalUpdate = undefined;
    return update;
  }

  async loadScenario(name: string = this.scenarioName): Promise<Scenario> {
    const cached = this.scenarios.get(name);
    if (cached) return cached;
    if (!SCENARIO_NAME.test(name)) throw new Error(`Invalid scenario name: ${name}`);

    try {
      const scenarioPath = join(__dirname, 'scenarios', `${name}.yaml`);
      const content = await readFile(scenarioPath, 'utf-8');
      const scenario = yaml.load(content) as Scenario;
      this.scenarios.set(name, scenario);
      logger.info({ scenario: name }, 'Loaded brain scenario');
      return scenario;
    } catch (error) {
      logger.error({ error, scenario: name }, 'Failed to load scenario');
      throw error;
    }
  }

  async process(command: CommandEnvelope, context: BrainContext): Promise<BrainOutput[]> {
    const threadId = context.threadId || 'default';
    const state = this.getThreadState(threadId, command);
    const scenario = await this.loadScenario(state.scenarioName);
    state.pendingGoalUpdate = undefined;

    logger.info(
      { 
        scenario: state.scenarioName,
        threadId,
        commandType: command.type,
        stepIndex: state.stepIndex,
        clarificationRound: state.clarificationRound
      },
      'MockBrain processing command'
    );

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
      logger.info({ askId: payload.askId, askType: payload.askType, choice: payload.choice }, 'Processing answer_ask');
      if (payload.askType === 'clarify') {
        state.clarificationRound++;
        logger.debug({ threadId, clarificationRound: state.clarificationRound }, 'Incremented clarification round');
      }
    }

    for (let i = state.stepIndex; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      
      const matches = this.matchesTrigger(step.trigger, command, state);
      logger.debug({
        stepIndex: i,
        trigger: step.trigger,
        commandType: command.type,
        commandPayload: command.payload,
        matches
      }, 'Checking trigger match');
      
      if (matches) {
        state.stepIndex = i + 1;
        state.pendingGoalUpdate = step.goal;
        
        const outputs = step.outputs.map(output => {
          if (output.type === 'clarify' && 'expiresIn' in output) {
            const { expiresIn: _expiresIn, onExpire: _onExpire, ...rest } = output as Record<string, unknown>;
            return rest as unknown as BrainOutput;
          }
          return output;
        });
        
        logger.info(
          { 
            scenario: state.scenarioName,
            step: i, 
            trigger: step.trigger,
            outputCount: outputs.length,
            outputTypes: outputs.map(o => o.type)
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

  private matchesTrigger(trigger: ScenarioTrigger, command: CommandEnvelope, state: ThreadState): boolean {
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

    if (trigger.round !== undefined) {
      const payload = command.payload as Record<string, unknown>;
      if (payload.askType === 'clarify' && state.clarificationRound !== trigger.round) {
        return false;
      }
    }

    return true;
  }
}
