import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import { buildApp } from './app.js';
import { MockBrain } from './brain/mock-brain.js';
import { CommandProcessor } from './services/command-processor.js';
import { pool } from './db/client.js';
import {
  controlCommand,
  createGoalCommand,
  createTestUser,
  postCommand,
  range,
  waitForCommandStatus,
  waitForEvents,
} from './test-helpers.js';

const app = await buildApp({ startBackgroundJobs: true });

describe('API Integration Tests', () => {
  let token: string;
  let userId: string;
  let threadId: string;

  beforeAll(async () => {
    // Clean up existing data
    await pool.query('TRUNCATE TABLE commands, events, asks, ask_questions, ask_answers, messages, goals, inbox_items, threads, sessions, users, outbox, event_sequences CASCADE');

    // Create test user and get token
    const response = await app.inject({
      method: 'POST',
      url: '/dev/login',
      payload: {
        email: 'integration-test@example.com',
        name: 'Integration Test User',
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

    // Create a thread
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
    // Clean up commands and events between tests
    await pool.query('DELETE FROM commands WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM outbox WHERE user_id = $1', [userId]);
    await pool.query('UPDATE event_sequences SET next_seq = 1 WHERE user_id = $1', [userId]);
  });

  describe('POST /v1/commands', () => {
    it('should return 202 Accepted for valid command', async () => {
      const clientMsgId = '11111111-1111-1111-1111-111111111111';

      const response = await app.inject({
        method: 'POST',
        url: '/v1/commands',
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          kind: 'command',
          clientMsgId,
          type: 'send_message',
          threadId,
          payload: {
            text: 'Test message',
          },
          sentAt: new Date().toISOString(),
        },
      });

      expect(response.statusCode).toBe(202);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('accepted');
      expect(data.clientMsgId).toBe(clientMsgId);
    });

    it('should be idempotent on (userId, clientMsgId)', async () => {
      const clientMsgId = '22222222-2222-2222-2222-222222222222';
      const command = {
        kind: 'command',
        clientMsgId,
        type: 'send_message',
        threadId,
        payload: {
          text: 'Test message',
        },
        sentAt: new Date().toISOString(),
      };

      // First request
      const response1 = await app.inject({
        method: 'POST',
        url: '/v1/commands',
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: command,
      });

      expect(response1.statusCode).toBe(202);

      // Wait for this specific command row to be committed and processed.
      // (Waiting for "any event" raced: earlier tests already produced events.)
      await waitForCommandStatus(userId, clientMsgId, 'processed');

      // Second request with same clientMsgId should be idempotent
      const response2 = await app.inject({
        method: 'POST',
        url: '/v1/commands',
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: command,
      });

      expect(response2.statusCode).toBe(202);
      expect(JSON.parse(response2.body).status).toBe('accepted');

      // The duplicate is processed asynchronously as a no-op; the row stays processed.
      await waitForCommandStatus(userId, clientMsgId, 'processed');

      // Should only have one command record
      const commandCount = await pool.query(
        'SELECT COUNT(*) FROM commands WHERE user_id = $1 AND client_msg_id = $2',
        [userId, clientMsgId]
      );
      expect(parseInt(commandCount.rows[0].count)).toBe(1);
    });

    it('should reject command with invalid payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/commands',
        headers: {
          authorization: `Bearer ${token}`,
        },
        payload: {
          kind: 'command',
          type: 'invalid_type',
          payload: {},
        },
      });

      expect(response.statusCode).toBe(202);
      const data = JSON.parse(response.body);
      expect(data.status).toBe('rejected');
      expect(data.reason).toBe('validation_error');
    });

    it('should reject a valid envelope whose payload does not match its command type', async () => {
      const clientMsgId = randomUUID();
      const res = await postCommand(app, token, {
        kind: 'command',
        clientMsgId,
        type: 'create_goal',
        threadId,
        payload: { request: 'missing title' },
        sentAt: new Date().toISOString(),
      });

      expect(res.statusCode).toBe(202);
      expect(res.body).toEqual({ status: 'rejected', clientMsgId, reason: 'validation_error' });
      const stored = await pool.query('SELECT 1 FROM commands WHERE user_id = $1 AND client_msg_id = $2', [userId, clientMsgId]);
      expect(stored.rows).toHaveLength(0);
    });

    it('should reject a command for a thread owned by another user', async () => {
      const other = await createTestUser(app, 'other-owner');
      const res = await postCommand(app, token, controlCommand(other.threadId));
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('rejected');
      expect(res.body.reason).toBe('thread_not_found');
    });
  });

  describe('Event Sequence Integrity (concurrency)', () => {
    const N = 20;
    let concurrencyApp: FastifyInstance;

    beforeAll(async () => {
      // Scenario injected via config, not by mutating process.env
      concurrencyApp = await buildApp({ startBackgroundJobs: true, brainScenario: 'happy_path' });
    });

    afterAll(async () => {
      await concurrencyApp.close();
    });

    async function seqsFor(uid: string): Promise<number[]> {
      const r = await pool.query<{ seq: number }>(
        'SELECT seq FROM events WHERE user_id = $1 ORDER BY seq ASC',
        [uid]
      );
      return r.rows.map(row => row.seq);
    }

    it(`assigns seqs exactly 1..${N} for ${N} parallel commands`, async () => {
      const user = await createTestUser(concurrencyApp, 'concurrency');

      const responses = await Promise.all(
        range(1, N).map(i => postCommand(concurrencyApp, user.token, createGoalCommand(user.threadId, `Goal ${i}`)))
      );
      for (const res of responses) {
        expect(res.statusCode).toBe(202);
        expect(res.body.status).toBe('accepted');
      }

      // happy_path: the first create_goal yields a clarify ask, every later one a
      // reply message, and each also emits goal_updated -> two events per command.
      const total = 2 * N;
      const events = await waitForEvents(concurrencyApp, user.token, evs => evs.length >= total, { timeout: 10000 });
      expect(events.map(e => e.seq)).toEqual(range(1, total));
      expect(await seqsFor(user.userId)).toEqual(range(1, total));
      expect(events.filter(e => e.type === 'ask')).toHaveLength(1);
      expect(events.filter(e => e.type === 'message')).toHaveLength(N - 1);
      expect(events.filter(e => e.type === 'goal_updated')).toHaveLength(N);

      const commands = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM commands WHERE user_id = $1 GROUP BY status`,
        [user.userId]
      );
      expect(commands.rows).toEqual([{ status: 'processed', count: N }]);

      const sequence = await pool.query('SELECT next_seq FROM event_sequences WHERE user_id = $1', [user.userId]);
      expect(sequence.rows[0].next_seq).toBe(total + 1);
    });

    it(`stays gap-free for ${N} parallel commands of mixed types`, async () => {
      const user = await createTestUser(concurrencyApp, 'concurrency-mixed');

      const responses = await Promise.all(
        range(1, N).map(i =>
          postCommand(
            concurrencyApp,
            user.token,
            i % 2 === 0 ? controlCommand(user.threadId, 'resume') : createGoalCommand(user.threadId, `Goal ${i}`)
          )
        )
      );
      expect(responses.every(r => r.statusCode === 202 && r.body.status === 'accepted')).toBe(true);

      // control (resume: it never gates the create_goal commands racing it) -> 1 status event; create_goal -> brain output + goal_updated.
      const total = N / 2 + 2 * (N / 2);
      const events = await waitForEvents(concurrencyApp, user.token, evs => evs.length >= total, { timeout: 10000 });
      expect(events.map(e => e.seq)).toEqual(range(1, total));
      expect(events.filter(e => e.type === 'status')).toHaveLength(N / 2);
      expect(events.filter(e => e.type === 'goal_updated')).toHaveLength(N / 2);
      expect(await seqsFor(user.userId)).toEqual(range(1, total));
    });

    it(`processes the same clientMsgId sent ${N} times in parallel exactly once`, async () => {
      const user = await createTestUser(concurrencyApp, 'concurrency-idem');
      const clientMsgId = randomUUID();
      const envelope = createGoalCommand(user.threadId, 'Same goal', clientMsgId) as unknown as CommandEnvelope;

      // Drive the processor directly so we can await every duplicate to completion.
      const processor = new CommandProcessor(new MockBrain('happy_path'));
      const results = await Promise.all(range(1, N).map(() => processor.processCommand(user.userId, envelope)));

      const commandIds = new Set(results.map(r => r.command.id));
      expect(commandIds.size).toBe(1);

      const commandRows = await pool.query(
        'SELECT status, COUNT(*)::int AS count FROM commands WHERE user_id = $1 AND client_msg_id = $2 GROUP BY status',
        [user.userId, clientMsgId]
      );
      expect(commandRows.rows).toEqual([{ status: 'processed', count: 1 }]);
      expect(await seqsFor(user.userId)).toEqual([1, 2]); // clarify ask + goal_updated
      const goals = await pool.query('SELECT COUNT(*)::int AS count FROM goals WHERE user_id = $1', [user.userId]);
      expect(goals.rows[0].count).toBe(1);

      // And over HTTP, duplicates are acknowledged with the same clientMsgId.
      const responses = await Promise.all(range(1, 5).map(() => postCommand(concurrencyApp, user.token, envelope)));
      expect(responses.every(r => r.statusCode === 202 && r.body.status === 'accepted' && r.body.clientMsgId === clientMsgId)).toBe(true);
    });
  });

  describe('GET /v1/events (Polling)', () => {
    beforeEach(async () => {
      // Create some test events
      for (let i = 1; i <= 5; i++) {
        await pool.query(
          `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
           VALUES ($1, $2, 'status', $3, $4, NOW())`,
          [userId, i, threadId, JSON.stringify({ message: `Event ${i}` })]
        );
      }
    });

    it('should return events after given sequence', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events?after=2',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      
      expect(data.events).toBeDefined();
      expect(data.events.length).toBe(3); // Events 3, 4, 5
      expect(data.events[0].seq).toBe(3);
      expect(data.events[2].seq).toBe(5);
      expect(data.nextSeq).toBe(5);
      expect(data.hasMore).toBe(false);
    });

    it('should reject a non-numeric after parameter with 400', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events?after=abc',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({ error: 'invalid_after' });
    });

    it('should return empty array if no new events', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events?after=10',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      
      expect(data.events).toEqual([]);
      expect(data.hasMore).toBe(false);
    });
  });
});
