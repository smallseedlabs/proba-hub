import { describe, expect, it } from 'vitest';
import { applyBoundAskId, approvalAskIdFromSnapshot, askIdFromBrainOutput } from './gateway-ask-identity.js';

const askId = '990e8400-e29b-41d4-a716-446655440004';
const minted = 'aa0e8400-e29b-41d4-a716-446655440099';

describe('gateway ask identity', () => {
  it('reads the gateway askId from snapshot.needs and brain output extras', () => {
    expect(
      approvalAskIdFromSnapshot({
        needs: [{ type: 'approval', askId, verb: 'pause_campaign', argsHash: 'x', workspaceId: 'seedbed' }],
      })
    ).toBe(askId);
    expect(askIdFromBrainOutput({ type: 'tool_call', askId, needsApproval: true })).toBe(askId);
    expect(askIdFromBrainOutput({ type: 'tool_call', needsApproval: true })).toBeUndefined();
  });

  it('rewrites Hub ask payload and UI commands to the bound gateway askId', () => {
    const envelope = applyBoundAskId(
      {
        type: 'ask',
        payload: { askId: minted, askType: 'action_approval' },
        ui: {
          actions: [
            { command: { payload: { askId: minted } } },
            { command: { payload: { planId: minted } } },
          ],
        },
      },
      askId
    );
    expect(envelope.payload.askId).toBe(askId);
    expect(envelope.ui.actions[0]?.command?.payload?.askId).toBe(askId);
    expect(envelope.ui.actions[1]?.command?.payload?.planId).toBe(askId);
  });
});
