/**
 * Act-as assertion and context-reader service-token constants (shared contract with
 * proba-audit, proba-memory and the context bridge).
 */

export const ACT_AS_ISSUER = 'proba-hub';
export const CONTEXT_SERVICE_ISSUER = 'proba-context';
export const CONTEXT_HUB_AUDIENCE = 'proba-hub';
export const CONTEXT_READER_ROLE = 'context-reader';

/** Service token lives at most two minutes (exp − iat). */
export const CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS = 120;
/** Act-as assertion lives at most five minutes (exp − iat). Protocol ACT_AS_ASSERTION_MAX_TTL_SECONDS. */
export const ACT_AS_ASSERTION_MAX_TTL_SECONDS = 5 * 60;
/** Clock difference tolerated when checking exp, nbf and iat. */
export const CONTEXT_CLOCK_SKEW_SECONDS = 30;

export const ACT_AS_HEADER = 'x-act-as';

/** Default audiences stamped on every assertion the Hub mints. */
export const ACT_AS_DEFAULT_AUDIENCES = [
  'proba-context',
  'proba-audit',
  'proba-memory',
  'proba-hub',
] as const;

/**
 * Routes that accept the context-reader role (method + Fastify `routeOptions.url`,
 * which includes the `/v1/internal` prefix).
 */
export const CONTEXT_READER_ROUTES = new Set([
  'GET /v1/internal/goals/:goalId/state',
  'GET /v1/internal/threads/:threadId/messages',
  'POST /v1/internal/authorize',
]);
