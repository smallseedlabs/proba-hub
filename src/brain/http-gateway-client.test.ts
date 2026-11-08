import { describe, expect, it, vi } from 'vitest';
import { GatewayClientError } from './gateway-client.js';
import { createGatewayClient, HttpGatewayClient } from './http-gateway-client.js';

const snapshot = {
  runId: '110e8400-e29b-41d4-a716-446655440010',
  status: 'completed',
  iteration: 1,
  outputs: [{ type: 'reply', text: 'pong' }],
  usage: { llmCalls: 1, toolCalls: 0 },
};

const request = {
  traceId: '220e8400-e29b-41d4-a716-446655440020',
  workspaceId: 'seedbed',
  userId: '660e8400-e29b-41d4-a716-446655440001',
  stepId: 'step-1',
  stepType: 'interpret_message',
  command: { kind: 'command', clientMsgId: snapshot.runId, type: 'send_message', payload: { text: 'hi' }, sentAt: new Date().toISOString() },
  idempotencyKey: snapshot.runId,
};

describe('HttpGatewayClient', () => {
  it('posts /v1/runs with the service bearer and returns the snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200 }));
    const client = new HttpGatewayClient({ baseUrl: 'http://127.0.0.1:3700', fetchImpl });
    const result = await client.createRun(request, 'svc-token');
    expect(result.status).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3700/v1/runs',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer svc-token' }),
      })
    );
  });

  it('maps 401/403 and never echoes secrets from the error body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'unauthorized', message: 'Bearer super-secret.jwt.token was rejected' }), {
          status: 401,
        })
    );
    const client = new HttpGatewayClient({ baseUrl: 'http://gw.example', fetchImpl });
    await expect(client.createRun(request, 'svc-token')).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    await expect(client.createRun(request, 'svc-token')).rejects.toThrow(/HTTP 401/);
    await expect(client.createRun(request, 'svc-token')).rejects.not.toThrow(/super-secret/);

    const expired = vi.fn(
      async () => new Response(JSON.stringify({ error: 'token_expired', message: 'service token has expired' }), { status: 401 })
    );
    const expiredClient = new HttpGatewayClient({ baseUrl: 'http://gw.example', fetchImpl: expired });
    await expect(expiredClient.createRun(request, 'svc-token')).rejects.toMatchObject({ code: 'token_expired', status: 401 });
  });

  it('maps workspace mismatch and timeout', async () => {
    const forbidden = vi.fn(async () => new Response(JSON.stringify({ error: 'workspace_mismatch', message: 'no' }), { status: 403 }));
    const client = new HttpGatewayClient({ baseUrl: 'http://gw.example', fetchImpl: forbidden });
    await expect(client.createRun(request, 'svc-token')).rejects.toMatchObject({ code: 'workspace_mismatch', status: 403 });

    const hanging: typeof fetch = async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const timed = new HttpGatewayClient({ baseUrl: 'http://gw.example', timeoutMs: 5, fetchImpl: hanging });
    await expect(timed.createRun(request, 'svc-token')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('replays cancel and duplicate conflict without leaking the token', async () => {
    const fetchImpl: typeof fetch = async (url) => {
      if (String(url).endsWith('/cancel')) {
        return new Response(JSON.stringify({ runId: snapshot.runId, status: 'cancelled', iteration: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'idempotency_conflict', message: 'token=abcd.efg.hij' }), { status: 409 });
    };
    const client = new HttpGatewayClient({ baseUrl: 'http://gw.example', fetchImpl });
    await expect(client.createRun(request, 'svc-token')).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
    await expect(client.createRun(request, 'svc-token')).rejects.not.toThrow(/abcd\.efg\.hij/);
    const cancelled = await client.cancelRun(snapshot.runId, 'hub_pause', 'svc-token');
    expect(cancelled.status).toBe('cancelled');
  });

  it('is disabled when GATEWAY_URL is empty', async () => {
    const client = createGatewayClient({ baseUrl: '' });
    await expect(client.createRun(request, 't')).rejects.toBeInstanceOf(GatewayClientError);
    await expect(client.createRun(request, 't')).rejects.toMatchObject({ code: 'unconfigured' });
  });
});
