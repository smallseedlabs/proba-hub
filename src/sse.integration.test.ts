import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { pool } from './db/client.js';
import { sseManager } from './services/sse-manager.js';
import { redisPub } from './services/redis.js';
import { EVENTS_CHANNEL } from './services/outbox-relay.js';
import {
  controlCommand,
  createTestUser,
  openSSE,
  postCommand,
  range,
  receivedSeqs,
  waitForEvents,
  waitUntil,
  type SSEClient,
  type TestUser,
} from './test-helpers.js';

const HEARTBEAT_MS = 50;

/**
 * SSE tests run against a real HTTP server (listen on port 0) with fetch,
 * an incremental SSE parser and AbortController. app.inject() cannot be used
 * for streaming responses because it buffers until the response ends.
 */
describe('SSE Integration Tests', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  const clients: SSEClient[] = [];

  async function connect(user: TestUser, opts: { lastEventId?: number; tokenInQuery?: boolean } = {}) {
    const client = await openSSE(baseUrl, { token: user.token, ...opts });
    clients.push(client);
    return client;
  }

  /** Send `count` control commands sequentially (each awaited to 202). */
  async function sendControls(user: TestUser, count: number) {
    for (let i = 0; i < count; i++) {
      const res = await postCommand(app, user.token, controlCommand(user.threadId));
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('accepted');
    }
  }

  /** Create `count` committed events for the user and wait until they are readable. */
  async function seedEvents(user: TestUser, count: number) {
    await sendControls(user, count);
    await waitForEvents(app, user.token, events => events.length >= count, { timeout: 5000 });
  }

  beforeAll(async () => {
    app = await buildApp({ startBackgroundJobs: true, sseHeartbeatIntervalMs: HEARTBEAT_MS });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('unexpected server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60000);

  afterAll(async () => {
    for (const c of clients) c.close();
    await Promise.all(clients.map(c => c.closed));
    await app.close();
  });

  describe('connection', () => {
    it('responds with SSE headers and an initial comment', async () => {
      const user = await createTestUser(app, 'sse-headers');
      const sse = await connect(user);

      expect(sse.status).toBe(200);
      expect(sse.headers.get('content-type')).toContain('text/event-stream');
      expect(sse.headers.get('cache-control')).toBe('no-cache');
      expect(sse.headers.get('connection')).toBe('keep-alive');

      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected comment');
      expect(sse.messages).toEqual([]);
    });

    it('accepts the token from the query string (EventSource cannot set headers)', async () => {
      const user = await createTestUser(app, 'sse-query-token');
      await seedEvents(user, 1);

      const sse = await connect(user, { tokenInQuery: true });
      expect(sse.status).toBe(200);
      await sse.waitFor(c => c.messages.length === 1, 3000, 'replayed event');
      expect(receivedSeqs(sse)).toEqual([1]);
    });

    it('rejects missing and invalid tokens with 401', async () => {
      const missing = await fetch(`${baseUrl}/v1/events`, { headers: { accept: 'text/event-stream' } });
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: 'missing_token' });

      const invalid = await fetch(`${baseUrl}/v1/events`, {
        headers: { accept: 'text/event-stream', authorization: 'Bearer not-a-jwt' },
      });
      expect(invalid.status).toBe(401);
      expect(await invalid.json()).toEqual({ error: 'invalid_token' });
    });

    it('rejects a non-numeric Last-Event-ID with 400', async () => {
      const user = await createTestUser(app, 'sse-bad-id');
      const res = await fetch(`${baseUrl}/v1/events`, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${user.token}`, 'last-event-id': 'abc' },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_last_event_id' });
    });
  });

  describe('live delivery', () => {
    it('delivers events published after connect, in order, in SSE wire format', async () => {
      const user = await createTestUser(app, 'sse-live');
      const sse = await connect(user);
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected comment');

      await sendControls(user, 3);
      await sse.waitFor(c => c.messages.length >= 3, 5000, '3 live events');

      expect(receivedSeqs(sse)).toEqual([1, 2, 3]);
      for (const msg of sse.messages) {
        expect(msg.event).toBe('status');
        const envelope = JSON.parse(msg.data);
        expect(envelope).toMatchObject({ kind: 'event', type: 'status', threadId: user.threadId });
        expect(envelope.payload).toEqual({ state: 'pause', executionState: 'paused', message: 'Execution pause' });
        expect(typeof envelope.at).toBe('string');
      }
    });

    it('delivers 20 concurrently produced events exactly once with no gaps', async () => {
      const user = await createTestUser(app, 'sse-live-burst');
      const sse = await connect(user);
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected comment');

      const results = await Promise.all(
        range(1, 20).map(() => postCommand(app, user.token, controlCommand(user.threadId)))
      );
      expect(results.every(r => r.statusCode === 202 && r.body.status === 'accepted')).toBe(true);

      await sse.waitFor(c => c.messages.length >= 20, 10000, '20 live events');
      expect(receivedSeqs(sse)).toEqual(range(1, 20));
    });

    it('fans out to every connection of the same user', async () => {
      const user = await createTestUser(app, 'sse-fanout');
      const a = await connect(user);
      const b = await connect(user);
      await a.waitFor(c => c.comments.includes('connected'), 2000, 'a connected');
      await b.waitFor(c => c.comments.includes('connected'), 2000, 'b connected');
      expect(sseManager.getConnectionCount(user.userId)).toBe(2);

      await sendControls(user, 2);
      await a.waitFor(c => c.messages.length >= 2, 5000, 'a events');
      await b.waitFor(c => c.messages.length >= 2, 5000, 'b events');
      expect(receivedSeqs(a)).toEqual([1, 2]);
      expect(receivedSeqs(b)).toEqual([1, 2]);
    });

    it('does not leak events across users', async () => {
      const alice = await createTestUser(app, 'sse-alice');
      const bob = await createTestUser(app, 'sse-bob');
      const aliceSse = await connect(alice);
      const bobSse = await connect(bob);
      await aliceSse.waitFor(c => c.comments.includes('connected'), 2000, 'alice connected');
      await bobSse.waitFor(c => c.comments.includes('connected'), 2000, 'bob connected');

      await sendControls(alice, 2);
      await sendControls(bob, 1);
      await aliceSse.waitFor(c => c.messages.length >= 2, 5000, 'alice events');
      await bobSse.waitFor(c => c.messages.length >= 1, 5000, 'bob events');

      expect(receivedSeqs(aliceSse)).toEqual([1, 2]);
      expect(receivedSeqs(bobSse)).toEqual([1]);
      expect(aliceSse.events().every(e => e.threadId === alice.threadId)).toBe(true);
      expect(bobSse.events().every(e => e.threadId === bob.threadId)).toBe(true);
    });
  });

  describe('replay via Last-Event-ID', () => {
    it('replays everything when no Last-Event-ID is sent', async () => {
      const user = await createTestUser(app, 'sse-replay-all');
      await seedEvents(user, 4);

      const sse = await connect(user);
      await sse.waitFor(c => c.messages.length >= 4, 3000, 'replay of 4');
      expect(receivedSeqs(sse)).toEqual([1, 2, 3, 4]);
    });

    it('replays only events after Last-Event-ID, then continues live with no duplicates or gaps', async () => {
      const user = await createTestUser(app, 'sse-resume');
      await seedEvents(user, 5);

      const sse = await connect(user, { lastEventId: 2 });
      await sse.waitFor(c => c.messages.length >= 3, 3000, 'replay 3..5');
      expect(receivedSeqs(sse)).toEqual([3, 4, 5]);

      await sendControls(user, 2);
      await sse.waitFor(c => c.messages.length >= 5, 5000, 'live 6..7');
      expect(receivedSeqs(sse)).toEqual([3, 4, 5, 6, 7]);
    });

    it('sends no replay when Last-Event-ID is current, only new events', async () => {
      const user = await createTestUser(app, 'sse-current');
      await seedEvents(user, 3);

      const sse = await connect(user, { lastEventId: 3 });
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected');

      await sendControls(user, 1);
      await sse.waitFor(c => c.messages.length >= 1, 5000, 'event 4');
      expect(receivedSeqs(sse)).toEqual([4]);
    });

    it('has no duplicates or gaps when events are produced while the replay is running', async () => {
      const user = await createTestUser(app, 'sse-race');
      await seedEvents(user, 5);

      // Fire 15 commands concurrently with opening the stream so that
      // publication interleaves with the replay query.
      const commands = Promise.all(
        range(1, 15).map(() => postCommand(app, user.token, controlCommand(user.threadId)))
      );
      const sse = await connect(user, { lastEventId: 2 });
      const results = await commands;
      expect(results.every(r => r.body.status === 'accepted')).toBe(true);

      await sse.waitFor(c => c.messages.length >= 18, 10000, 'events 3..20');
      expect(receivedSeqs(sse)).toEqual(range(3, 20));
    });

    it('drops duplicate re-publications (at-least-once relay) without breaking order', async () => {
      const user = await createTestUser(app, 'sse-dup');
      const sse = await connect(user);
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected');
      await sendControls(user, 3);
      await sse.waitFor(c => c.messages.length >= 3, 5000, 'events 1..3');

      // Re-publish already delivered events, as a relay retry would.
      for (const envelope of sse.events().slice(0, 2)) {
        await redisPub.publish(EVENTS_CHANNEL, JSON.stringify({ userId: user.userId, event: envelope }));
      }
      await sendControls(user, 1);
      await sse.waitFor(c => c.messages.length >= 4, 5000, 'event 4');
      expect(receivedSeqs(sse)).toEqual([1, 2, 3, 4]);
    });

    it('fills gaps from Postgres when a live event arrives out of order', async () => {
      const user = await createTestUser(app, 'sse-gap');
      const sse = await connect(user);
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected');

      // Commit seqs 1..3 without outbox rows (so the relay never publishes them),
      // then publish only seq 3: the connection must fetch 1 and 2 itself.
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO events (user_id, seq, type, thread_id, payload)
           VALUES ($1, get_next_event_seq($1), 'status', $2, $3)`,
          [user.userId, user.threadId, JSON.stringify({ state: 'pause', message: `direct ${i + 1}` })]
        );
      }
      const polled = await waitForEvents(app, user.token, evs => evs.length >= 3, { timeout: 2000 });
      await redisPub.publish(EVENTS_CHANNEL, JSON.stringify({ userId: user.userId, event: polled[2] }));

      await sse.waitFor(c => c.messages.length >= 3, 5000, 'gap-filled events');
      expect(receivedSeqs(sse)).toEqual([1, 2, 3]);
      expect(sse.events()).toEqual(polled);
    });

    it('resumes after a disconnect from the last received id without loss', async () => {
      const user = await createTestUser(app, 'sse-reconnect');
      const first = await connect(user);
      await first.waitFor(c => c.comments.includes('connected'), 2000, 'connected');
      await sendControls(user, 3);
      await first.waitFor(c => c.messages.length >= 3, 5000, 'first 3');
      const lastId = Number(first.messages[first.messages.length - 1].id);
      first.close();
      await first.closed;
      await waitUntil(() => sseManager.getConnectionCount(user.userId) === 0, { message: 'first stream cleanup' });

      // Produced while disconnected: seqs 4..8
      await sendControls(user, 5);
      await waitForEvents(app, user.token, events => events.length >= 8, { timeout: 5000 });

      const second = await connect(user, { lastEventId: lastId });
      await second.waitFor(c => c.messages.length >= 5, 3000, 'missed events');
      expect(receivedSeqs(first)).toEqual([1, 2, 3]);
      expect(receivedSeqs(second)).toEqual([4, 5, 6, 7, 8]);
    });

    it('matches the polling fallback event-for-event', async () => {
      const user = await createTestUser(app, 'sse-vs-poll');
      await seedEvents(user, 6);

      const poll = await app.inject({
        method: 'GET',
        url: '/v1/events?after=0',
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(poll.statusCode).toBe(200);
      const polled = JSON.parse(poll.body);
      expect(polled.events.map((e: any) => e.seq)).toEqual(range(1, 6));
      expect(polled.hasMore).toBe(false);
      expect(polled.nextSeq).toBe(6);

      const sse = await connect(user);
      await sse.waitFor(c => c.messages.length >= 6, 3000, 'replay of 6');
      expect(sse.events()).toEqual(polled.events);
    });
  });

  describe('heartbeat', () => {
    it('sends heartbeat comments at the configured interval', async () => {
      const user = await createTestUser(app, 'sse-heartbeat');
      const sse = await connect(user);
      const startedAt = Date.now();

      await sse.waitFor(c => c.comments.filter(x => x === 'heartbeat').length >= 3, 3000, '3 heartbeats');
      // 3 heartbeats cannot arrive faster than 3 intervals (minus timer jitter)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(HEARTBEAT_MS * 3 - 15);
      expect(sse.messages).toEqual([]);
    });
  });

  describe('listener cleanup', () => {
    it('removes the listener when the client aborts', async () => {
      const user = await createTestUser(app, 'sse-cleanup');
      const sse = await connect(user);
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected');
      expect(sseManager.getConnectionCount(user.userId)).toBe(1);

      sse.close();
      await sse.closed;
      await waitUntil(() => sseManager.getConnectionCount(user.userId) === 0, {
        timeout: 3000,
        message: 'listener removal after abort',
      });
      expect(sseManager.hasConnection(user.userId)).toBe(false);

      // Producing events for a user with no listeners must still work.
      await seedEvents(user, 1);
    });

    it('removes only the closed connection and keeps delivering to the others', async () => {
      const user = await createTestUser(app, 'sse-cleanup-multi');
      const a = await connect(user);
      const b = await connect(user);
      await a.waitFor(c => c.comments.includes('connected'), 2000, 'a connected');
      await b.waitFor(c => c.comments.includes('connected'), 2000, 'b connected');
      expect(sseManager.getConnectionCount(user.userId)).toBe(2);

      a.close();
      await a.closed;
      await waitUntil(() => sseManager.getConnectionCount(user.userId) === 1, {
        timeout: 3000,
        message: 'only one listener removed',
      });

      await sendControls(user, 2);
      await b.waitFor(c => c.messages.length >= 2, 5000, 'b still receives');
      expect(receivedSeqs(b)).toEqual([1, 2]);
      expect(a.messages).toEqual([]);
    });

    it('ends open streams and removes listeners when the app closes', async () => {
      const local = await buildApp({ startBackgroundJobs: true, sseHeartbeatIntervalMs: HEARTBEAT_MS });
      await local.listen({ port: 0, host: '127.0.0.1' });
      const address = local.server.address();
      if (!address || typeof address === 'string') throw new Error('unexpected server address');
      const user = await createTestUser(local, 'sse-app-close');

      const sse = await openSSE(`http://127.0.0.1:${address.port}`, { token: user.token });
      await sse.waitFor(c => c.comments.includes('connected'), 2000, 'connected');
      expect(sseManager.getConnectionCount(user.userId)).toBe(1);

      await local.close();
      await sse.closed;
      expect(sseManager.getConnectionCount(user.userId)).toBe(0);
    });
  });

  it('relay drains the outbox: every SSE test event ends up published', async () => {
    const unpublished = async () => {
      const r = await pool.query(
        `SELECT COUNT(*)::int AS count FROM outbox o JOIN users u ON u.id = o.user_id
         WHERE o.published = false AND u.email LIKE 'sse-%'`
      );
      return r.rows[0].count as number;
    };
    await waitUntil(async () => (await unpublished()) === 0, { timeout: 5000, message: 'outbox drained' });
    expect(await unpublished()).toBe(0);
  });
});
