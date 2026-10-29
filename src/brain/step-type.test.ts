import { describe, expect, it } from 'vitest';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import {
  HUB_STEP_EVENTS,
  mapCommandToStepType,
  mapHubEventToStepType,
} from './step-type.js';

function command(type: CommandEnvelope['type'], payload: Record<string, unknown> = {}): CommandEnvelope {
  return {
    type,
    clientMsgId: '110e8400-e29b-41d4-a716-446655440099',
    threadId: '880e8400-e29b-41d4-a716-446655440003',
    payload,
  } as CommandEnvelope;
}

describe('Hub event → stepType mapping', () => {
  it('maps every Hub event from the brief table', () => {
    const expected: Record<(typeof HUB_STEP_EVENTS)[number], string> = {
      user_message: 'interpret_message',
      clarify_needed: 'clarify',
      goal_accepted: 'plan_goal',
      propose_budget: 'propose_budget',
      budget_decision: 'handle_approval',
      launch_campaign: 'launch_campaign',
      review_performance: 'review_performance',
      explain_decision: 'explain_decision',
    };
    for (const event of HUB_STEP_EVENTS) {
      expect(mapHubEventToStepType(event)).toBe(expected[event]);
    }
    expect(HUB_STEP_EVENTS).toHaveLength(8);
  });

  it('maps every Hub command type that starts a brain step', () => {
    expect(mapCommandToStepType(command('send_message', { text: 'hello' }))).toBe('interpret_message');
    expect(mapCommandToStepType(command('send_message', { text: 'why did you pause?' }))).toBe(
      'explain_decision'
    );
    expect(mapCommandToStepType(command('create_goal', { title: 'Launch' }))).toBe('plan_goal');
    expect(mapCommandToStepType(command('approve_plan', { approved: true }))).toBe('handle_approval');
    expect(mapCommandToStepType(command('answer_ask', { askType: 'clarify' }), { askType: 'clarify' })).toBe(
      'clarify'
    );
    expect(
      mapCommandToStepType(command('answer_ask', { askType: 'action_approval' }), {
        askType: 'action_approval',
      })
    ).toBe('handle_approval');
    expect(
      mapCommandToStepType(command('answer_ask', { askType: 'plan_approval' }), { askType: 'plan_approval' })
    ).toBe('handle_approval');
    expect(mapCommandToStepType(command('explain', { target: 'budget' }))).toBe('explain_decision');
    expect(mapCommandToStepType(command('control', { action: 'pause' }))).toBe('interpret_message');
    expect(mapCommandToStepType(command('mark_read', {}))).toBe('interpret_message');
  });

  it('lets an explicit hubEvent override the command default', () => {
    expect(
      mapCommandToStepType(command('send_message', { text: 'check numbers' }), {
        hubEvent: 'review_performance',
      })
    ).toBe('review_performance');
    expect(
      mapCommandToStepType(command('send_message', { text: 'go live' }), { hubEvent: 'launch_campaign' })
    ).toBe('launch_campaign');
    expect(
      mapCommandToStepType(command('send_message', { text: 'budget?' }), { hubEvent: 'propose_budget' })
    ).toBe('propose_budget');
  });
});
