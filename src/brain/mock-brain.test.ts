import { describe, it, expect, beforeEach } from 'vitest';
import { MockBrain } from './mock-brain.js';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import type { BrainContext } from '../types.js';

describe('MockBrain Scenario Parsing', () => {
  let brain: MockBrain;
  let context: BrainContext;

  beforeEach(() => {
    context = {
      userId: 'test-user-id',
      threadId: 'test-thread-id',
      client: {} as any,
    };
  });

  describe('happy_path scenario', () => {
    beforeEach(() => {
      brain = new MockBrain('happy_path');
    });

    it('should respond to create_goal with clarify', async () => {
      const command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'create_goal',
        threadId: 'test-thread',
        payload: {
          title: 'Test Goal',
          description: 'Test',
          constraints: [],
          budget: { daily: 100, total: 1000, currency: 'USD' },
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const outputs = await brain.process(command, context);
      
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('clarify');
      expect(outputs[0]).toHaveProperty('reason');
      expect(outputs[0]).toHaveProperty('questions');
    });

    it('should respond to answer_ask (clarify) with plan', async () => {
      brain = new MockBrain('happy_path');
      
      // First trigger clarify
      await brain.process({
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'create_goal',
        threadId: 'test-thread',
        payload: { title: 'Test', description: 'Test', constraints: [], budget: { daily: 100, total: 1000, currency: 'USD' } },
        sentAt: '2024-10-19T10:00:00Z',
      }, context);

      // Then answer
      const command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: 'test-2',
        type: 'answer_ask',
        threadId: 'test-thread',
        payload: {
          askId: 'ask-1',
          askType: 'clarify',
          choice: 'approve',
          values: { audience: 'active' },
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const outputs = await brain.process(command, context);
      
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('plan');
      expect(outputs[0]).toHaveProperty('title');
      expect(outputs[0]).toHaveProperty('steps');
    });
  });

  describe('approval_edit scenario', () => {
    beforeEach(() => {
      brain = new MockBrain('approval_edit');
    });

    it('should handle edited approval with choice=edit', async () => {
      brain = new MockBrain('approval_edit');
      
      // Trigger plan
      await brain.process({
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'create_goal',
        threadId: 'test-thread',
        payload: { title: 'Test', description: 'Test', constraints: [], budget: { daily: 100, total: 1000, currency: 'USD' } },
        sentAt: '2024-10-19T10:00:00Z',
      }, context);

      // Approve plan
      await brain.process({
        kind: 'command',
        clientMsgId: 'test-2',
        type: 'approve_plan',
        threadId: 'test-thread',
        payload: { planId: 'plan-1', approved: true },
        sentAt: '2024-10-19T10:00:00Z',
      }, context);

      // Answer with edit
      const command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: 'test-3',
        type: 'answer_ask',
        threadId: 'test-thread',
        payload: {
          askId: 'ask-1',
          askType: 'action_approval',
          choice: 'edit',
          values: { dailyBudget: 110 },
        },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const outputs = await brain.process(command, context);
      
      expect(outputs.length).toBeGreaterThan(0);
      expect(outputs.some(o => o.type === 'reply')).toBe(true);
    });
  });

  describe('clarification_loop scenario', () => {
    beforeEach(() => {
      brain = new MockBrain('clarification_loop');
    });

    it('should trigger first clarify on create_goal', async () => {
      const outputs = await brain.process({
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'create_goal',
        threadId: 'test-thread',
        payload: { title: 'Test', description: 'Test', constraints: [], budget: { daily: 100, total: 1000, currency: 'USD' } },
        sentAt: '2024-10-19T10:00:00Z',
      }, context);

      expect(outputs[0].type).toBe('clarify');
      const clarify = outputs[0] as any;
      expect(clarify.questions).toBeDefined();
      expect(clarify.questions[0].id).toBe('product');
    });
  });

  describe('control commands', () => {
    beforeEach(() => {
      brain = new MockBrain('happy_path');
    });

    it('should handle pause control', async () => {
      const command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'control',
        threadId: 'test-thread',
        payload: { action: 'pause' },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const outputs = await brain.process(command, context);
      
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('reply');
      expect((outputs[0] as any).text).toContain('pause');
    });

    it('should handle resume control', async () => {
      const command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'control',
        threadId: 'test-thread',
        payload: { action: 'resume' },
        sentAt: '2024-10-19T10:00:00Z',
      };

      const outputs = await brain.process(command, context);
      
      expect(outputs).toHaveLength(1);
      expect(outputs[0].type).toBe('reply');
      expect((outputs[0] as any).text).toContain('resume');
    });
  });

  describe('malformed_output scenario', () => {
    beforeEach(() => {
      brain = new MockBrain('malformed_output');
    });

    it('should load scenario with invalid output type', async () => {
      const command: CommandEnvelope = {
        kind: 'command',
        clientMsgId: 'test-1',
        type: 'create_goal',
        threadId: 'test-thread',
        payload: { title: 'Test', description: 'Test', constraints: [], budget: { daily: 100, total: 1000, currency: 'USD' } },
        sentAt: '2024-10-19T10:00:00Z',
      };

      // Should not throw, but output will be malformed
      const outputs = await brain.process(command, context);
      expect(outputs).toBeDefined();
    });
  });
});
