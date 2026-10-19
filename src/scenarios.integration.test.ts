import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp } from './app.js';
import { pool } from './db/client.js';
import { randomUUID } from 'crypto';
import { waitForEvents } from './test-helpers.js';

const app = await initializeApp({ startBackgroundJobs: true });

describe('Mock Brain Scenarios Integration Tests', () => {
  let token: string;
  let userId: string;
  let threadId: string;

  beforeAll(async () => {
    // Clean up existing data
    await pool.query('TRUNCATE TABLE commands, events, asks, ask_questions, ask_answers, messages, goals, inbox_items, threads, sessions, users, outbox, event_sequences CASCADE');

    const response = await app.inject({
      method: 'POST',
      url: '/dev/login',
      payload: {
        email: 'scenarios-test@example.com',
        name: 'Scenarios Test User',
      },
    });

    if (response.statusCode !== 200) {
      throw new Error(`Login failed with status ${response.statusCode}: ${response.body}`);
    }

    const data = JSON.parse(response.body);
    if (!data.user || !data.user.id) {
      throw new Error(`Login response missing user data: ${response.body}`);
    }
    
    token = data.token;
    userId = data.user.id;

    const threadResult = await pool.query(
      'INSERT INTO threads (user_id, status) VALUES ($1, $2) RETURNING id',
      [userId, 'active']
    );
    threadId = threadResult.rows[0].id;
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM commands WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM asks WHERE thread_id = $1', [threadId]);
    await pool.query('DELETE FROM outbox WHERE user_id = $1', [userId]);
    await pool.query('UPDATE event_sequences SET next_seq = 1 WHERE user_id = $1', [userId]);
  });

  async function sendCommand(command: any) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: command,
    });
    return response;
  }

  async function waitForNewEvents(minCount: number = 1, fromSeq: number = 0): Promise<any[]> {
    return waitForEvents(
      app,
      token,
      events => events.filter(e => e.seq > fromSeq).length >= minCount,
      { timeout: 5000, interval: 50 }
    );
  }

  describe('happy_path scenario', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'happy_path';
    });

    it('should complete full conversation flow: create_goal -> clarify -> plan -> approve -> decision', async () => {
      // Step 1: Create goal - wait for ask event
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test Campaign',
          description: 'Test',
          constraints: ['family-friendly'],
          budget: { daily: 100, total: 1000, currency: 'USD' },
        },
        sentAt: new Date().toISOString(),
      });

      let events = await waitForNewEvents(1);
      const askEvent = events.find((e: any) => e.type === 'ask');
      expect(askEvent, 'Should have ask event after create_goal').toBeDefined();
      expect(askEvent.payload.askType).toBe('clarify');
      const step1Seq = askEvent.seq;

      // Step 2: Answer clarification - wait for plan ask
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'answer_ask',
        threadId,
        payload: {
          askId: askEvent.payload.askId,
          askType: 'clarify',
          choice: 'approve',
          values: { audience: 'active' },
        },
        sentAt: new Date().toISOString(),
      });

      events = await waitForNewEvents(1, step1Seq);
      const planAsk = events.find((e: any) => 
        e.seq > step1Seq && e.type === 'ask' && e.payload.askType === 'plan_approval'
      );
      expect(planAsk, 'Should have plan_approval ask after answer_ask').toBeDefined();
      const step2Seq = planAsk.seq;

      // Step 3: Approve plan - wait for action ask
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'approve_plan',
        threadId,
        payload: {
          planId: planAsk.payload.askId,
          approved: true,
        },
        sentAt: new Date().toISOString(),
      });
      
      // Give async processing time to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      events = await waitForNewEvents(1, step2Seq);
      const actionAsk = events.find((e: any) => 
        e.seq > step2Seq && e.type === 'ask' && e.payload.askType === 'action_approval'
      );
      expect(actionAsk, 'Should have action_approval ask after approve_plan').toBeDefined();
      const step3Seq = actionAsk.seq;

      // Step 4: Answer action approval - wait for decision message
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'answer_ask',
        threadId,
        payload: {
          askId: actionAsk.payload.askId,
          askType: 'action_approval',
          choice: 'approve',
        },
        sentAt: new Date().toISOString(),
      });

      events = await waitForNewEvents(1, step3Seq);
      const messageEvents = events.filter((e: any) => e.seq > step3Seq && e.type === 'message');
      expect(messageEvents.length, 'Should have message events after final approval').toBeGreaterThan(0);
      
      const hasDecision = messageEvents.some((e: any) => 
        e.payload.text && e.payload.text.includes('Decision')
      );
      expect(hasDecision, 'Should have Decision message').toBe(true);
    });
  });

  describe('approval_edit scenario', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'approval_edit';
    });

    it('should handle edited approval (+20% to +10%)', async () => {
      // Create goal triggers plan - wait for ask
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test',
          description: 'Test',
          constraints: [],
          budget: { daily: 100, total: 1000, currency: 'USD' },
        },
        sentAt: new Date().toISOString(),
      });

      let events = await waitForNewEvents(1);
      const planAsk = events.find((e: any) => e.type === 'ask');
      expect(planAsk, 'Should have ask after create_goal').toBeDefined();
      const step1Seq = planAsk.seq;

      // Approve plan - wait for action ask
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'approve_plan',
        threadId,
        payload: {
          planId: planAsk.payload.askId,
          approved: true,
        },
        sentAt: new Date().toISOString(),
      });

      events = await waitForNewEvents(1, step1Seq);
      const actionAsk = events.find((e: any) => 
        e.seq > step1Seq && e.type === 'ask' && e.payload.askType === 'action_approval'
      );
      expect(actionAsk, 'Should have action_approval ask').toBeDefined();
      const step2Seq = actionAsk.seq;

      // Edit the approval - wait for adjusted message
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'answer_ask',
        threadId,
        payload: {
          askId: actionAsk.payload.askId,
          askType: 'action_approval',
          choice: 'edit',
          values: { dailyBudget: 110 },
          edit: "I'm comfortable with $110/day",
        },
        sentAt: new Date().toISOString(),
      });

      events = await waitForNewEvents(1, step2Seq);
      const replyEvents = events.filter((e: any) => e.seq > step2Seq && e.type === 'message');
      expect(replyEvents.length, 'Should have message after edit').toBeGreaterThan(0);
    });
  });

  describe('clarification_loop scenario', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'clarification_loop';
    });

    it('should handle multiple clarification rounds', async () => {
      // First clarify
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test',
          description: 'Test',
          constraints: [],
          budget: { daily: 100, total: 1000, currency: 'USD' },
        },
        sentAt: new Date().toISOString(),
      });

      let events = await waitForNewEvents(1);
      const firstAsk = events.find((e: any) => e.type === 'ask');
      expect(firstAsk, 'Should have first ask').toBeDefined();
      expect(firstAsk.payload.askType).toBe('clarify');
      const step1Seq = firstAsk.seq;

      // Answer first clarify - wait for second clarify
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'answer_ask',
        threadId,
        payload: {
          askId: firstAsk.payload.askId,
          askType: 'clarify',
          choice: 'approve',
          values: { product: 'Widget' },
        },
        sentAt: new Date().toISOString(),
      });

      events = await waitForNewEvents(1, step1Seq);
      const secondAsk = events.filter((e: any) => e.seq > step1Seq && e.type === 'ask').pop();
      expect(secondAsk, 'Should have second ask').toBeDefined();
      expect(secondAsk.payload.askType).toBe('clarify');
      const step2Seq = secondAsk.seq;

      // Answer second clarify - should end loop
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'answer_ask',
        threadId,
        payload: {
          askId: secondAsk.payload.askId,
          askType: 'clarify',
          choice: 'approve',
          values: { market: 'USA' },
        },
        sentAt: new Date().toISOString(),
      });

      events = await waitForNewEvents(1, step2Seq);
      const finalEvents = events.filter(e => e.seq > step2Seq);
      
      // Should have plan now, not another clarify
      const hasPlan = finalEvents.some((e: any) => 
        e.type === 'ask' && e.payload.askType === 'plan_approval'
      );
      const hasReply = finalEvents.some((e: any) => e.type === 'message');
      
      expect(hasPlan || hasReply, 'Should have plan or reply, not third clarify').toBe(true);
    });
  });

  describe('control commands', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'happy_path';
    });

    it('should handle pause control bypassing brain', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'control',
        threadId,
        payload: {
          action: 'pause',
        },
        sentAt: new Date().toISOString(),
      });

      const events = await waitForNewEvents(1);
      const statusEvent = events.find((e: any) => e.type === 'status');
      expect(statusEvent, 'Should have status event').toBeDefined();
      expect(statusEvent.payload.state).toBe('pause');
    });

    it('should handle resume control', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'control',
        threadId,
        payload: {
          action: 'resume',
        },
        sentAt: new Date().toISOString(),
      });

      const events = await waitForNewEvents(1);
      const statusEvent = events.find((e: any) => e.type === 'status');
      expect(statusEvent, 'Should have status event').toBeDefined();
      expect(statusEvent.payload.state).toBe('resume');
    });

    it('should handle kill control', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'control',
        threadId,
        payload: {
          action: 'kill',
        },
        sentAt: new Date().toISOString(),
      });

      const events = await waitForNewEvents(1);
      const statusEvent = events.find((e: any) => e.type === 'status');
      expect(statusEvent, 'Should have status event').toBeDefined();
      expect(statusEvent.payload.state).toBe('kill');
    });
  });

  describe('malformed_output scenario', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'malformed_output';
    });

    it('should handle malformed brain output gracefully', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test',
          description: 'Test',
          constraints: [],
          budget: { daily: 100, total: 1000, currency: 'USD' },
        },
        sentAt: new Date().toISOString(),
      });

      const events = await waitForNewEvents(1);
      
      // Should have error event, not crash
      const errorEvent = events.find((e: any) => e.type === 'error');
      expect(errorEvent, 'Should have error event').toBeDefined();
      expect(errorEvent.payload.code).toBe('brain_error');
    });
  });
});
