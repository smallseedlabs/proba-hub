import type { FastifyRequest } from 'fastify';
import { createThrottle } from './throttle.js';
import { getAudit } from './service.js';

/** One throttled auth.denied event per client and reason per minute; the rest is counted. */
const throttle = createThrottle({ windowMs: 60_000 });

export type AuthDeniedReason = 'missing_token' | 'invalid_token' | 'rate_limited';

/**
 * Record a rejected request on an authenticated route. Throttled per client and
 * best-effort (the caller is already being refused). Never records the token or
 * the client address (the address is only the throttle key).
 */
export async function auditAuthDenied(request: FastifyRequest, reason: AuthDeniedReason): Promise<void> {
  const { emit, suppressed } = throttle.hit(`${request.ip}|${reason}`);
  if (!emit) return;
  await getAudit().emit(
    {
      action: 'auth.denied',
      outcome: 'denied',
      root: true,
      actor: { type: 'system', id: 'anonymous' },
      target: { type: 'route', id: `${request.method} ${request.routeOptions?.url ?? 'unknown'}` },
      errorCode: reason,
      riskLevel: 'medium',
      details: { reason, ...(suppressed > 0 ? { suppressedSinceLast: suppressed } : {}) },
    },
    { bestEffort: true }
  );
}
