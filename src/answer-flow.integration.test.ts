import { describe, it, expect, beforeAll, afterAll, beforeEach, onTestFinished } from 'vitest';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { randomUUID } from 'crypto';
import { waitForEvents } from './test-helpers.js';

// Scenario injected via config (not process.env)
const app = await buildApp({ startBackgroundJobs: true, brainScenario: 'happy_path' });

describe('Answer Flow Integration Test', () => {
  let token: string;
  let userId: string;
  let threadId: string;

  beforeAll(async () => {
    await pool.query('TRUNCATE TABLE commands, events, asks, ask_questions, ask_answers, messages, goals, inbox_items, threads, sessions, users, outbox, event_sequences CASCADE');

    const response = await app.inject({
      method: 'POST',
      url: '/dev/login',
      payload: {
        email: 'answer-flow-test@example.com',
        name: 'Answer Flow Test User',
      },
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
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

  it('should handle full answer flow: send message → get ask → answer ask → get ask_resolved → continue scenario', async () => {
    // Step 1: Send create_goal command
    const createGoalResponse = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'create_goal',
        threadId,
        payload: {
          title: 'Test Campaign',
          description: 'Integration test',
          constraints: ['family-friendly'],
          budget: { daily: 100, total: 1000, currency: 'USD' },
        },
        sentAt: new Date().toISOString(),
      },
    });

    expect(createGoalResponse.statusCode).toBe(202);

    // Step 2: Wait for ask event
    const events1 = await waitForEvents(
      app,
      token,
      events => events.some(e => e.type === 'ask'),
      { timeout: 5000, interval: 50 }
    );

    const askEvent = events1.find(e => e.type === 'ask');
    expect(askEvent, 'Should have ask event').toBeDefined();
    expect(askEvent.payload.askType).toBe('clarify');
    expect(askEvent.payload.askId).toBeDefined();
    expect(askEvent.payload.questions).toBeDefined();
    expect(Array.isArray(askEvent.payload.questions)).toBe(true);

    const askId = askEvent.payload.askId;
    const step1MaxSeq = askEvent.seq;

    // Verify ask was stored in database
    const askRow = await pool.query(
      'SELECT id, thread_id, ask_type, status FROM asks WHERE id = $1',
      [askId]
    );
    expect(askRow.rows.length).toBe(1);
    expect(askRow.rows[0].status).toBe('pending');
    expect(askRow.rows[0].ask_type).toBe('clarify');

    // Step 3: Answer the ask
    const answerResponse = await app.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        kind: 'command',
        clientMsgId: randomUUID(),
        type: 'answer_ask',
        threadId,
        payload: {
          askId,
          askType: 'clarify',
          choice: 'approve',
          values: { audience: 'active' },
        },
        sentAt: new Date().toISOString(),
      },
    });

    expect(answerResponse.statusCode).toBe(202);

    // Step 4: Wait for ask_resolved event AND next ask (plan_approval)
    const events2 = await waitForEvents(
      app,
      token,
      events => {
        const newEvents = events.filter(e => e.seq > step1MaxSeq);
        const hasResolved = newEvents.some(e => e.type === 'ask_resolved');
        const hasNextAsk = newEvents.some(e => e.type === 'ask' && e.payload.askType === 'plan_approval');
        return hasResolved && hasNextAsk;
      },
      { timeout: 5000, interval: 50 }
    );

    const newEvents = events2.filter(e => e.seq > step1MaxSeq);
    
    // Verify ask_resolved event
    const resolvedEvent = newEvents.find(e => e.type === 'ask_resolved');
    expect(resolvedEvent, 'Should have ask_resolved event').toBeDefined();
    expect(resolvedEvent.payload.askId).toBe(askId);

    // Verify ask status updated in database
    const updatedAskRow = await pool.query(
      'SELECT id, status, answered_at, answer FROM asks WHERE id = $1',
      [askId]
    );
    expect(updatedAskRow.rows.length).toBe(1);
    expect(updatedAskRow.rows[0].status).toBe('answered');
    expect(updatedAskRow.rows[0].answered_at).toBeDefined();
    expect(updatedAskRow.rows[0].answer).toBeDefined();

    // Verify brain was invoked again with answer and scenario advanced
    const planAsk = newEvents.find(e => e.type === 'ask' && e.payload.askType === 'plan_approval');
    expect(planAsk, 'Should have plan_approval ask (scenario advanced)').toBeDefined();
    expect(planAsk.payload.askId).not.toBe(askId);
    expect(planAsk.seq).toBeGreaterThan(resolvedEvent.seq);

    // Note: The answer is stored as JSON in asks.answer column
  });

  it('should surface errors as error events', async () => {
    // Use malformed_output scenario via an app with that scenario injected
    const malformedApp = await buildApp({ startBackgroundJobs: true, brainScenario: 'malformed_output' });
    onTestFinished(() => malformedApp.close());

    const response = await malformedApp.inject({
      method: 'POST',
      url: '/v1/commands',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
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
      },
    });

    expect(response.statusCode).toBe(202);

    const events = await waitForEvents(
      app,
      token,
      events => events.some(e => e.type === 'error'),
      { timeout: 5000, interval: 50 }
    );

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent, 'Should have error event').toBeDefined();
    expect(errorEvent.payload.code).toBe('brain_error');
  });
});
