import { randomUUID } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { pool } from './db/client.js';

interface WaitForOptions {
  timeout?: number;
  interval?: number;
}

/**
 * Poll GET /v1/events?after=N until `predicate` holds for the accumulated events.
 * Uses short polling intervals with a hard timeout instead of fixed sleeps.
 */
export async function waitForEvents(
  app: any,
  token: string,
  predicate: (events: any[]) => boolean,
  options: WaitForOptions = {}
): Promise<any[]> {
  const { timeout = 10000, interval = 25 } = options;
  const start = Date.now();

  let lastSeq = 0;
  let allEvents: any[] = [];

  while (Date.now() - start < timeout) {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/events?after=${lastSeq}`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    if (response.statusCode === 200) {
      const data = JSON.parse(response.body);
      if (data.events && data.events.length > 0) {
        allEvents = [...allEvents, ...data.events];
        lastSeq = data.nextSeq;
      }
      if (predicate(allEvents)) {
        return allEvents;
      }
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(`waitForEvents timeout after ${timeout}ms. Got ${allEvents.length} events: ${JSON.stringify(allEvents.map((e: any) => [e.seq, e.type]))}`);
}

/** Wait until a synchronous condition becomes true (short polling, hard timeout). */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 10, message = 'condition' }: WaitForOptions & { message?: string } = {}
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error(`waitUntil timeout after ${timeout}ms waiting for ${message}`);
}

export interface TestUser {
  token: string;
  userId: string;
  threadId: string;
}

/** Create a brand-new user (unique email) with one active thread. */
export async function createTestUser(app: FastifyInstance, label = 'test'): Promise<TestUser> {
  const response = await app.inject({
    method: 'POST',
    url: '/dev/login',
    payload: { email: `${label}-${randomUUID()}@example.com`, name: `${label} user` },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Login failed with status ${response.statusCode}: ${response.body}`);
  }
  const data = JSON.parse(response.body);
  const threadResult = await pool.query(
    'INSERT INTO threads (user_id, status) VALUES ($1, $2) RETURNING id',
    [data.user.id, 'active']
  );
  return { token: data.token, userId: data.user.id, threadId: threadResult.rows[0].id };
}

export function controlCommand(threadId: string, action: 'pause' | 'resume' | 'kill' = 'pause') {
  return {
    kind: 'command',
    clientMsgId: randomUUID(),
    type: 'control',
    threadId,
    payload: { action },
    sentAt: new Date().toISOString(),
  };
}

export function createGoalCommand(threadId: string, title = 'Test goal', clientMsgId: string = randomUUID()) {
  return {
    kind: 'command',
    clientMsgId,
    type: 'create_goal',
    threadId,
    payload: {
      title,
      description: 'Integration test goal',
      constraints: [],
      budget: { daily: 100, total: 1000, currency: 'USD' },
    },
    sentAt: new Date().toISOString(),
  };
}

export async function postCommand(app: FastifyInstance, token: string, command: unknown) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/commands',
    headers: { authorization: `Bearer ${token}` },
    payload: command as Record<string, unknown>,
  });
  return { statusCode: response.statusCode, body: JSON.parse(response.body) };
}

// ---------------------------------------------------------------------------
// SSE client: fetch + incremental text/event-stream parser + AbortController
// ---------------------------------------------------------------------------

export interface SSEMessage {
  id?: string;
  event?: string;
  data: string;
}

export interface SSEClient {
  status: number;
  headers: Headers;
  messages: SSEMessage[];
  comments: string[];
  /** Parsed JSON `data` of every message, in arrival order. */
  events: () => any[];
  /** Resolves once `predicate` holds over the received state; rejects on timeout or stream error. */
  waitFor: (predicate: (client: SSEClient) => boolean, timeoutMs?: number, label?: string) => Promise<void>;
  close: () => void;
  /** Resolves when the stream has ended (server closed or aborted). */
  closed: Promise<void>;
}

/** Minimal spec-compliant SSE parser (https://html.spec.whatwg.org/multipage/server-sent-events.html). */
export function createSSEParser(onMessage: (msg: SSEMessage) => void, onComment: (c: string) => void) {
  let buffer = '';
  let data: string[] = [];
  let id: string | undefined;
  let event: string | undefined;

  const dispatch = () => {
    if (data.length > 0) {
      onMessage({ id, event, data: data.join('\n') });
    }
    data = [];
    event = undefined;
    id = undefined;
  };

  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, idx);
      const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1;
      buffer = buffer.slice(idx + sepLen);

      if (line === '') {
        dispatch();
        continue;
      }
      if (line.startsWith(':')) {
        onComment(line.slice(1).trim());
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
      else if (field === 'event') event = value;
    }
  };
}

export async function openSSE(
  baseUrl: string,
  options: { token?: string; tokenInQuery?: boolean; lastEventId?: string | number } = {}
): Promise<SSEClient> {
  const controller = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.token && !options.tokenInQuery) headers.authorization = `Bearer ${options.token}`;
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
  const url = options.tokenInQuery && options.token
    ? `${baseUrl}/v1/events?token=${encodeURIComponent(options.token)}`
    : `${baseUrl}/v1/events`;

  const response = await fetch(url, { headers, signal: controller.signal });

  const waiters = new Set<() => void>();
  let streamError: unknown;
  const notify = () => waiters.forEach(w => w());

  const client: SSEClient = {
    status: response.status,
    headers: response.headers,
    messages: [],
    comments: [],
    events: () => client.messages.map(m => JSON.parse(m.data)),
    waitFor: (predicate, timeoutMs = 5000, label = 'SSE condition') =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (predicate(client)) {
            cleanup();
            resolve();
          } else if (streamError !== undefined) {
            cleanup();
            reject(new Error(`SSE stream failed while waiting for ${label}: ${String(streamError)}`));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(
            `Timed out after ${timeoutMs}ms waiting for ${label}. Got ids ${JSON.stringify(client.messages.map(m => m.id))}, ${client.comments.length} comments`
          ));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      }),
    close: () => controller.abort(),
    closed: Promise.resolve(),
  };

  if (!response.body) {
    return client;
  }

  const parse = createSSEParser(
    msg => {
      client.messages.push(msg);
      notify();
    },
    comment => {
      client.comments.push(comment);
      notify();
    }
  );

  client.closed = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        parse(decoder.decode(chunk, { stream: true }));
      }
      streamError = 'stream ended';
    } catch (err) {
      streamError = controller.signal.aborted ? 'aborted' : err;
    }
    notify();
  })();

  return client;
}

/** Received seqs (from the `id:` field), asserting they match the JSON payload. */
export function receivedSeqs(client: SSEClient): number[] {
  return client.messages.map(m => {
    const seq = Number(m.id);
    if (JSON.parse(m.data).seq !== seq) {
      throw new Error(`SSE id ${m.id} does not match payload seq ${JSON.parse(m.data).seq}`);
    }
    return seq;
  });
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
