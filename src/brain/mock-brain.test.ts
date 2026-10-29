import { describe, it, expect } from 'vitest';
import { MockBrain } from './mock-brain.js';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import type { PoolClient } from 'pg';
import { normalizeBrainStepResult } from '../types.js';

const mockClient = {} as PoolClient;

async function brainOutputs(brain: MockBrain, command: CommandEnvelope, context: Parameters<MockBrain['process']>[1]) {
  return normalizeBrainStepResult(await brain.process(command, context)).outputs;
}

describe('MockBrain Direct Unit Tests', () => {
  describe('happy_path scenario', () => {
    it('should progress through all steps', async () => {
      const brain = new MockBrain('happy_path');
      const threadId = 'test-thread';

      // Step 1: create_goal -> clarify
      const step1Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '1',
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test Campaign',
          description: 'Test',
          constraints: {},
          budget: { total: 5000 },
        },
        sentAt: new Date().toISOString(),
      };

      const step1Outputs = await brainOutputs(brain, step1Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step1Outputs).toHaveLength(1);
      expect(step1Outputs[0].type).toBe('clarify');

      // Step 2: answer_ask (clarify) -> plan
      const step2Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '2',
        type: 'answer_ask',
        threadId,
        payload: {
          askId: 'ask-1',
          askType: 'clarify',
          choice: 'active',
          values: { audience: 'active' },
        },
        sentAt: new Date().toISOString(),
      };

      const step2Outputs = await brainOutputs(brain, step2Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step2Outputs).toHaveLength(1);
      expect(step2Outputs[0].type).toBe('plan');

      // Step 3: approve_plan -> tool_call
      const step3Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '3',
        type: 'approve_plan',
        threadId,
        payload: {
          planId: 'plan-1',
          approved: true,
        },
        sentAt: new Date().toISOString(),
      };

      const step3Outputs = await brainOutputs(brain, step3Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step3Outputs).toHaveLength(1);
      expect(step3Outputs[0].type).toBe('tool_call');

      // Step 4: answer_ask (action_approval) -> reply + decision
      const step4Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '4',
        type: 'answer_ask',
        threadId,
        payload: {
          askId: 'ask-2',
          askType: 'action_approval',
          choice: 'approve',
        },
        sentAt: new Date().toISOString(),
      };

      const step4Outputs = await brainOutputs(brain, step4Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step4Outputs).toHaveLength(2);
      expect(step4Outputs[0].type).toBe('reply');
      expect(step4Outputs[1].type).toBe('decision');
    });
  });

  describe('clarification_loop scenario', () => {
    it('should handle multiple clarification rounds', async () => {
      const brain = new MockBrain('clarification_loop');
      const threadId = 'test-thread';

      // Step 1: create_goal -> clarify (round 0)
      const step1Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '1',
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test',
          description: 'Test',
          constraints: {},
          budget: { total: 1000 },
        },
        sentAt: new Date().toISOString(),
      };

      const step1Outputs = await brainOutputs(brain, step1Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step1Outputs).toHaveLength(1);
      expect(step1Outputs[0].type).toBe('clarify');

      // Step 2: answer_ask (round 1) -> clarify again
      const step2Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '2',
        type: 'answer_ask',
        threadId,
        payload: {
          askId: 'ask-1',
          askType: 'clarify',
          choice: 'product-answer',
          values: { product: 'Widget' },
        },
        sentAt: new Date().toISOString(),
      };

      const step2Outputs = await brainOutputs(brain, step2Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step2Outputs).toHaveLength(1);
      expect(step2Outputs[0].type).toBe('clarify');

      // Step 3: answer_ask (round 2) -> reply + plan
      const step3Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '3',
        type: 'answer_ask',
        threadId,
        payload: {
          askId: 'ask-2',
          askType: 'clarify',
          choice: 'market-answer',
          values: { market: 'Consumers' },
        },
        sentAt: new Date().toISOString(),
      };

      const step3Outputs = await brainOutputs(brain, step3Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step3Outputs).toHaveLength(2);
      expect(step3Outputs[0].type).toBe('reply');
      expect(step3Outputs[1].type).toBe('plan');
    });
  });

  describe('approval_edit scenario', () => {
    it('should handle plan edits', async () => {
      const brain = new MockBrain('approval_edit');
      const threadId = 'test-thread';

      // Step 1: create_goal -> plan
      const step1Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '1',
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test Campaign',
          description: 'Test',
          constraints: {},
          budget: { total: 5000 },
        },
        sentAt: new Date().toISOString(),
      };

      const step1Outputs = await brainOutputs(brain, step1Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step1Outputs).toHaveLength(1);
      expect(step1Outputs[0].type).toBe('plan');

      // Step 2: approve_plan (approved: true) -> tool_call
      const step2Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '2',
        type: 'approve_plan',
        threadId,
        payload: {
          planId: 'plan-1',
          approved: true,
        },
        sentAt: new Date().toISOString(),
      };

      const step2Outputs = await brainOutputs(brain, step2Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step2Outputs).toHaveLength(1);
      expect(step2Outputs[0].type).toBe('tool_call');

      // Step 3: answer_ask with choice: edit -> reply + decision  
      const step3Command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: '3',
        type: 'answer_ask',
        threadId,
        payload: {
          askId: 'ask-1',
          askType: 'action_approval',
          choice: 'edit',
        },
        sentAt: new Date().toISOString(),
      };

      const step3Outputs = await brainOutputs(brain, step3Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        client: mockClient,
      });

      expect(step3Outputs).toHaveLength(2);
      expect(step3Outputs[0].type).toBe('reply');
      expect(step3Outputs[1].type).toBe('decision');
    });
  });
});

describe('MockBrain scenario selection and goal updates', () => {
  const ctx = (threadId: string) => ({
    userId: 'user1',
    threadId,
    goals: [],
    messages: [],
    client: mockClient,
  });
  const createGoal = (threadId: string, title: string): CommandEnvelope => ({
    kind: 'command',
    clientMsgId: `c-${threadId}`,
    type: 'create_goal',
    threadId,
    payload: { title },
    sentAt: new Date().toISOString(),
  });

  it('lists the shipped scenarios', () => {
    expect(MockBrain.availableScenarios()).toEqual(
      expect.arrayContaining(['approval_edit', 'clarification_loop', 'happy_path'])
    );
  });

  it('uses the default scenario unless the goal names one with #tag', async () => {
    const brain = new MockBrain('happy_path');
    const def = await brainOutputs(brain, createGoal('t1', 'Launch shoes'), ctx('t1'));
    expect(def[0]).toMatchObject({ type: 'clarify', reason: 'Need clarification on target audience' });

    const tagged = await brainOutputs(brain, createGoal('t2', 'Launch shoes #approval_edit'), ctx('t2'));
    expect(tagged[0].type).toBe('plan');

    const unknownTag = await brainOutputs(brain, createGoal('t3', 'Launch #nope'), ctx('t3'));
    expect(unknownTag[0].type).toBe('clarify');
  });

  it('reports the matched step goal update once', async () => {
    const brain = new MockBrain('happy_path');
    await brainOutputs(brain, createGoal('t4', 'Goal'), ctx('t4'));
    const update = brain.takeGoalUpdate('t4');
    expect(update?.progress).toMatchObject({ completed: 0, total: 4 });
    expect(brain.takeGoalUpdate('t4')).toBeUndefined();
  });
});
