import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope, ContextPacket } from '@smallseedlabs/proba-protocol';
import { createHubAudit, setAuditForTests } from '../audit/service.js';
import { newTraceContext, runWithTrace } from '../audit/trace.js';
import { MemoryOutbox } from '../audit/test-support.js';
import type { BrainPort, BrainContext } from '../types.js';
import type { ContextClient } from '../brain/context-client.js';
import { CommandProcessor } from './command-processor.js';

const packet: ContextPacket = {
  packetId: '110e8400-e29b-41d4-a716-446655440010',
  packetHash: 'b'.repeat(64),
  traceId: '220e8400-e29b-41d4-a716-446655440020',
  workspaceId: 'seedbed',
  userId: '660e8400-e29b-41d4-a716-446655440001',
  goalId: '770e8400-e29b-41d4-a716-446655440002',
  stepId: 'step-1',
  configVersion: '1',
  templateVersion: '1',
  sections: [],
  gaps: [],
  manifest: {
    sources: {},
    totals: { returned: 0, included: 0, dropped: 0, tokens: 0, gaps: 0, latencyMs: 0 },
    droppedItemIds: [],
  },
};

describe('CommandProcessor context bridge flag', () => {
  let outbox: MemoryOutbox;

  beforeEach(() => {
    outbox = new MemoryOutbox();
    setAuditForTests(createHubAudit({ outbox, enabled: true }));
  });

  afterEach(() => {
    setAuditForTests(undefined);
  });

  it('does not call the bridge when the feature flag is off (local legacy path)', async () => {
    const seen: BrainContext[] = [];
    const brain: BrainPort = {
      process: vi.fn(async (_cmd, ctx) => {
        seen.push(ctx);
        return [{ type: 'reply' as const, text: 'legacy' }];
      }),
    };
    const client: ContextClient = { build: vi.fn(async () => packet) };
    const processor = new CommandProcessor(brain, {
      contextClient: client,
      contextBridgeEnabled: false,
      assertionMinter: {
        kid: 'k',
        mint: vi.fn(async () => ({ token: 'x', claims: {} as never })),
      },
    });

    const envelope = {
      type: 'send_message',
      clientMsgId: '990e8400-e29b-41d4-a716-446655440099',
      threadId: '880e8400-e29b-41d4-a716-446655440003',
      payload: { text: 'hi' },
    } as CommandEnvelope;

    const ctx: BrainContext = {
      userId: '660e8400-e29b-41d4-a716-446655440001',
      threadId: envelope.threadId,
      messages: [
        {
          id: '1',
          threadId: envelope.threadId!,
          text: 'hi',
          source: 'user',
          createdAt: new Date(),
        },
      ],
      client: { query: vi.fn(async () => ({ rows: [] })) } as never,
    };

    const callBrain = (
      processor as unknown as {
        callBrain: (
          db: unknown,
          scope: { userId: string; threadId?: string; commandType: string },
          envelope: CommandEnvelope,
          context: BrainContext
        ) => Promise<{ outputs: Array<{ type: string; text?: string }> }>;
      }
    ).callBrain.bind(processor);

    const result = await runWithTrace(newTraceContext(packet.traceId), () =>
      callBrain(
        ctx.client,
        { userId: ctx.userId, threadId: ctx.threadId, commandType: 'send_message' },
        envelope,
        ctx
      )
    );

    expect(client.build).not.toHaveBeenCalled();
    expect(result.outputs).toEqual([{ type: 'reply', text: 'legacy' }]);
    expect(seen[0]?.messages).toHaveLength(1);
    expect(seen[0]?.contextPacket).toBeUndefined();
    expect(processor.lastAttachedPacket).toBeNull();
    expect(outbox.events.map((e) => e.action)).toContain('brain.llm_call');
    expect(outbox.events.map((e) => e.action)).not.toContain('brain.context_attached');
  });
});
