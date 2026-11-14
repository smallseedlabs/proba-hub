import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope } from '@smallseedlabs/proba-protocol';
import { newTraceContext, runWithTrace } from '../audit/trace.js';
import type { BrainContext } from '../types.js';
import { GatewayBrain } from './gateway-brain.js';
import { GatewayClientError, type GatewayClient, type GatewayRunRequest, type GatewayRunSnapshot } from './gateway-client.js';
import { MemoryGatewayRunStore } from './gateway-run-store.js';
import { shouldAttachHubContext, controlAbortReason } from './gateway-wiring.js';
import { FAKE_RESEARCH_GATEWAY_LABEL, FakeResearchGatewayClient } from '../testing/fake-research-gateway.js';
import { RESEARCH_ACCEPT_VERB } from '@smallseedlabs/proba-protocol';

const userId = '660e8400-e29b-41d4-a716-446655440001';
const otherUser = '661e8400-e29b-41d4-a716-446655440099';
const goalId = '770e8400-e29b-41d4-a716-446655440002';
const otherGoal = '771e8400-e29b-41d4-a716-446655440082';
const threadId = '880e8400-e29b-41d4-a716-446655440003';
const otherThread = '881e8400-e29b-41d4-a716-446655440083';
const askId = '990e8400-e29b-41d4-a716-446655440004';
const otherAsk = '991e8400-e29b-41d4-a716-446655440005';

function command(
  type: CommandEnvelope['type'],
  payload: Record<string, unknown>,
  id = randomUUID(),
  thread = threadId
): CommandEnvelope {
  return {
    kind: 'command',
    type,
    clientMsgId: id,
    threadId: thread,
    payload,
    sentAt: new Date().toISOString(),
  } as CommandEnvelope;
}

function context(overrides: Partial<BrainContext> = {}): BrainContext {
  const tid = overrides.threadId ?? threadId;
  const gid = overrides.goals?.[overrides.goals.length - 1]?.id ?? goalId;
  return {
    userId,
    threadId: tid,
    goals: [
      {
        id: gid,
        userId,
        threadId: tid,
        title: 'g',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    client: {} as never,
    ...overrides,
  };
}

function fakeClient(
  handler: (req: GatewayRunRequest) => GatewayRunSnapshot | Promise<GatewayRunSnapshot>
): GatewayClient & { calls: GatewayRunRequest[]; tokens: string[]; cancels: string[]; cancelled: string[] } {
  const calls: GatewayRunRequest[] = [];
  const tokens: string[] = [];
  const cancels: string[] = [];
  const cancelled: string[] = [];
  return {
    calls,
    tokens,
    cancels,
    cancelled,
    async createRun(request, token) {
      calls.push(request);
      tokens.push(token);
      return handler(request);
    },
    async getRun(runId) {
      return { runId, status: 'completed', iteration: 0 };
    },
    async cancelRun(runId, reason, token) {
      cancels.push(reason);
      cancelled.push(runId);
      tokens.push(token);
      return { runId, status: reason === 'emergency_stop' ? 'stopped' : 'paused', iteration: 0 };
    },
  };
}

const tokens = { kid: 'hub-gw-1', mint: vi.fn(async () => 'svc.jwt.token') };
const assertions = {
  kid: 'hub-key-1',
  mint: vi.fn(async () => ({ token: 'actas.jwt.token', claims: {} as never })),
};

function makeBrain(
  client: GatewayClient,
  extra: { store?: MemoryGatewayRunStore; audit?: { emit: ReturnType<typeof vi.fn> } } = {}
) {
  return new GatewayBrain({
    client,
    serviceTokens: tokens,
    assertions,
    workspaceId: 'seedbed',
    tokenTtlSeconds: 120,
    store: extra.store ?? new MemoryGatewayRunStore(),
    audit: extra.audit,
  });
}

function awaiting(runId: string, boundAsk: string, verb = 'pause_campaign'): GatewayRunSnapshot {
  return {
    runId,
    status: 'awaiting_approval',
    iteration: 1,
    outputs: [{ type: 'tool_call', tool: verb, parameters: {}, needsApproval: true, risk: 'medium' }],
    needs: [{ type: 'approval', askId: boundAsk, verb, argsHash: 'x', workspaceId: 'seedbed' }],
  };
}

describe('GatewayBrain', () => {
  it('owns external context so Hub must not also call the bridge or DeepSeek', () => {
    const brain = makeBrain(fakeClient(() => ({ runId: randomUUID(), status: 'completed', iteration: 0 })));
    expect(brain.ownsExternalContext).toBe(true);
    expect(shouldAttachHubContext(true, brain)).toBe(false);
    expect(shouldAttachHubContext(true, { process: async () => [] })).toBe(true);
  });

  it('posts a tenant-scoped run using Hub workspace/user, never a spoofed workspace', async () => {
    const client = fakeClient(() => ({
      runId: randomUUID(),
      status: 'completed',
      iteration: 1,
      outputs: [{ type: 'reply', text: 'pong' }],
    }));
    const brain = makeBrain(client);
    const traceId = '220e8400-e29b-41d4-a716-446655440020';
    const outputs = await runWithTrace(newTraceContext(traceId), () =>
      brain.process(command('send_message', { text: 'hi', workspaceId: 'other-ws' }), context())
    );
    expect(outputs).toEqual([{ type: 'reply', text: 'pong' }]);
    expect(client.calls[0]?.workspaceId).toBe('seedbed');
    expect(client.calls[0]?.userId).toBe(userId);
    expect(client.calls[0]?.traceId).toBe(traceId);
    expect(client.calls[0]?.actAsAssertion).toBe('actas.jwt.token');
    expect(JSON.stringify(client.calls[0])).not.toContain('other-ws');
  });

  it('reuses the original run + resume on exact action approval after a process restart', async () => {
    const firstId = randomUUID();
    const store = new MemoryGatewayRunStore();
    const client = fakeClient((req) => {
      if (req.resume) {
        if (req.resume.askId !== askId) throw new GatewayClientError('approval_mismatch', 'askId does not match bound operation');
        return { runId: firstId, status: 'completed', iteration: 2, outputs: [{ type: 'reply', text: 'approved' }] };
      }
      return awaiting(firstId, askId);
    });
    const original = command('send_message', { text: 'pause it' });
    await makeBrain(client, { store }).process(original, context());
    const resumed = await makeBrain(client, { store }).process(
      command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }),
      context()
    );
    expect(client.calls[1]?.idempotencyKey).toBe(client.calls[0]?.idempotencyKey);
    expect(client.calls[1]?.command).toEqual(client.calls[0]?.command);
    expect(client.calls[1]?.resume).toMatchObject({ askId, choice: 'approve' });
    expect(client.calls[1]?.actAsAssertion).toBe('actas.jwt.token');
    expect(JSON.stringify(client.calls[1]?.command)).not.toContain('actas.jwt.token');
    expect(resumed[0]).toMatchObject({ type: 'reply', text: 'approved' });
  });

  it('rejects a stale ask, a wrong-thread ask, and forwards reject on the bound run', async () => {
    const firstId = randomUUID();
    const audit = { emit: vi.fn(async () => null) };
    const client = fakeClient((req) => {
      if (req.resume?.choice === 'reject') {
        return { runId: firstId, status: 'completed', iteration: 2, outputs: [{ type: 'reply', text: 'rejected' }] };
      }
      return awaiting(firstId, askId);
    });
    const store = new MemoryGatewayRunStore();
    const brain = makeBrain(client, { store, audit });
    await brain.process(command('send_message', { text: 'pause it' }), context());

    await expect(
      brain.process(command('answer_ask', { askId: randomUUID(), choice: 'approve', askType: 'action_approval' }), context())
    ).rejects.toMatchObject({ code: 'approval_expired' });
    expect(client.calls).toHaveLength(1);
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approval.expired', errorCode: 'approval_expired' }),
      expect.objectContaining({ bestEffort: true })
    );

    await expect(
      brain.process(
        command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }, randomUUID(), otherThread),
        context({ threadId: otherThread, goals: [{ id: otherGoal, userId, threadId: otherThread, title: 'o', status: 'active', createdAt: new Date(), updatedAt: new Date() }] })
      )
    ).rejects.toMatchObject({ code: 'approval_mismatch' });
    expect(client.calls).toHaveLength(1);

    const empty = makeBrain(fakeClient(() => ({ runId: randomUUID(), status: 'completed', iteration: 0 })), { audit });
    await expect(
      empty.process(command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }), context())
    ).rejects.toMatchObject({ code: 'approval_expired' });

    const rejected = await brain.process(
      command('answer_ask', { askId, choice: 'reject', askType: 'action_approval' }),
      context()
    );
    expect(client.calls.at(-1)?.resume).toMatchObject({ askId, choice: 'reject' });
    expect(client.calls.at(-1)?.command).toEqual(client.calls[0]?.command);
    expect(rejected[0]).toMatchObject({ type: 'reply', text: 'rejected' });
  });

  it('does not resume another user or another pending run', async () => {
    const store = new MemoryGatewayRunStore();
    const client = fakeClient((req) => {
      const bound = req.command && typeof req.command === 'object' && 'payload' in req.command
        ? String((req.command as { payload?: { text?: string } }).payload?.text ?? '')
        : '';
      const id = bound.includes('second') ? otherAsk : askId;
      if (req.resume) {
        return { runId: randomUUID(), status: 'completed', iteration: 2, outputs: [{ type: 'reply', text: `resumed:${req.resume.askId}` }] };
      }
      return awaiting(randomUUID(), id, bound.includes('second') ? 'launch' : 'pause_campaign');
    });
    const brain = makeBrain(client, { store });
    await brain.process(command('send_message', { text: 'first' }), context());
    await brain.process(
      command('send_message', { text: 'second' }, randomUUID(), otherThread),
      context({
        threadId: otherThread,
        goals: [{ id: otherGoal, userId, threadId: otherThread, title: 'o', status: 'active', createdAt: new Date(), updatedAt: new Date() }],
      })
    );
    expect(client.calls).toHaveLength(2);

    const other = makeBrain(client, { store });
    await expect(
      other.process(command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }), {
        ...context(),
        userId: otherUser,
      })
    ).rejects.toMatchObject({ code: 'approval_expired' });
    expect(client.calls).toHaveLength(2);

    const resumed = await brain.process(
      command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }),
      context()
    );
    expect(client.calls[2]?.resume?.askId).toBe(askId);
    expect(client.calls[2]?.command).toEqual(client.calls[0]?.command);
    expect(JSON.stringify(client.calls[2]?.command)).not.toContain('second');
    expect(resumed[0]).toMatchObject({ type: 'reply', text: `resumed:${askId}` });
  });

  it('replays duplicate idempotency without a second side effect', async () => {
    let creates = 0;
    const runId = randomUUID();
    const seen = new Map<string, GatewayRunSnapshot>();
    const client = fakeClient((req) => {
      const existing = seen.get(req.idempotencyKey);
      if (existing) return existing;
      creates += 1;
      const snapshot = { runId, status: 'completed' as const, iteration: 1, outputs: [{ type: 'reply', text: 'once' }] };
      seen.set(req.idempotencyKey, snapshot);
      return snapshot;
    });
    const brain = makeBrain(client);
    const envelope = command('send_message', { text: 'hi' });
    await brain.process(envelope, context());
    await brain.process(envelope, context());
    expect(creates).toBe(1);
    expect(client.calls[0]?.idempotencyKey).toBe(envelope.clientMsgId);
    expect(client.calls[1]?.idempotencyKey).toBe(envelope.clientMsgId);
  });

  it('cancels every cancellable run for the workspace user, not only the last one', async () => {
    expect(controlAbortReason('pause')).toBe('hub_pause');
    expect(controlAbortReason('kill')).toBe('emergency_stop');
    expect(controlAbortReason('resume')).toBeUndefined();

    const store = new MemoryGatewayRunStore();
    const client = fakeClient((req) => {
      const text = String((req.command as { payload?: { text?: string } } | undefined)?.payload?.text ?? '');
      return awaiting(randomUUID(), text === 'b' ? otherAsk : askId);
    });
    const brain = makeBrain(client, { store });
    await brain.process(command('send_message', { text: 'a' }), context());
    await brain.process(
      command('send_message', { text: 'b' }, randomUUID(), otherThread),
      context({
        threadId: otherThread,
        goals: [{ id: otherGoal, userId, threadId: otherThread, title: 'o', status: 'active', createdAt: new Date(), updatedAt: new Date() }],
      })
    );
    await brain.cancelActive('hub_pause', { userId, threadId });
    expect(client.cancels).toEqual(['hub_pause', 'hub_pause']);
    expect(client.cancelled).toHaveLength(2);
    expect(new Set(client.cancelled).size).toBe(2);

    const failing = fakeClient(() => {
      throw new GatewayClientError('unauthorized', 'gateway returned HTTP 401');
    });
    const closed = makeBrain(failing);
    await expect(closed.process(command('send_message', { text: 'hi' }), context())).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(closed.process(command('send_message', { text: 'hi' }), context())).rejects.not.toThrow(/svc\.jwt/);
  });

  it('forwards operator userSuppliedInput + pending goal/thread, never a model URL', async () => {
    const landing = 'https://operator-entered.example/path';
    const fake = new FakeResearchGatewayClient();
    const pendingGoal = randomUUID();
    const brain = makeBrain(fake);
    const outputs = await brain.process(
      command('create_goal', {
        title: 'Launch',
        userSuppliedInput: { landingPageUrl: landing },
        text: 'ignore https://model-invented.example',
      }),
      context({ pendingGoalId: pendingGoal, userSuppliedInput: { landingPageUrl: landing } })
    );
    expect(fake.label).toBe(FAKE_RESEARCH_GATEWAY_LABEL);
    expect(fake.calls[0]?.workspaceId).toBe('seedbed');
    expect(fake.calls[0]?.userId).toBe(userId);
    expect(fake.calls[0]?.goalId).toBe(pendingGoal);
    expect(fake.calls[0]?.threadId).toBe(threadId);
    expect(fake.calls[0]?.userSuppliedInput).toEqual({ landingPageUrl: landing });
    expect(JSON.stringify(fake.calls[0]?.userSuppliedInput)).not.toMatch(/smallseedlabs\.com|model-invented/);
    expect(outputs[0]).toMatchObject({ type: 'tool_call', tool: RESEARCH_ACCEPT_VERB, needsApproval: true });
    expect((outputs[0] as { researchReview?: { landingPageUrl: string } }).researchReview?.landingPageUrl).toBe(landing);

    const invented = fakeClient(() => ({
      runId: randomUUID(),
      status: 'completed',
      iteration: 0,
      outputs: [{ type: 'reply', text: 'ok' }],
    }));
    await makeBrain(invented).process(command('send_message', { text: `use ${landing}` }), context());
    expect(invented.calls[0]?.userSuppliedInput).toBeUndefined();
  });

  it('resumes research_review on the bound run and regathers a new URL after edit', async () => {
    const landing = 'https://operator-entered.example/path';
    const next = 'https://operator-entered.example/new-path';
    const fake = new FakeResearchGatewayClient();
    const store = new MemoryGatewayRunStore();
    const brain = makeBrain(fake, { store });
    const first = await brain.process(
      command('create_goal', { title: 'Launch', userSuppliedInput: { landingPageUrl: landing } }),
      context({ pendingGoalId: goalId, userSuppliedInput: { landingPageUrl: landing } })
    );
    const askId = (first[0] as { askId?: string }).askId;
    expect(askId).toBeTruthy();
    expect(fake.calls[0]?.userSuppliedInput?.landingPageUrl).toBe(landing);

    const restarted = makeBrain(fake, { store });
    const edited = await restarted.process(
      command('answer_ask', {
        askId,
        choice: 'edit',
        askType: 'research_review',
        researchAcceptance: {
          artifactId: (first[0] as { researchReview?: { artifactId: string } }).researchReview?.artifactId,
          version: 1,
          inputRevision: (first[0] as { researchReview?: { inputRevision: string } }).researchReview?.inputRevision,
        },
        userSuppliedInput: { landingPageUrl: next },
      }),
      context()
    );
    expect(fake.calls[1]?.idempotencyKey).toBe(fake.calls[0]?.idempotencyKey);
    expect(fake.calls[1]?.resume).toMatchObject({ askId, choice: 'edit' });
    expect(fake.calls[1]?.userSuppliedInput?.landingPageUrl).toBe(landing);
    expect(fake.calls[2]?.userSuppliedInput?.landingPageUrl).toBe(next);
    expect(fake.calls[2]?.idempotencyKey).not.toBe(fake.calls[0]?.idempotencyKey);
    expect(fake.calls[2]?.resume).toBeUndefined();
    expect((edited[0] as { researchReview?: { landingPageUrl: string; inputRevision: string } }).researchReview?.landingPageUrl).toBe(
      next
    );
    expect((edited[0] as { researchReview?: { inputRevision: string } }).researchReview?.inputRevision).not.toBe(
      (first[0] as { researchReview?: { inputRevision: string } }).researchReview?.inputRevision
    );
  });

  it('does not treat Ads-blocked snapshots as success', async () => {
    const client = fakeClient(() => ({
      runId: randomUUID(),
      status: 'blocked',
      iteration: 0,
      error: { code: 'preflight_blocked', message: 'Ads domain service is not configured (ADS_DOMAIN_URL)', retryable: true },
    }));
    const brain = makeBrain(client);
    await expect(brain.process(command('send_message', { text: 'launch' }), context())).rejects.toMatchObject({
      code: 'preflight_blocked',
    });
  });

  it('carries the goal creative saved after run creation into the approval resume (same URL only)', async () => {
    const landing = 'https://operator-entered.example/path';
    const creative = { type: 'TEXT' as const, headline: 'FAKE headline', body: 'FAKE body' };
    const firstId = randomUUID();
    const store = new MemoryGatewayRunStore();
    const client = fakeClient((req) =>
      req.resume
        ? { runId: firstId, status: 'completed', iteration: 2, outputs: [{ type: 'reply', text: 'ok' }] }
        : awaiting(firstId, askId, 'page.attach_user_page')
    );
    await makeBrain(client, { store }).process(
      command('create_goal', { title: 'Launch', userSuppliedInput: { landingPageUrl: landing } }),
      context({ userSuppliedInput: { landingPageUrl: landing } })
    );
    expect(client.calls[0]?.userSuppliedInput).toEqual({ landingPageUrl: landing });

    await makeBrain(client, { store }).process(
      command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }),
      context({ userSuppliedInput: { landingPageUrl: landing, creative, targeting: { communities: ['FAKEsub'] } } })
    );
    expect(client.calls[1]?.idempotencyKey).toBe(client.calls[0]?.idempotencyKey);
    expect(client.calls[1]?.command).toEqual(client.calls[0]?.command);
    expect(client.calls[1]?.userSuppliedInput).toEqual({
      landingPageUrl: landing,
      creative,
      targeting: { communities: ['FAKEsub'] },
    });
  });

  it('never swaps the stored landing URL on resume', async () => {
    const landing = 'https://operator-entered.example/path';
    const firstId = randomUUID();
    const store = new MemoryGatewayRunStore();
    const client = fakeClient((req) =>
      req.resume
        ? { runId: firstId, status: 'completed', iteration: 2, outputs: [{ type: 'reply', text: 'ok' }] }
        : awaiting(firstId, askId, 'page.attach_user_page')
    );
    await makeBrain(client, { store }).process(
      command('create_goal', { title: 'Launch', userSuppliedInput: { landingPageUrl: landing } }),
      context({ userSuppliedInput: { landingPageUrl: landing } })
    );
    await makeBrain(client, { store }).process(
      command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }),
      context({
        userSuppliedInput: {
          landingPageUrl: 'https://other.example/',
          creative: { type: 'TEXT', headline: 'h', body: 'b' },
        },
      })
    );
    expect(client.calls[1]?.userSuppliedInput).toEqual({ landingPageUrl: landing });
  });

  it('marks a failed run snapshot with its run status so Hub can close the card', async () => {
    const client = fakeClient(() => ({
      runId: randomUUID(),
      status: 'failed',
      iteration: 1,
      error: { code: 'policy_denied', message: 'refused', retryable: false },
    }));
    await expect(makeBrain(client).process(command('send_message', { text: 'go' }), context())).rejects.toMatchObject({
      code: 'policy_denied',
      retryable: false,
      runStatus: 'failed',
    });
  });

  it('flags a blocked resume as consuming the ask (the run left awaiting_approval)', async () => {
    const firstId = randomUUID();
    const store = new MemoryGatewayRunStore();
    const client = fakeClient((req) =>
      req.resume
        ? {
            runId: firstId,
            status: 'blocked',
            iteration: 2,
            error: { code: 'preflight_blocked', message: 'context build failed', retryable: true },
          }
        : awaiting(firstId, askId)
    );
    await makeBrain(client, { store }).process(command('send_message', { text: 'pause it' }), context());
    await expect(
      makeBrain(client, { store }).process(command('answer_ask', { askId, choice: 'approve', askType: 'action_approval' }), context())
    ).rejects.toMatchObject({ code: 'preflight_blocked', runStatus: 'blocked', askConsumed: true });
    const blockedFresh = fakeClient(() => ({
      runId: randomUUID(),
      status: 'blocked',
      iteration: 0,
      error: { code: 'preflight_blocked', message: 'x', retryable: true },
    }));
    await expect(makeBrain(blockedFresh).process(command('send_message', { text: 'go' }), context())).rejects.toMatchObject({
      askConsumed: false,
    });
  });
});
