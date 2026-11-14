/**
 * Pure helpers for brain-step failures. Kept out of command-processor.ts so unit tests can import them
 * without loading the Redis/DB modules (importing those connects at module load and hangs a test run with no Redis).
 */

import { GatewayClientError } from '../brain/gateway-client.js';

/**
 * What the person sees when the brain step fails. A gateway preflight block is a deliberate, explained
 * refusal (nothing was spent), so its reason is shown instead of a generic retry message. The reason is
 * gateway policy text (capability and config names), never provider output; it is still masked and capped.
 */
export function brainFailureMessage(
  cause: unknown,
  options: { answeringAsk?: boolean; askClosed?: boolean } = {}
): string {
  const retry = options.askClosed
    ? ' This request is closed because the run behind it can no longer continue from it; nothing more will run from it.'
    : options.answeringAsk
      ? ' Your answer was not recorded; the card is still open, so you can answer it again.'
      : ' Please try again.';
  if (!(cause instanceof GatewayClientError)) return `Failed to process command.${retry}`;
  const reason = safeReason(cause.message);
  switch (cause.code) {
    case 'preflight_blocked':
    case 'budget_exhausted':
      return preflightBlockedMessage(reason);
    case 'policy_denied':
      return `Proba stopped this step because a tool request was refused by policy (nothing was spent)${reason ? `: ${reason}.` : '.'}${retry}`;
    case 'idempotency_conflict':
      return `Proba could not resume this step: the request did not match the original run (nothing was spent).${retry}`;
    case 'approval_expired':
    case 'approval_mismatch':
      return 'This approval is no longer pending in Proba, so nothing was run. Refresh the thread to see the current request.';
    case 'unreachable':
    case 'timeout':
      return `Proba's planner could not be reached (nothing was spent).${retry}`;
  }
  return `Failed to process command.${retry}`;
}

/** User-facing copy for a preflight/guardrail block: why, what unblocks it, and the next step. */
export function preflightBlockedMessage(reason: string): string {
  if (!reason) {
    return 'This step is blocked by a preflight check. Fix that, then press Retry. Nothing was spent.';
  }
  if (/press Retry/i.test(reason)) {
    return reason.endsWith('.') ? reason : `${reason}.`;
  }
  if (/billing-eligible|insufficient provider funds/i.test(reason)) {
    return (
      'Campaign creation is blocked because your Reddit Ads wallet is not funded. ' +
      'Add funds to your Reddit Ads wallet, then press Retry. Nothing was spent.'
    );
  }
  if (/not verified|provider balance is not verified|provider billing/i.test(reason)) {
    return (
      'Campaign creation is blocked because Proba could not verify billing on the ad account. ' +
      'Check the Ads connection and billing, then press Retry. Nothing was spent.'
    );
  }
  return `This step is blocked: ${reason}. Fix that, then press Retry. Nothing was spent.`;
}

export interface BrainFailureEventExtra {
  askId?: string;
  retryable: boolean;
  retryAction?: boolean;
  blocked?: boolean;
}

/**
 * Fields on the thread error event. `retryable` still means "the same ask can be
 * answered again". `retryAction` means a new Retry button should start a fresh
 * step (for example after funding the ads wallet when the previous approval was
 * already used).
 */
export function brainFailureEventExtra(
  cause: unknown,
  options: { askId?: string; askClosed?: boolean } = {}
): BrainFailureEventExtra {
  const closed = options.askClosed === true;
  const gatewayRetryable = cause instanceof GatewayClientError && cause.retryable === true;
  const blocked =
    cause instanceof GatewayClientError &&
    (cause.code === 'preflight_blocked' || cause.code === 'budget_exhausted' || cause.runStatus === 'blocked');
  const retryAction = gatewayRetryable && (closed || !options.askId);
  return {
    ...(options.askId ? { askId: options.askId } : {}),
    retryable: !closed,
    ...(retryAction ? { retryAction: true } : {}),
    ...(blocked ? { blocked: true } : {}),
  };
}

/** Gateway reasons are policy/config text, never provider output; still masked, collapsed and capped. */
function safeReason(message: string): string {
  return message
    .replace(/(bearer\s+\S+|eyJ[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,})/gi, '[masked]')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .slice(0, 400);
}

/** Gateway run statuses after which the run cannot continue from this ask. */
const DEAD_RUN_STATUSES = new Set(['failed', 'ambiguous', 'cancelled', 'stopped']);

/**
 * True when answering the same ask again cannot succeed: the gateway no longer holds the
 * approval, the run behind it finished failed/ambiguous, or the resume itself moved the run
 * out of awaiting_approval (e.g. blocked after the approval was used; the Hub only resumes an
 * awaiting run). A timeout or an unreachable gateway stays retryable.
 */
export function isTerminalBrainFailure(cause: unknown): boolean {
  if (!(cause instanceof GatewayClientError)) return false;
  if (cause.code === 'approval_expired' || cause.code === 'approval_mismatch') return true;
  if (cause.askConsumed && cause.runStatus !== undefined && cause.runStatus !== 'awaiting_approval') return true;
  return cause.runStatus !== undefined && DEAD_RUN_STATUSES.has(cause.runStatus);
}
