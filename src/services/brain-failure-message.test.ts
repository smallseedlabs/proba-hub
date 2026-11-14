import { describe, expect, it } from 'vitest';
import { brainFailureEventExtra, brainFailureMessage, isTerminalBrainFailure } from './brain-failure.js';
import { GatewayClientError } from '../brain/gateway-client.js';

describe('brainFailureMessage', () => {
  it('turns a billing preflight block into a funded-wallet retry instruction', () => {
    expect(
      brainFailureMessage(
        new GatewayClientError(
          'preflight_blocked',
          'authoritative Ads domain reported the workspace is not billing-eligible',
          undefined,
          true,
          'blocked',
          true
        )
      )
    ).toBe(
      'Campaign creation is blocked because your Reddit Ads wallet is not funded. Add funds to your Reddit Ads wallet, then press Retry. Nothing was spent.'
    );
  });

  it('keeps a gateway-authored blocked reply that already says how to retry', () => {
    const text =
      'Campaign creation is blocked because your Reddit Ads wallet is not funded. Add funds to your Reddit Ads wallet, then press Retry. Nothing was spent.';
    expect(brainFailureMessage(new GatewayClientError('preflight_blocked', text, undefined, true))).toBe(text);
  });

  it('explains other preflight blocks without repeating the raw reason as a question', () => {
    expect(brainFailureMessage(new GatewayClientError('preflight_blocked', 'llm.quota unknown'))).toBe(
      'This step is blocked: llm.quota unknown. Fix that, then press Retry. Nothing was spent.'
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

describe('brainFailureEventExtra', () => {
  it('keeps retryable false on a consumed ask so the card stays closed, and offers a new Retry action', () => {
    const extra = brainFailureEventExtra(
      new GatewayClientError('preflight_blocked', 'not billing-eligible', undefined, true, 'blocked', true),
      { askId: 'ask-1', askClosed: true }
    );
    expect(extra).toEqual({ askId: 'ask-1', retryable: false, retryAction: true, blocked: true });
  });

  it('leaves a still-open ask retryable without a separate Retry action', () => {
    const extra = brainFailureEventExtra(new GatewayClientError('timeout', 'x', undefined, true), {
      askId: 'ask-1',
      askClosed: false,
    });
    expect(extra).toEqual({ askId: 'ask-1', retryable: true });
  });
});
