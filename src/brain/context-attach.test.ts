import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope, ContextNeed, ContextPacket } from '@smallseedlabs/proba-protocol';
import { createHubAudit, setAuditForTests } from '../audit/service.js';
import { newTraceContext, runWithTrace, startSpan } from '../audit/trace.js';
import { MemoryOutbox } from '../audit/test-support.js';
import type { AssertionMinter } from '../auth/assertions/mint.js';
import type { BrainContext, BrainPort } from '../types.js';
import { ContextClientError, type ContextClient } from './context-client.js';
import {
  bridgeFailureOutputs,
  runBrainWithBridge,
  type ContextBridgeRuntime,
} from './context-attach.js';
import { MockBrain } from './mock-brain.js';

const USER = '660e8400-e29b-41d4-a716-446655440001';
const GOAL = '770e8400-e29b-41d4-a716-446655440002';
const THREAD = '880e8400-e29b-41d4-a716-446655440003';
const TRACE = '220e8400-e29b-41d4-a716-446655440020';

function packet(overrides: Partial<ContextPacket> = {}): ContextPacket {
  return {
    packetId: overrides.packetId ?? '110e8400-e29b-41d4-a716-446655440010',
    packetHash: overrides.packetHash ?? 'a'.repeat(64),
    traceId: TRACE,
    workspaceId: 'seedbed',
    userId: USER,
    goalId: GOAL,
    stepId: overrides.stepId ?? 'step-1',
    configVersion: overrides.configVersion ?? '1',
    templateVersion: '1',
    sections: overrides.sections ?? [],
    gaps: overrides.gaps ?? [],
    manifest: overrides.manifest ?? {
      sources: {},
      totals: { returned: 0, included: 0, dropped: 0, tokens: 0, gaps: 0, latencyMs: 0 },
      droppedItemIds: [],
    },
  };
}

function command(
  type: CommandEnvelope['type'] = 'create_goal',
  payload: Record<string, unknown> = { title: 'Raise budget' }
): CommandEnvelope {
  return {
    type,
    clientMsgId: '990e8400-e29b-41d4-a716-446655440099',
    threadId: THREAD,
    payload,
  } as CommandEnvelope;
}

function context(): BrainContext {
  return {
    userId: USER,
    threadId: THREAD,
    goals: [{ id: GOAL, userId: USER, threadId: THREAD, title: 'g', status: 'active', createdAt: new Date(), updatedAt: new Date() }],
    client: {} as BrainContext['client'],
  };
}

function minter(): AssertionMinter {
  return {
    kid: 'hub-key-1',
    mint: vi.fn(async () => ({
      token: 'assertion.jwt',
      claims: {
        iss: 'proba-hub' as const,
        aud: ['proba-context', 'proba-audit', 'proba-memory', 'proba-hub'] as [
          'proba-context',
          'proba-audit',
          'proba-memory',
          'proba-hub',
        ],
        sub: USER,
        workspaceId: 'seedbed',
        goalId: GOAL,
        threadId: THREAD,
        scopes: ['context:build'],
        iat: 1,
        exp: 100,
        jti: 'jti-1',
      },
    })),
  };
}

function runtime(
  client: ContextClient,
  overrides: Partial<ContextBridgeRuntime> = {}
): ContextBridgeRuntime {
  return {
    enabled: true,
    client,
    minter: minter(),
    maxNeedRounds: 2,
    onFailure: 'clarify',
    workspaceId: 'seedbed',
    ...overrides,
  };
}

describe('runBrainWithBridge', () => {
  let outbox: MemoryOutbox;

  beforeEach(() => {
    outbox = new MemoryOutbox();
    setAuditForTests(createHubAudit({ outbox, enabled: true }));
  });

  afterEach(() => {
    setAuditForTests(undefined);
  });

  it('attaches the packet, audits brain.context_attached, and stores it on the step context', async () => {
    const builds: ContextPacket[] = [packet()];
    const client: ContextClient = {
      build: vi.fn(async () => builds[0]),
    };
    const brain = new MockBrain('happy_path');
    const ctx = context();

    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client),
        brain,
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'create_goal' },
        envelope: command('create_goal'),
        context: ctx,
        brainSpan: span,
        goalId: GOAL,
      });
    });

    expect(result.attached?.packet.packetId).toBe(builds[0].packetId);
    expect(ctx.contextPacket?.packetId).toBe(builds[0].packetId);
    expect(ctx.stepId).toBe(result.attached?.stepId);
    expect(ctx.stepType).toBe('plan_goal');
    expect(client.build).toHaveBeenCalledWith(
      expect.objectContaining({ stepType: 'plan_goal', goalId: GOAL, threadId: THREAD }),
      expect.objectContaining({ assertion: 'assertion.jwt' })
    );
    const req = vi.mocked(client.build).mock.calls[0]![0];
    expect(req).not.toHaveProperty('needs');

    const actions = outbox.events.map((e) => e.action);
    expect(actions).toContain('brain.context_attached');
    const attached = outbox.events.find((e) => e.action === 'brain.context_attached');
    expect(attached?.details).toMatchObject({
      packetId: builds[0].packetId,
      packetHash: builds[0].packetHash,
      stepType: 'plan_goal',
      configVersion: '1',
    });
    expect(attached?.details).toHaveProperty('stepId');
  });

  it('emits context.build_failed and clarifies when the bridge is unreachable', async () => {
    const client: ContextClient = {
      build: vi.fn(async () => {
        throw new ContextClientError('unreachable', 'down');
      }),
    };
    const brain: BrainPort = {
      process: vi.fn(async () => [{ type: 'reply' as const, text: 'should not run' }]),
    };

    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client, { onFailure: 'clarify' }),
        brain,
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'send_message' },
        envelope: command('send_message'),
        context: context(),
        brainSpan: span,
        goalId: GOAL,
      });
    });

    expect(brain.process).not.toHaveBeenCalled();
    expect(result.attached).toBeNull();
    expect(result.outputs[0]?.type).toBe('clarify');
    expect(outbox.events.map((e) => e.action)).toContain('context.build_failed');
    expect(outbox.events.find((e) => e.action === 'context.build_failed')?.errorCode).toBe('unreachable');
  });

  it('holds the step with no outputs when onFailure is hold', async () => {
    const client: ContextClient = {
      build: vi.fn(async () => {
        throw new ContextClientError('timeout', 'slow');
      }),
    };
    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client, { onFailure: 'hold' }),
        brain: new MockBrain('happy_path'),
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'send_message' },
        envelope: command('send_message'),
        context: context(),
        brainSpan: span,
        goalId: GOAL,
      });
    });
    expect(result.held).toBe(true);
    expect(result.outputs).toEqual([]);
    expect(bridgeFailureOutputs('hold')).toEqual([]);
  });

  it('runs the hybrid needs loop up to maxNeedRounds', async () => {
    const need: ContextNeed = {
      kind: 'analytics_compare',
      campaignIds: ['110e8400-e29b-41d4-a716-4466554400aa', '110e8400-e29b-41d4-a716-4466554400bb'],
      metric: 'spend',
      window: '7d',
    };
    const packets = [
      packet({ packetId: '110e8400-e29b-41d4-a716-446655440010' }),
      packet({ packetId: '110e8400-e29b-41d4-a716-446655440011' }),
      packet({ packetId: '110e8400-e29b-41d4-a716-446655440012' }),
    ];
    let buildN = 0;
    const client: ContextClient = {
      build: vi.fn(async (req) => {
        const p = packets[buildN++]!;
        if (buildN > 1) expect(req.needs).toEqual([need]);
        return p;
      }),
    };

    let processN = 0;
    const brain: BrainPort = {
      process: vi.fn(async (_cmd, ctx) => {
        processN += 1;
        expect(ctx.contextPacket).toBeDefined();
        expect(ctx.messages).toBeUndefined();
        if (processN <= 2) return { outputs: [], needs: [need] };
        return [{ type: 'reply' as const, text: 'done' }];
      }),
    };

    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client, { maxNeedRounds: 2 }),
        brain,
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'create_goal' },
        envelope: command('create_goal'),
        context: context(),
        brainSpan: span,
        goalId: GOAL,
      });
    });

    expect(client.build).toHaveBeenCalledTimes(3); // initial + 2 hybrid
    expect(brain.process).toHaveBeenCalledTimes(3);
    expect(result.outputs).toEqual([{ type: 'reply', text: 'done' }]);
    expect(result.attached?.packetIds).toHaveLength(3);
    expect(outbox.events.filter((e) => e.action === 'brain.context_attached')).toHaveLength(3);
  });

  it('stops hybrid needs when the round limit is reached', async () => {
    const need: ContextNeed = { kind: 'audit_trace', traceId: TRACE };
    const client: ContextClient = {
      build: vi.fn(async () => packet({ packetId: randomPacketId() })),
    };
    const brain: BrainPort = {
      process: vi.fn(async () => ({
        outputs: [{ type: 'reply' as const, text: 'partial' }],
        needs: [need],
      })),
    };

    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client, { maxNeedRounds: 1 }),
        brain,
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'create_goal' },
        envelope: command('create_goal'),
        context: context(),
        brainSpan: span,
        goalId: GOAL,
      });
    });

    expect(client.build).toHaveBeenCalledTimes(2); // initial + 1 need round
    expect(brain.process).toHaveBeenCalledTimes(2);
    expect(result.outputs[0]).toMatchObject({ type: 'reply', text: 'partial' });
  });

  it('mock analytics_compare scenario asks for needs then decides on the enriched packet', async () => {
    const packets = [
      packet({ packetId: '110e8400-e29b-41d4-a716-446655440010' }),
      packet({
        packetId: '110e8400-e29b-41d4-a716-446655440011',
        sections: [
          {
            kind: 'analytics',
            priority: 4,
            tokens: 10,
            items: [
              {
                itemId: 'a1',
                sourceRef: { source: 'analytics', id: 'camp-a' },
                trust: 'external',
                data: { spend: 42 },
                observedAt: '2026-10-29T00:00:00.000Z',
              },
            ],
          },
        ],
      }),
    ];
    let n = 0;
    const client: ContextClient = {
      build: vi.fn(async (req) => {
        if (n === 1) {
          expect(req.needs?.[0]).toMatchObject({ kind: 'analytics_compare', metric: 'spend' });
        }
        return packets[n++]!;
      }),
    };
    const brain = new MockBrain('context_analytics_compare');
    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client),
        brain,
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'create_goal' },
        envelope: command('create_goal', { title: 'Raise budget #context_analytics_compare' }),
        context: context(),
        brainSpan: span,
        goalId: GOAL,
      });
    });
    expect(result.outputs[0]?.type).toBe('decision');
    expect(client.build).toHaveBeenCalledTimes(2);
  });

  it('mock need-refused scenario clarifies when the packet carries need_refused_by_policy', async () => {
    const packets = [
      packet({ packetId: '110e8400-e29b-41d4-a716-446655440010' }),
      packet({
        packetId: '110e8400-e29b-41d4-a716-446655440011',
        gaps: [
          {
            code: 'need_refused_by_policy',
            source: 'memory',
            reason: 'Policy refuses that memory search',
            suggestedQuestion: 'What else can I use?',
          },
        ],
      }),
    ];
    let n = 0;
    const client: ContextClient = { build: vi.fn(async () => packets[n++]!) };
    const brain = new MockBrain('context_need_refused');
    const result = await runWithTrace(newTraceContext(TRACE), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime: runtime(client),
        brain,
        client: {} as BrainContext['client'],
        scope: { userId: USER, threadId: THREAD, commandType: 'create_goal' },
        envelope: command('create_goal', { title: 'Raise budget #context_need_refused' }),
        context: context(),
        brainSpan: span,
        goalId: GOAL,
      });
    });
    expect(result.outputs[0]?.type).toBe('clarify');
    expect((result.outputs[0] as { reason: string }).reason).toMatch(/refused by policy/i);
  });
});

function randomPacketId(): string {
  return `110e8400-e29b-41d4-a716-${Math.floor(Math.random() * 1e12)
    .toString()
    .padStart(12, '0')
    .slice(0, 12)}`;
}
