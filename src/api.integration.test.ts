import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp } from './app.js';
import { pool } from './db/client.js';
import { waitForEvents } from './test-helpers.js';

const app = await initializeApp({ startBackgroundJobs: true });

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

      // Wait for at least one event
      await waitForEvents(app, token, events => events.length > 0, { timeout: 5000 });

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
  });

  describe('Event Sequence Integrity', () => {
    it('should maintain gap-free sequences under concurrent commands', async () => {
      const commandPromises = [];
      const numCommands = 10;

      for (let i = 0; i < numCommands; i++) {
        commandPromises.push(
          app.inject({
            method: 'POST',
            url: '/v1/commands',
            headers: {
              authorization: `Bearer ${token}`,
            },
            payload: {
              kind: 'command',
              clientMsgId: `concurrent-${i}-${Date.now()}`,
              type: 'control',
              threadId,
              payload: {
                action: 'pause',
              },
              sentAt: new Date().toISOString(),
            },
          })
        );
      }

      await Promise.all(commandPromises);

      // Wait for at least numCommands events
      await waitForEvents(app, token, events => events.length >= numCommands, { timeout: 10000 });

      // Check that sequences are gap-free
      const events = await pool.query(
        'SELECT seq FROM events WHERE user_id = $1 ORDER BY seq ASC',
        [userId]
      );

      const sequences = events.rows.map(r => r.seq);
      
      // Verify no gaps
      for (let i = 0; i < sequences.length - 1; i++) {
        expect(sequences[i + 1] - sequences[i]).toBe(1);
      }

      // Verify starts at 1
      expect(sequences[0]).toBe(1);
      
      // Should have at least numCommands events (one per command minimum)
      expect(sequences.length).toBeGreaterThanOrEqual(numCommands);
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
