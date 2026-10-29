import type { CommandEnvelope, StepType } from '@smallseedlabs/proba-protocol';

/**
 * Hub events that start a brain step (brief 07 table). Each maps to one bridge
 * `stepType` before the brain runs.
 */
export type HubStepEvent =
  | 'user_message'
  | 'clarify_needed'
  | 'goal_accepted'
  | 'propose_budget'
  | 'budget_decision'
  | 'launch_campaign'
  | 'review_performance'
  | 'explain_decision';

/** Exhaustive list for tests: every Hub event in the bridging table. */
export const HUB_STEP_EVENTS: readonly HubStepEvent[] = [
  'user_message',
  'clarify_needed',
  'goal_accepted',
  'propose_budget',
  'budget_decision',
  'launch_campaign',
  'review_performance',
  'explain_decision',
] as const;

const EVENT_TO_STEP: Record<HubStepEvent, StepType> = {
  user_message: 'interpret_message',
  clarify_needed: 'clarify',
  goal_accepted: 'plan_goal',
  propose_budget: 'propose_budget',
  budget_decision: 'handle_approval',
  launch_campaign: 'launch_campaign',
  review_performance: 'review_performance',
  explain_decision: 'explain_decision',
};

/** Map a conceptual Hub step event to the bridge stepType. */
export function mapHubEventToStepType(event: HubStepEvent): StepType {
  return EVENT_TO_STEP[event];
}

export interface MapCommandToStepTypeOptions {
  /** Ask type from the stored ask (answer_ask), when known. */
  askType?: string;
  /**
   * Optional override when the Hub knows the next step is not the default for
   * the command (for example a scheduled performance review).
   */
  hubEvent?: HubStepEvent;
}

/**
 * Map a Hub command that starts a brain step to the bridge `stepType`.
 * Covers every command type the Hub accepts; optional `hubEvent` wins when set.
 */
export function mapCommandToStepType(
  command: CommandEnvelope,
  options: MapCommandToStepTypeOptions = {}
): StepType {
  if (options.hubEvent) return mapHubEventToStepType(options.hubEvent);

  switch (command.type) {
    case 'send_message': {
      const text = String((command.payload as { text?: unknown } | null)?.text ?? '').toLowerCase();
      if (/\bwhy\b|\bexplain\b/.test(text)) return 'explain_decision';
      return 'interpret_message';
    }
    case 'create_goal':
      return 'plan_goal';
    case 'approve_plan':
      return 'handle_approval';
    case 'answer_ask': {
      const type =
        options.askType ??
        String((command.payload as { askType?: unknown } | null)?.askType ?? '');
      if (type === 'clarify') return 'clarify';
      if (type === 'action_approval' || type === 'plan_approval') return 'handle_approval';
      return 'clarify';
    }
    case 'explain':
      return 'explain_decision';
    case 'control':
    case 'mark_read':
      return 'interpret_message';
    default:
      return 'interpret_message';
  }
}
