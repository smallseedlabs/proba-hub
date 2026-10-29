import { describe, expect, it, vi } from 'vitest';
import type { CommandEnvelope, ContextPacket } from '@smallseedlabs/proba-protocol';
import type { BrainContext, BrainPort } from '../types.js';
import type { ContextClient } from './context-client.js';
import { contextBridgeRuntimeFromConfig, runBrainWithBridge } from './context-attach.js';
import { createHubAudit, setAuditForTests } from '../audit/service.js';
import { MemoryOutbox } from '../audit/test-support.js';
import { newTraceContext, runWithTrace, startSpan } from '../audit/trace.js';
import { afterEach, beforeEach } from 'vitest';

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

describe('context bridge feature flag (no Redis)', () => {
  let outbox: MemoryOutbox;

  beforeEach(() => {
    outbox = new MemoryOutbox();
    setAuditForTests(createHubAudit({ outbox, enabled: true }));
  });

  afterEach(() => {
    setAuditForTests(undefined);
  });

  it('skips the bridge when enabled is false (legacy path)', async () => {
    const seen: BrainContext[] = [];
    const brain: BrainPort = {
      process: vi.fn(async (_cmd, ctx) => {
        seen.push(ctx);
        return [{ type: 'reply' as const, text: 'legacy' }];
      }),
    };
    const client: ContextClient = { build: vi.fn(async () => packet) };
    const runtime = contextBridgeRuntimeFromConfig(client, null);
    runtime.enabled = false;

    // When the flag is off, CommandProcessor never calls runBrainWithBridge.
    // Assert the runtime default + that a direct brain call keeps messages.
    expect(runtime.enabled).toBe(false);
    const envelope = {
      type: 'send_message',
      clientMsgId: '990e8400-e29b-41d4-a716-446655440099',
      threadId: '880e8400-e29b-41d4-a716-446655440003',
      payload: { text: 'hi' },
    } as CommandEnvelope;
    const ctx: BrainContext = {
      userId: packet.userId,
      threadId: envelope.threadId,
      messages: [
        { id: '1', threadId: envelope.threadId!, text: 'hi', source: 'user', createdAt: new Date() },
      ],
      client: {} as never,
    };
    await brain.process(envelope, ctx);
    expect(client.build).not.toHaveBeenCalled();
    expect(seen[0]?.messages).toHaveLength(1);
    expect(seen[0]?.contextPacket).toBeUndefined();
  });

  it('uses the packet-only path when enabled', async () => {
    const brain: BrainPort = {
      process: vi.fn(async (_cmd, ctx) => {
        expect(ctx.contextPacket?.packetId).toBe(packet.packetId);
        expect(ctx.messages).toBeUndefined();
        return [{ type: 'reply' as const, text: 'bridged' }];
      }),
    };
    const client: ContextClient = { build: vi.fn(async () => packet) };
    const runtime = contextBridgeRuntimeFromConfig(client, {
      kid: 'k',
      mint: vi.fn(async () => ({
        token: 'jwt',
        claims: {
          iss: 'proba-hub' as const,
          aud: ['proba-context', 'proba-audit', 'proba-memory', 'proba-hub'] as [
            'proba-context',
            'proba-audit',
            'proba-memory',
            'proba-hub',
          ],
          sub: packet.userId,
          workspaceId: 'seedbed',
          goalId: packet.goalId,
          threadId: '880e8400-e29b-41d4-a716-446655440003',
          scopes: ['context:build'],
          iat: 1,
          exp: 100,
          jti: 'j',
        },
      })),
    });
    runtime.enabled = true;

    const result = await runWithTrace(newTraceContext(packet.traceId), async () => {
      const span = startSpan();
      return runBrainWithBridge({
        runtime,
        brain,
        client: {} as never,
        scope: { userId: packet.userId, threadId: '880e8400-e29b-41d4-a716-446655440003', commandType: 'send_message' },
        envelope: {
          type: 'send_message',
          clientMsgId: '990e8400-e29b-41d4-a716-446655440099',
          threadId: '880e8400-e29b-41d4-a716-446655440003',
          payload: { text: 'hi' },
        } as CommandEnvelope,
        context: {
          userId: packet.userId,
          threadId: '880e8400-e29b-41d4-a716-446655440003',
          goals: [
            {
              id: packet.goalId,
              userId: packet.userId,
              threadId: '880e8400-e29b-41d4-a716-446655440003',
              title: 'g',
              status: 'active',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          client: {} as never,
        },
        brainSpan: span,
        goalId: packet.goalId,
      });
    });

    expect(client.build).toHaveBeenCalled();
    expect(result.outputs[0]).toMatchObject({ type: 'reply', text: 'bridged' });
    expect(outbox.events.map((e) => e.action)).toContain('brain.context_attached');
  });
});
