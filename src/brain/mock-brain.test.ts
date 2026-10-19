import { describe, it, expect } from 'vitest';
import { MockBrain } from './mock-brain.js';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';

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

      const step1Outputs = await brain.process(step1Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 1 outputs:', step1Outputs.map(o => o.type));
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

      const step2Outputs = await brain.process(step2Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 2 outputs:', step2Outputs.map(o => o.type));
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

      const step3Outputs = await brain.process(step3Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 3 outputs:', step3Outputs.map(o => o.type));
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

      const step4Outputs = await brain.process(step4Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 4 outputs:', step4Outputs.map(o => o.type));
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

      const step1Outputs = await brain.process(step1Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 1 outputs:', step1Outputs.map(o => o.type));
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

      const step2Outputs = await brain.process(step2Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 2 outputs:', step2Outputs.map(o => o.type));
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

      const step3Outputs = await brain.process(step3Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 3 outputs:', step3Outputs.map(o => o.type));
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

      const step1Outputs = await brain.process(step1Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 1 outputs:', step1Outputs.map(o => o.type));
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

      const step2Outputs = await brain.process(step2Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 2 outputs:', step2Outputs.map(o => o.type));
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

      const step3Outputs = await brain.process(step3Command, {
        userId: 'user1',
        threadId,
        goals: [],
        thread: { id: threadId, userId: 'user1', status: 'active', createdAt: new Date(), updatedAt: new Date() },
        messages: [],
        metrics: {},
      });

      console.log('Step 3 outputs:', step3Outputs.map(o => o.type));
      expect(step3Outputs).toHaveLength(2);
      expect(step3Outputs[0].type).toBe('reply');
      expect(step3Outputs[1].type).toBe('decision');
    });
  });
});
