import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fastify as app } from './server.js';
import { pool } from './db/client.js';

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

  async function getEvents(afterSeq = 0) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/events?after=${afterSeq}`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    return JSON.parse(response.body);
  }

  async function waitForProcessing() {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  describe('happy_path scenario', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'happy_path';
    });

    it('should complete full conversation flow: create_goal -> clarify -> plan -> approve -> decision', async () => {
      // Step 1: Create goal
      await sendCommand({
        kind: 'command',
        clientMsgId: 'hp-1',
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

      await waitForProcessing();

      let events = await getEvents();
      expect(events.events.length).toBeGreaterThan(0);
      
      const askEvent = events.events.find((e: any) => e.type === 'ask');
      expect(askEvent).toBeDefined();
      expect(askEvent.payload.askType).toBe('clarify');

      // Step 2: Answer clarification
      await sendCommand({
        kind: 'command',
        clientMsgId: 'hp-2',
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

      await waitForProcessing();

      events = await getEvents();
      const planAsk = events.events.find((e: any) => 
        e.type === 'ask' && e.payload.askType === 'plan_approval'
      );
      expect(planAsk).toBeDefined();

      // Step 3: Approve plan
      await sendCommand({
        kind: 'command',
        clientMsgId: 'hp-3',
        type: 'approve_plan',
        threadId,
        payload: {
          planId: planAsk.payload.askId,
          approved: true,
        },
        sentAt: new Date().toISOString(),
      });

      await waitForProcessing();

      events = await getEvents();
      const actionAsk = events.events.find((e: any) => 
        e.type === 'ask' && e.payload.askType === 'action_approval'
      );
      expect(actionAsk).toBeDefined();

      // Step 4: Answer action approval
      await sendCommand({
        kind: 'command',
        clientMsgId: 'hp-4',
        type: 'answer_ask',
        threadId,
        payload: {
          askId: actionAsk.payload.askId,
          askType: 'action_approval',
          choice: 'approve',
        },
        sentAt: new Date().toISOString(),
      });

      await waitForProcessing();

      events = await getEvents();
      const messageEvents = events.events.filter((e: any) => e.type === 'message');
      expect(messageEvents.length).toBeGreaterThan(0);
      
      // Should have decision message
      const hasDecision = messageEvents.some((e: any) => 
        e.payload.text && e.payload.text.includes('Decision')
      );
      expect(hasDecision).toBe(true);
    });
  });

  describe('approval_edit scenario', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'approval_edit';
    });

    it('should handle edited approval (+20% to +10%)', async () => {
      // Create goal triggers plan
      await sendCommand({
        kind: 'command',
        clientMsgId: 'ae-1',
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

      await waitForProcessing();

      let events = await getEvents();
      const planAsk = events.events.find((e: any) => e.type === 'ask');

      // Approve plan
      await sendCommand({
        kind: 'command',
        clientMsgId: 'ae-2',
        type: 'approve_plan',
        threadId,
        payload: {
          planId: planAsk.payload.askId,
          approved: true,
        },
        sentAt: new Date().toISOString(),
      });

      await waitForProcessing();

      events = await getEvents();
      const actionAsk = events.events.find((e: any) => 
        e.type === 'ask' && e.payload.askType === 'action_approval'
      );

      // Edit the approval
      await sendCommand({
        kind: 'command',
        clientMsgId: 'ae-3',
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

      await waitForProcessing();

      events = await getEvents();
      const replyEvents = events.events.filter((e: any) => e.type === 'message');
      expect(replyEvents.length).toBeGreaterThan(0);
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
        clientMsgId: 'cl-1',
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

      await waitForProcessing();

      let events = await getEvents();
      const firstAsk = events.events.find((e: any) => e.type === 'ask');
      expect(firstAsk.payload.askType).toBe('clarify');

      // Answer first clarify
      await sendCommand({
        kind: 'command',
        clientMsgId: 'cl-2',
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

      await waitForProcessing();

      events = await getEvents();
      const secondAsk = events.events.filter((e: any) => e.type === 'ask').pop();
      expect(secondAsk.payload.askType).toBe('clarify');

      // Answer second clarify - should end loop
      await sendCommand({
        kind: 'command',
        clientMsgId: 'cl-3',
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

      await waitForProcessing();

      events = await getEvents();
      
      // Should have plan now, not another clarify
      const finalEvents = events.events.slice(-3);
      const hasPlan = finalEvents.some((e: any) => 
        e.type === 'ask' && e.payload.askType === 'plan_approval'
      );
      const hasReply = finalEvents.some((e: any) => e.type === 'message');
      
      expect(hasPlan || hasReply).toBe(true);
    });
  });

  describe('control commands', () => {
    beforeAll(() => {
      process.env.MOCK_BRAIN_SCENARIO = 'happy_path';
    });

    it('should handle pause control bypassing brain', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: 'ctrl-1',
        type: 'control',
        threadId,
        payload: {
          action: 'pause',
        },
        sentAt: new Date().toISOString(),
      });

      await waitForProcessing();

      const events = await getEvents();
      const statusEvent = events.events.find((e: any) => e.type === 'status');
      expect(statusEvent).toBeDefined();
      expect(statusEvent.payload.state).toBe('pause');
    });

    it('should handle resume control', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: 'ctrl-2',
        type: 'control',
        threadId,
        payload: {
          action: 'resume',
        },
        sentAt: new Date().toISOString(),
      });

      await waitForProcessing();

      const events = await getEvents();
      const statusEvent = events.events.find((e: any) => e.type === 'status');
      expect(statusEvent).toBeDefined();
      expect(statusEvent.payload.state).toBe('resume');
    });

    it('should handle kill control', async () => {
      await sendCommand({
        kind: 'command',
        clientMsgId: 'ctrl-3',
        type: 'control',
        threadId,
        payload: {
          action: 'kill',
        },
        sentAt: new Date().toISOString(),
      });

      await waitForProcessing();

      const events = await getEvents();
      const statusEvent = events.events.find((e: any) => e.type === 'status');
      expect(statusEvent).toBeDefined();
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
        clientMsgId: 'mal-1',
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

      await waitForProcessing();

      const events = await getEvents();
      
      // Should have error event, not crash
      const errorEvent = events.events.find((e: any) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.payload.code).toBe('brain_error');
    });
  });
});
