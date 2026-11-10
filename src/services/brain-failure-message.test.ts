import { describe, expect, it } from 'vitest';
import { brainFailureMessage } from './command-processor.js';
import { GatewayClientError } from '../brain/gateway-client.js';

describe('brainFailureMessage', () => {
  it('keeps the preflight reason', () => {
    expect(brainFailureMessage(new GatewayClientError('preflight_blocked', 'llm.quota unknown'))).toBe(
      'Proba could not start this step (nothing was spent): llm.quota unknown'
    );
  });

  it('explains a policy refusal and masks long tokens', () => {
    const msg = brainFailureMessage(new GatewayClientError('policy_denied', `tool URL does not match ${'a'.repeat(40)}.`));
    expect(msg).toBe('Proba stopped this step because a tool request was refused by policy (nothing was spent): tool URL does not match [masked]. Please try again.');
  });

  it('tells the person an answer can be given again', () => {
    expect(brainFailureMessage(new GatewayClientError('idempotency_conflict', 'x', 409), { answeringAsk: true })).toMatch(
      /Your answer was not recorded; the card is still open/
    );
    expect(brainFailureMessage(new Error('boom'))).toBe('Failed to process command. Please try again.');
  });
});
