import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp } from './app.js';
import { pool } from './db/client.js';
import { toJsonb } from './db/jsonb.js';

const app = await initializeApp({ startBackgroundJobs: true });

describe('SSE Integration Tests', () => {
  let token: string;
  let userId: string;
  let threadId: string;

  beforeAll(async () => {
    // Clean up any existing data
    await pool.query('TRUNCATE TABLE commands, events, asks, ask_questions, ask_answers, messages, goals, inbox_items, threads, sessions, users, outbox, event_sequences CASCADE');

    // Create user and get token via dev login
    const response = await app.inject({
      method: 'POST',
      url: '/dev/login',
      payload: {
        email: 'sse-test@example.com',
        name: 'SSE Test User',
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
    // Clean up between tests
    await pool.query('DELETE FROM commands WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM outbox WHERE user_id = $1', [userId]);
    await pool.query('UPDATE event_sequences SET next_seq = 1 WHERE user_id = $1', [userId]);
  });

  describe.skip('GET /v1/events (SSE)', () => {
    // SSE tests skipped: app.inject() doesn't properly handle streaming responses
    // and waits indefinitely for connection close. These would need a real HTTP client.
    it('should stream events with proper SSE format', async () => {
      // Create events via commands
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/commands',
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            kind: 'command',
            clientMsgId: `sse-test-${i}`,
            type: 'control',
            threadId,
            payload: {
              action: 'pause',
            },
            sentAt: new Date().toISOString(),
          },
        });
      }

      // Give time for async processing
      await new Promise(resolve => setTimeout(resolve, 200));

      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');

      const body = response.body;
      
      // Should have sent catchup events
      expect(body).toContain('id:');
      expect(body).toContain('data:');
    });

    it('should resume from Last-Event-ID', async () => {
      // Create 5 events via commands
      for (let i = 1; i <= 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/commands',
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            kind: 'command',
            clientMsgId: `resume-test-${i}`,
            type: 'control',
            threadId,
            payload: {
              action: 'pause',
            },
            sentAt: new Date().toISOString(),
          },
        });
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      // Request events after seq 3
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          'last-event-id': '3',
          accept: 'text/event-stream',
        },
      });

      expect(response.statusCode).toBe(200);
      
      const body = response.body;
      
      // Should have catchup events starting from seq 4
      expect(body).toContain('id:');
      expect(body).toContain('data:');
      
      // Parse events to verify sequence
      const lines = body.split('\n');
      const seqIds = lines.filter((l: string) => l.startsWith('id:')).map((l: string) => parseInt(l.substring(3)));
      expect(seqIds.length).toBeGreaterThan(0);
      if (seqIds.length > 0) {
        expect(Math.min(...seqIds)).toBeGreaterThan(3);
      }
    });

    it('should not send catchup if Last-Event-ID is current', async () => {
      // Create 3 events
      for (let i = 1; i <= 3; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/commands',
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            kind: 'command',
            clientMsgId: `current-test-${i}`,
            type: 'control',
            threadId,
            payload: {
              action: 'pause',
            },
            sentAt: new Date().toISOString(),
          },
        });
      }

      await new Promise(resolve => setTimeout(resolve, 200));

      // Get current max seq
      const maxSeqResult = await pool.query(
        'SELECT COALESCE(MAX(seq), 0) as max_seq FROM events WHERE user_id = $1',
        [userId]
      );
      const maxSeq = maxSeqResult.rows[0].max_seq;

      // Request with Last-Event-ID = maxSeq (current)
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          'last-event-id': String(maxSeq),
          accept: 'text/event-stream',
        },
      });

      expect(response.statusCode).toBe(200);
      
      const body = response.body;
      
      // Should not include catchup events for old data
      const lines = body.split('\n');
      const dataLines = lines.filter((l: string) => l.startsWith('data:'));
      // May have heartbeat but no old events
      expect(dataLines.length).toBeLessThanOrEqual(1);
    });

    it('should send heartbeats', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    });

    it('should accept token from query param', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/events?token=${token}`,
        headers: {
          accept: 'text/event-stream',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
    });
  });

  describe.skip('SSE and Polling consistency', () => {
    // Skipped: needs real HTTP client for SSE testing
    it('should return same events via SSE catchup and polling', async () => {
      // Create events via commands
      for (let i = 1; i <= 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/commands',
          headers: {
            authorization: `Bearer ${token}`,
          },
          payload: {
            kind: 'command',
            clientMsgId: `consistency-test-${i}`,
            type: 'control',
            threadId,
            payload: {
              action: 'pause',
            },
            sentAt: new Date().toISOString(),
          },
        });
      }

      await new Promise(resolve => setTimeout(resolve, 300));

      // Get via polling first
      const pollResponse = await app.inject({
        method: 'GET',
        url: '/v1/events?after=0',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(pollResponse.statusCode).toBe(200);
      const pollEvents = JSON.parse(pollResponse.body);
      expect(pollEvents.length).toBeGreaterThan(0);

      // Get via SSE
      const sseResponse = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
      });

      expect(sseResponse.statusCode).toBe(200);

      // SSE should contain all event sequences from polling
      for (const event of pollEvents) {
        expect(sseResponse.body).toContain(`id:${event.seq}`);
      }
    });
  });
});
