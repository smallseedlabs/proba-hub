/**
 * Isolated PG contract tests for Hub research-review forwarding.
 *
 * FAKE gateway / FAKE research: no live provider, no paid model, no destination crawl.
 * GATEWAY_URL stays unset (default off). Pause/kill behaviour is unchanged.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RESEARCH_ACCEPT_VERB } from '@smallseedlabs/proba-protocol';
import { buildApp } from './app.js';
import { GatewayBrain } from './brain/gateway-brain.js';
import { PostgresGatewayRunStore } from './brain/postgres-gateway-run-store.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import {
  createTestUser,
  postCommand,
  waitForCommandStatus,
  waitForEvents,
  waitUntil,
  type TestUser,
} from './test-helpers.js';
import { FAKE_RESEARCH_GATEWAY_LABEL, FakeResearchGatewayClient } from './testing/fake-research-gateway.js';

const tokens = { kid: 'hub-gw-1', mint: async () => 'svc.jwt.token' };

function operatorUrl(label: string): string {
  return `https://operator-entered.example/${label}-${randomUUID()}`;
}

function webCreateGoal(title: string, landingPageUrl?: string, threadId?: string) {
  return {
    kind: 'command',
    clientMsgId: randomUUID(),
    type: 'create_goal',
    ...(threadId ? { threadId } : {}),
    payload: {
      title,
      budget: { daily: 50, currency: 'USD' },
      ...(landingPageUrl ? { userSuppliedInput: { landingPageUrl } } : {}),
    },
    sentAt: new Date().toISOString(),
  };
}

function webAnswer(
  ask: {
    payload: {
      askId: string;
      research?: { artifactId: string; version: number; inputRevision: string };
    };
    threadId: string;
  },
  choice: 'approve' | 'reject' | 'edit',
  extra?: { landingPageUrl?: string; version?: number }
) {
  const research = ask.payload.research;
  return {
    kind: 'command',
    clientMsgId: randomUUID(),
    type: 'answer_ask',
    threadId: ask.threadId,
    payload: {
      askId: ask.payload.askId,
      choice,
      ...(research
        ? {
            researchAcceptance: {
              artifactId: research.artifactId,
              version: extra?.version ?? research.version,
              inputRevision: research.inputRevision,
            },
          }
        : {}),
      ...(choice === 'edit' && extra?.landingPageUrl
        ? { userSuppliedInput: { landingPageUrl: extra.landingPageUrl } }
        : {}),
    },
    sentAt: new Date().toISOString(),
  };
}

describe('Hub research review (FAKE gateway, real Postgres)', () => {
  const fake = new FakeResearchGatewayClient();
  const store = new PostgresGatewayRunStore();
  let app: FastifyInstance;
  let user: TestUser;

  beforeAll(async () => {
    await runMigrations();
    const brain = new GatewayBrain({
      client: fake,
      serviceTokens: tokens,
      assertions: null,
      workspaceId: 'seedbed',
      tokenTtlSeconds: 120,
      store,
    });
    app = await buildApp({ brain, startBackgroundJobs: true });
    user = await createTestUser(app, 'research-review');
  });

  afterAll(async () => {
    await app.close();
  });

  it('Web-shaped create_goal persists operator URL, forwards original userSuppliedInput, and emits research_review from the FAKE artifact', async () => {
    expect(fake.label).toBe(FAKE_RESEARCH_GATEWAY_LABEL);
    const landing = operatorUrl('create');
    const body = webCreateGoal('Operator campaign', landing);
    const posted = await postCommand(app, user.token, body);
    expect(posted.statusCode).toBe(202);
    expect(posted.body.status).toBe('accepted');

    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.type === 'ask' && e.payload?.research?.landingPageUrl === landing)
    );
    const ask = events.find((e) => e.payload?.research?.landingPageUrl === landing);
    expect(ask.payload.askType).toBe('research_review');
    expect(ask.payload.research.verb).toBe(RESEARCH_ACCEPT_VERB);
    expect(ask.payload.research.findings[0].sourceIds.length).toBeGreaterThan(0);
    expect(ask.payload.research.sources[0].kind).toBe('http_url');
    expect(ask.payload.costEffect).toBeUndefined();
    expect(JSON.stringify(ask)).not.toMatch(/smallseedlabs\.com/);
    expect(ask.fallbackText).toMatch(/does not grant spend/i);

    const goal = await pool.query<{
      user_supplied_input: { landingPageUrl: string };
      input_revision: string | null;
      id: string;
    }>('SELECT id, user_supplied_input, input_revision FROM goals WHERE thread_id = $1', [ask.threadId]);
    expect(goal.rows[0].user_supplied_input).toEqual({ landingPageUrl: landing });
    expect(goal.rows[0].input_revision).toBe(ask.payload.research.inputRevision);

    const storedAsk = await pool.query<{ research: { artifactId: string } }>(
      'SELECT research FROM asks WHERE id = $1',
      [ask.payload.askId]
    );
    expect(storedAsk.rows[0].research.artifactId).toBe(ask.payload.research.artifactId);

    expect(fake.calls[0]?.userId).toBe(user.userId);
    expect(fake.calls[0]?.workspaceId).toBe('seedbed');
    expect(fake.calls[0]?.goalId).toBe(goal.rows[0].id);
    expect(fake.calls[0]?.threadId).toBe(ask.threadId);
    expect(fake.calls[0]?.userSuppliedInput).toEqual({ landingPageUrl: landing });
    expect(fake.calls[0]?.command).toMatchObject({ type: 'create_goal' });
  });

  it('replays the same create_goal clientMsgId without a second FAKE gather', async () => {
    const landing = operatorUrl('replay');
    const body = webCreateGoal('Replay campaign', landing, user.threadId);
    const before = fake.calls.length;
    const first = await postCommand(app, user.token, body);
    await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === landing)
    );
    const second = await postCommand(app, user.token, body);
    expect(first.body.status).toBe('accepted');
    expect(second.body.status).toBe('accepted');
    expect(fake.calls.length).toBe(before + 1);
  });

  it('stale researchAcceptance is not acceptance and never grants spend', async () => {
    const landing = operatorUrl('stale');
    const body = webCreateGoal('Stale revision', landing);
    await postCommand(app, user.token, body);
    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === landing)
    );
    const ask = events.find((e) => e.payload?.research?.landingPageUrl === landing);
    const before = fake.calls.length;
    const stale = webAnswer(ask, 'approve', { version: ask.payload.research.version + 1 });
    await postCommand(app, user.token, stale);
    await waitForCommandStatus(user.userId, stale.clientMsgId, 'processed');
    const after = await waitForEvents(app, user.token, (evs) =>
      evs.some(
        (e) =>
          e.type === 'error' &&
          e.threadId === ask.threadId &&
          e.payload?.code === 'research_acceptance_mismatch'
      )
    );
    expect(after.some((e) => e.threadId === ask.threadId && e.type === 'error')).toBe(true);
    const pending = await pool.query<{ status: string }>('SELECT status FROM asks WHERE id = $1', [ask.payload.askId]);
    expect(pending.rows[0].status).toBe('pending');
    expect(fake.calls.length).toBe(before);
  });

  it('wrong actor cannot resume another user research_review', async () => {
    const other = await createTestUser(app, 'research-wrong-actor');
    const landing = operatorUrl('actor');
    const body = webCreateGoal('Actor bound', landing);
    await postCommand(app, user.token, body);
    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === landing)
    );
    const ask = events.find((e) => e.payload?.research?.landingPageUrl === landing);
    const stolen = await postCommand(app, other.token, webAnswer(ask, 'approve'));
    expect(stolen.body.status).toBe('rejected');
    const pending = await pool.query<{ status: string }>('SELECT status FROM asks WHERE id = $1', [ask.payload.askId]);
    expect(pending.rows[0].status).toBe('pending');
  });

  it('edit invalidates and regathers via a new inputRevision; approve resumes the bound FAKE artifact', async () => {
    const landing = operatorUrl('edit');
    const next = operatorUrl('edit-next');
    const body = webCreateGoal('Edit then accept', landing);
    await postCommand(app, user.token, body);
    const firstEvents = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === landing)
    );
    const first = firstEvents.find((e) => e.payload?.research?.landingPageUrl === landing);
    const firstRevision = first.payload.research.inputRevision;

    await postCommand(app, user.token, webAnswer(first, 'edit', { landingPageUrl: next }));
    const edited = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === next)
    );
    const second = edited.find((e) => e.payload?.research?.landingPageUrl === next);
    expect(second.payload.askType).toBe('research_review');
    expect(second.payload.research.inputRevision).not.toBe(firstRevision);
    expect(second.payload.research.landingPageUrl).toBe(next);

    const goal = await pool.query<{ user_supplied_input: { landingPageUrl: string }; input_revision: string }>(
      'SELECT user_supplied_input, input_revision FROM goals WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1',
      [second.threadId]
    );
    expect(goal.rows[0].user_supplied_input.landingPageUrl).toBe(next);

    const firstAsk = await pool.query<{ status: string; answer: { choice: string } }>(
      'SELECT status, answer FROM asks WHERE id = $1',
      [first.payload.askId]
    );
    expect(firstAsk.rows[0].status).toBe('answered');
    expect(firstAsk.rows[0].answer.choice).toBe('edit');

    await postCommand(app, user.token, webAnswer(second, 'approve'));
    const approved = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.type === 'ask_resolved' && e.payload?.askId === second.payload.askId) &&
      evs.some((e) => e.type === 'message' && /accepted/i.test(e.payload?.text ?? ''))
    );
    expect(approved.some((e) => e.type === 'message' && /Spend policies still apply/i.test(e.payload?.text ?? ''))).toBe(
      true
    );
    const resume = fake.calls.filter((c) => c.resume?.choice === 'approve').at(-1);
    expect(resume?.userSuppliedInput?.landingPageUrl).toBe(next);
    expect(resume?.resume?.askId).toBe(second.payload.askId);
  });

  it('missing operator URL fails honestly (no invented research_review)', async () => {
    const title = `No URL ${randomUUID()}`;
    const body = webCreateGoal(title);
    const before = fake.calls.length;
    await postCommand(app, user.token, body);
    await waitUntil(async () => {
      const row = await pool.query(
        'SELECT 1 FROM commands WHERE user_id = $1 AND client_msg_id = $2',
        [user.userId, body.clientMsgId]
      );
      return row.rows.length > 0;
    });
    const thread = await pool.query<{ thread_id: string }>(
      'SELECT thread_id FROM commands WHERE user_id = $1 AND client_msg_id = $2',
      [user.userId, body.clientMsgId]
    );
    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.threadId === thread.rows[0].thread_id && e.type === 'error')
    );
    const threadEvents = events.filter((e) => e.threadId === thread.rows[0].thread_id);
    expect(threadEvents.some((e) => e.type === 'ask' && e.payload?.askType === 'research_review')).toBe(false);
    expect(threadEvents.some((e) => e.type === 'error')).toBe(true);
    expect(fake.calls.length).toBeGreaterThan(before);
    expect(fake.calls.at(-1)?.userSuppliedInput).toBeUndefined();
    expect(JSON.stringify(threadEvents)).not.toMatch(/smallseedlabs\.com/);
  });

  it('survives a process restart: a new GatewayBrain resumes the same Postgres-bound ask', async () => {
    const landing = operatorUrl('restart');
    const body = webCreateGoal('Restart bound', landing);
    await postCommand(app, user.token, body);
    const events = await waitForEvents(app, user.token, (evs) =>
      evs.some((e) => e.payload?.research?.landingPageUrl === landing)
    );
    const ask = events.find((e) => e.payload?.research?.landingPageUrl === landing);
    const restarted = new GatewayBrain({
      client: fake,
      serviceTokens: tokens,
      assertions: null,
      workspaceId: 'seedbed',
      tokenTtlSeconds: 120,
      store,
    });
    const before = fake.calls.length;
    const outputs = await restarted.process(
      {
        kind: 'command',
        type: 'answer_ask',
        clientMsgId: randomUUID(),
        threadId: ask.threadId,
        payload: {
          askId: ask.payload.askId,
          choice: 'reject',
          askType: 'research_review',
          researchAcceptance: {
            artifactId: ask.payload.research.artifactId,
            version: ask.payload.research.version,
            inputRevision: ask.payload.research.inputRevision,
          },
        },
        sentAt: new Date().toISOString(),
      },
      {
        userId: user.userId,
        threadId: ask.threadId,
        goals: [
          {
            id: String(fake.calls.find((c) => c.userSuppliedInput?.landingPageUrl === landing)?.goalId ?? randomUUID()),
            userId: user.userId,
            threadId: ask.threadId,
            title: 'Restart bound',
            status: 'active',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        client: {} as never,
      }
    );
    expect(fake.calls.length).toBe(before + 1);
    expect(fake.calls.at(-1)?.resume).toMatchObject({ askId: ask.payload.askId, choice: 'reject' });
    expect(fake.calls.at(-1)?.idempotencyKey).toBe(body.clientMsgId);
    expect(outputs[0]).toMatchObject({ type: 'reply' });
    expect(String((outputs[0] as { text?: string }).text)).toMatch(/unaccepted/);
  });
});
