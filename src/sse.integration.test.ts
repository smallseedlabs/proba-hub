import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeApp } from './app.js';
import { pool } from './db/client.js';

const app = await initializeApp({ startBackgroundJobs: true });

describe('SSE Integration Tests', () => {
  let token: string;
  let userId: string;
  let threadId: string;

  beforeAll(async () => {
    // Clean up existing data
    await pool.query('TRUNCATE TABLE commands, events, asks, ask_questions, ask_answers, messages, goals, inbox_items, threads, sessions, users, outbox, event_sequences CASCADE');

    // Create user directly in database to avoid any app-layer complexity
    const userResult = await pool.query(
      'INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id',
      ['sse-test@example.com', 'SSE Test User']
    );
    userId = userResult.rows[0].id;

    // Use the auth endpoint to get a token for this user
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
    token = data.token;

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
    // Ensure user still exists (in case another test truncated)
    const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      await pool.query(
        'INSERT INTO users (id, email, name) VALUES ($1, $2, $3)',
        [userId, 'sse-test@example.com', 'SSE Test User']
      );
    }
    
    await pool.query('DELETE FROM commands WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM events WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM outbox WHERE user_id = $1', [userId]);
    await pool.query('UPDATE event_sequences SET next_seq = 1 WHERE user_id = $1', [userId]);
  });

  describe('GET /v1/events (SSE)', () => {
    it('should stream events with proper SSE format', async () => {
      // Create events through outbox so they're properly associated with user
      for (let i = 1; i <= 3; i++) {
        const eventResult = await pool.query(
          `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
           VALUES ($1, $2, 'status', $3, $4, NOW())
           RETURNING id`,
          [userId, i, threadId, JSON.stringify({ message: `Event ${i}` })]
        );
        await pool.query(
          'INSERT INTO outbox (user_id, event_id, published) VALUES ($1, $2, true)',
          [userId, eventResult.rows[0].id]
        );
      }

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
      expect(body).toContain('Event 1');
      expect(body).toContain('Event 2');
      expect(body).toContain('Event 3');
    });

    it('should resume from Last-Event-ID', async () => {
      // Create events 1-5
      for (let i = 1; i <= 5; i++) {
        const eventResult = await pool.query(
          `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
           VALUES ($1, $2, 'status', $3, $4, NOW())
           RETURNING id`,
          [userId, i, threadId, JSON.stringify({ message: `Event ${i}` })]
        );
        await pool.query(
          'INSERT INTO outbox (user_id, event_id, published) VALUES ($1, $2, true)',
          [userId, eventResult.rows[0].id]
        );
      }

      // Connect with Last-Event-ID = 2
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
          'last-event-id': '2',
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.body;
      
      // Should only have events 3, 4, 5
      expect(body).toContain('Event 3');
      expect(body).toContain('Event 4');
      expect(body).toContain('Event 5');
      
      // Should NOT have events 1 or 2
      expect(body).not.toContain('Event 1');
      expect(body).not.toContain('Event 2');
    });

    it('should not send catchup if Last-Event-ID is current', async () => {
      // Create event 1
      const eventResult = await pool.query(
        `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
         VALUES ($1, $2, 'status', $3, $4, NOW())
         RETURNING id`,
        [userId, 1, threadId, JSON.stringify({ message: 'Event 1' })]
      );
      await pool.query(
        'INSERT INTO outbox (user_id, event_id, published) VALUES ($1, $2, true)',
        [userId, eventResult.rows[0].id]
      );

      // Connect with Last-Event-ID = 1 (current)
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
          'last-event-id': '1',
        },
      });

      expect(response.statusCode).toBe(200);

      const body = response.body;
      
      // Should have :heartbeat or :ok but no data events
      const lines = body.split('\n').filter((l: string) => l.trim());
      const dataLines = lines.filter((l: string) => l.startsWith('data:') && l.includes('Event 1'));
      
      expect(dataLines.length).toBe(0);
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

      const body = response.body;
      
      // Should have heartbeat comment
      expect(body).toMatch(/:\s*heartbeat|:\s*ok/i);
    });

    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          accept: 'text/event-stream',
        },
      });

      expect(response.statusCode).toBe(401);
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
    });
  });

  describe('SSE and Polling consistency', () => {
    beforeEach(async () => {
      // Create test events
      for (let i = 1; i <= 5; i++) {
        const eventResult = await pool.query(
          `INSERT INTO events (user_id, seq, type, thread_id, payload, created_at)
           VALUES ($1, $2, 'message', $3, $4, NOW())
           RETURNING id`,
          [userId, i, threadId, JSON.stringify({ text: `Message ${i}` })]
        );
        await pool.query(
          'INSERT INTO outbox (user_id, event_id, published) VALUES ($1, $2, true)',
          [userId, eventResult.rows[0].id]
        );
      }
    });

    it('should return same events via SSE catchup and polling', async () => {
      // Get via polling
      const pollingResponse = await app.inject({
        method: 'GET',
        url: '/v1/events?after=0',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const pollingData = JSON.parse(pollingResponse.body);
      const pollingEvents = pollingData.events;

      // Get via SSE
      const sseResponse = await app.inject({
        method: 'GET',
        url: '/v1/events',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
        },
      });

      const sseBody = sseResponse.body;
      const sseEvents: any[] = [];
      
      // Parse SSE events
      const lines = sseBody.split('\n');
      let currentEvent: any = {};
      
      for (const line of lines) {
        if (line.startsWith('id:')) {
          currentEvent.seq = parseInt(line.substring(3).trim());
        } else if (line.startsWith('data:')) {
          try {
            currentEvent.data = JSON.parse(line.substring(5).trim());
            sseEvents.push({ ...currentEvent });
            currentEvent = {};
          } catch {
            // Skip unparseable data
          }
        }
      }

      // Should have same number of events
      expect(sseEvents.length).toBe(pollingEvents.length);
      
      // Verify sequences match
      for (let i = 0; i < pollingEvents.length; i++) {
        expect(sseEvents[i].seq).toBe(pollingEvents[i].seq);
        expect(sseEvents[i].data.type).toBe(pollingEvents[i].type);
      }
    });
  });
});
