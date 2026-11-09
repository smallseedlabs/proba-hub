import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { durableGatewayRequest, MemoryGatewayRunStore } from './gateway-run-store.js';
import type { GatewayRunRequest } from './gateway-client.js';

const workspaceId = 'seedbed';
const userId = '660e8400-e29b-41d4-a716-446655440001';
const otherUser = '661e8400-e29b-41d4-a716-446655440099';
const askId = '990e8400-e29b-41d4-a716-446655440004';
const otherAsk = '991e8400-e29b-41d4-a716-446655440005';

function request(idempotencyKey: string): GatewayRunRequest {
  return {
    traceId: randomUUID(),
    workspaceId,
    userId,
    stepId: randomUUID(),
    stepType: 'interpret_message',
    command: { kind: 'command', type: 'send_message', clientMsgId: idempotencyKey, payload: { text: 'hi' }, sentAt: new Date().toISOString() },
    idempotencyKey,
    actAsAssertion: 'actas.jwt.token',
    resume: { askId, choice: 'approve' },
  };
}

describe('MemoryGatewayRunStore', () => {
  it('strips tokens and resume from durable rows and isolates tenants', async () => {
    const store = new MemoryGatewayRunStore();
    const key = randomUUID();
    await store.upsert({
      workspaceId,
      userId,
      idempotencyKey: key,
      runId: randomUUID(),
      askId,
      threadId: randomUUID(),
      goalId: randomUUID(),
      status: 'awaiting_approval',
      request: request(key),
    });
    const row = await store.getByAsk({ workspaceId, userId, askId });
    expect(row?.request.actAsAssertion).toBeUndefined();
    expect(row?.request.resume).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('actas.jwt.token');
    expect(durableGatewayRequest(request(key)).actAsAssertion).toBeUndefined();
    expect(await store.getByAsk({ workspaceId, userId: otherUser, askId })).toBeUndefined();
    expect(await store.getByAsk({ workspaceId: 'other', userId, askId })).toBeUndefined();
  });

  it('keeps two awaiting runs independent and lists both for cancel', async () => {
    const store = new MemoryGatewayRunStore();
    const first = randomUUID();
    const second = randomUUID();
    await store.upsert({
      workspaceId,
      userId,
      idempotencyKey: first,
      runId: randomUUID(),
      askId,
      threadId: randomUUID(),
      status: 'awaiting_approval',
      request: request(first),
    });
    await store.upsert({
      workspaceId,
      userId,
      idempotencyKey: second,
      runId: randomUUID(),
      askId: otherAsk,
      threadId: randomUUID(),
      status: 'awaiting_approval',
      request: request(second),
    });
    await store.upsert({
      workspaceId,
      userId,
      idempotencyKey: randomUUID(),
      runId: randomUUID(),
      status: 'completed',
      request: request(randomUUID()),
    });
    const a = await store.getByAsk({ workspaceId, userId, askId });
    const b = await store.getByAsk({ workspaceId, userId, askId: otherAsk });
    expect(a?.idempotencyKey).toBe(first);
    expect(b?.idempotencyKey).toBe(second);
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
    const cancellable = await store.listCancellable({ workspaceId, userId });
    expect(cancellable).toHaveLength(2);
    expect(cancellable.map((row) => row.askId).sort()).toEqual([askId, otherAsk].sort());
  });

  it('replays the same idempotency key onto one row', async () => {
    const store = new MemoryGatewayRunStore();
    const key = randomUUID();
    const runId = randomUUID();
    await store.upsert({
      workspaceId,
      userId,
      idempotencyKey: key,
      runId,
      status: 'running',
      request: request(key),
    });
    await store.upsert({
      workspaceId,
      userId,
      idempotencyKey: key,
      runId,
      status: 'completed',
      request: request(key),
    });
    const row = await store.getByIdempotency({ workspaceId, userId, idempotencyKey: key });
    expect(row?.status).toBe('completed');
    expect(row?.runId).toBe(runId);
  });
});
