import { describe, expect, it } from 'vitest';
import { brainFailureMessage, isTerminalBrainFailure } from './command-processor.js';
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

  it('says the card is closed when the run behind it has ended', () => {
    const msg = brainFailureMessage(new GatewayClientError('policy_denied', 'refused', undefined, false, 'failed'), {
      answeringAsk: true,
      askClosed: true,
    });
    expect(msg).toMatch(/This request is closed because the run behind it can no longer continue from it/);
    expect(msg).not.toMatch(/card is still open/);
  });
});

describe('isTerminalBrainFailure', () => {
  it('is true for a dead run or an approval the gateway no longer holds', () => {
    expect(isTerminalBrainFailure(new GatewayClientError('approval_expired', 'x'))).toBe(true);
    expect(isTerminalBrainFailure(new GatewayClientError('approval_mismatch', 'x'))).toBe(true);
    expect(isTerminalBrainFailure(new GatewayClientError('policy_denied', 'x', undefined, false, 'failed'))).toBe(true);
    expect(isTerminalBrainFailure(new GatewayClientError('outcome_ambiguous', 'x', undefined, false, 'ambiguous'))).toBe(true);
  });

  it('is false for blocked runs, transport failures and non-gateway errors', () => {
    expect(isTerminalBrainFailure(new GatewayClientError('preflight_blocked', 'x', undefined, true, 'blocked'))).toBe(false);
    expect(isTerminalBrainFailure(new GatewayClientError('preflight_blocked', 'x', undefined, true, 'blocked', true))).toBe(true);
    expect(isTerminalBrainFailure(new GatewayClientError('timeout', 'x', undefined, true))).toBe(false);
    expect(isTerminalBrainFailure(new GatewayClientError('idempotency_conflict', 'x', 409))).toBe(false);
    expect(isTerminalBrainFailure(new Error('boom'))).toBe(false);
  });
});
