import { describe, expect, it, vi } from 'vitest';
import { ContextClientError } from './context-client.js';
import { createContextClient, HttpContextClient } from './http-context-client.js';

const packet = {
  packetId: '110e8400-e29b-41d4-a716-446655440010',
  packetHash: 'a'.repeat(64),
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

const request = {
  traceId: packet.traceId,
  workspaceId: 'seedbed',
  userId: packet.userId,
  goalId: packet.goalId,
  threadId: '880e8400-e29b-41d4-a716-446655440003',
  stepId: 'step-1',
  stepType: 'propose_budget' as const,
};

describe('HttpContextClient', () => {
  it('posts to the bridge and validates the packet', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(packet), { status: 200 }));
    const client = new HttpContextClient({ baseUrl: 'http://bridge.example', fetchImpl });
    const result = await client.build(request, { assertion: 'jwt' });
    expect(result.packetId).toBe(packet.packetId);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://bridge.example/v1/context/build',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer jwt' }),
      })
    );
  });

  it('opens the circuit after repeated failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    const client = new HttpContextClient({
      baseUrl: 'http://bridge.example',
      fetchImpl,
      failureThreshold: 2,
      openMs: 60_000,
    });
    await expect(client.build(request, { assertion: 'jwt' })).rejects.toMatchObject({ code: 'http_error' });
    await expect(client.build(request, { assertion: 'jwt' })).rejects.toMatchObject({ code: 'http_error' });
    await expect(client.build(request, { assertion: 'jwt' })).rejects.toBeInstanceOf(ContextClientError);
    await expect(client.build(request, { assertion: 'jwt' })).rejects.toMatchObject({ code: 'circuit_open' });
  });

  it('is disabled when CONTEXT_BRIDGE_URL is empty', async () => {
    const client = createContextClient({ baseUrl: '' });
    await expect(client.build(request, { assertion: 'jwt' })).rejects.toMatchObject({ code: 'unreachable' });
  });
});
