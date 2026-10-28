import { readFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { resolveJwtSecret } from './auth/jwt-secret.js';

/** Id of the workspace every user belongs to until the Hub models workspaces. */
export const DEFAULT_WORKSPACE_ID = 'seedbed';

loadEnv();

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(raw);
}

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Adapters for the audit publisher port (`src/audit/publisher.ts`). The first is the default. */
export const AUDIT_PUBLISHERS = ['redis', 'log'] as const;
export type AuditPublisherKind = (typeof AUDIT_PUBLISHERS)[number];

function envAuditPublisher(): AuditPublisherKind {
  const raw = process.env.AUDIT_PUBLISHER?.trim().toLowerCase();
  if (!raw) return 'redis';
  if ((AUDIT_PUBLISHERS as readonly string[]).includes(raw)) return raw as AuditPublisherKind;
  throw new Error(`AUDIT_PUBLISHER must be one of ${AUDIT_PUBLISHERS.join(', ')} (got "${raw}")`);
}

/** Brains behind the BrainPort (`src/brain/port.ts`). The first is the default. */
export const BRAIN_PROVIDERS = ['mock', 'deepseek'] as const;
export type BrainProviderKind = (typeof BRAIN_PROVIDERS)[number];

function envBrainProvider(): BrainProviderKind {
  const raw = process.env.BRAIN_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'mock';
  if ((BRAIN_PROVIDERS as readonly string[]).includes(raw)) return raw as BrainProviderKind;
  throw new Error(`BRAIN_PROVIDER must be one of ${BRAIN_PROVIDERS.join(', ')} (got "${raw}")`);
}

function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return process.env[name]?.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** A secret from `<NAME>_FILE` (a mounted secret) or `<NAME>`; the file wins. Never logged. */
function envSecret(name: string): string {
  const filePath = process.env[`${name}_FILE`]?.trim();
  if (filePath) {
    try {
      return readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(`${name}_FILE is set but could not be read (${filePath}): ${(err as Error).message}`);
    }
  }
  return (process.env[name] ?? '').trim();
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV !== 'production',
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',
  
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
  },
  
  database: {
    url: process.env.DATABASE_URL || 'postgresql://proba:proba@localhost:5432/proba_hub',
    poolMin: parseInt(process.env.DATABASE_POOL_MIN || '2', 10),
    poolMax: parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
  },
  
  redis: {
    /** redis:// or rediss:// (TLS). Checked where the client is created (services/redis.ts): production refuses a URL without a password. */
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  
  auth: {
    /** JWT_SECRET_FILE wins over JWT_SECRET; production refuses a missing/dev-default secret. */
    jwtSecret: resolveJwtSecret(),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    /** Failed POST /v1/auth/session attempts allowed per IP per window. */
    sessionRateLimitMax: parseInt(process.env.AUTH_SESSION_RATE_LIMIT_MAX || '30', 10),
    sessionRateLimitWindowMs: parseInt(process.env.AUTH_SESSION_RATE_LIMIT_WINDOW_MS || '900000', 10),
    /** Comma-separated email domains allowed to sign in (verified emails only). Empty = anyone. */
    allowedEmailDomains: (process.env.AUTH_ALLOWED_EMAIL_DOMAINS || '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    /** POST /dev/login (password-less). Never registered when NODE_ENV=production. */
    devLoginEnabled:
      process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED !== 'false',
  },
  
  firebase: {
    /** Firebase project whose ID tokens are accepted (iss/aud). Sign-in is off when unset. */
    projectId: (process.env.FIREBASE_PROJECT_ID || '').trim(),
  },

  cors: {
    /** Comma-separated list of allowed browser origins. */
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  },
  
  sse: {
    heartbeatIntervalMs: parseInt(process.env.SSE_HEARTBEAT_INTERVAL_MS || '30000', 10),
  },
  
  ask: {
    expiryCheckIntervalMs: parseInt(process.env.ASK_EXPIRY_CHECK_INTERVAL_MS || '60000', 10),
  },
  
  outbox: {
    pollIntervalMs: parseInt(process.env.OUTBOX_POLL_MS || '1000', 10),
  },
  
  brain: {
    /** `mock` (default; scripted YAML scenarios) or `deepseek` (DeepSeek chat completions). */
    provider: envBrainProvider(),
    scenario: process.env.MOCK_BRAIN_SCENARIO || 'happy_path',
    deepseek: {
      /** DEEPSEEK_API_KEY_FILE wins over DEEPSEEK_API_KEY. Required when BRAIN_PROVIDER=deepseek. */
      apiKey: envSecret('DEEPSEEK_API_KEY'),
      baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
      model: (process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim(),
      timeoutMs: envInt('DEEPSEEK_TIMEOUT_MS', 30000),
    },
    /**
     * Limits the Hub puts on what a model-backed brain may propose. Spend and budget are in USD
     * (0 = no cap); an over-limit proposal is replaced by a short explanation, never passed on.
     */
    limits: {
      /** Cap on the tokens of one model answer. */
      maxOutputTokens: envInt('BRAIN_MAX_OUTPUT_TOKENS', 1500),
      /** Tool calls kept from one answer; the rest are dropped. */
      maxToolCallsPerTurn: envInt('BRAIN_MAX_TOOL_CALLS', 2),
      /** Spend one tool call may propose (costImpact.proposed). */
      maxActionSpend: envNumber('BRAIN_MAX_ACTION_SPEND', 1000),
      /** Total cost one plan may carry (plan totalCost). */
      maxPlanBudget: envNumber('BRAIN_MAX_PLAN_BUDGET', 10000),
      /** Comma-separated tool names the brain may propose. Empty = any name (every call still needs approval). */
      allowedTools: (process.env.BRAIN_ALLOWED_TOOLS || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      /** Past messages sent to the model with each request. */
      maxContextMessages: envInt('BRAIN_MAX_CONTEXT_MESSAGES', 20),
    },
  },
  
  /**
   * Context bridge: act-as assertion minting, context-reader internal reads, and
   * the ContextClient HTTP adapter. The brain is not wired to the client yet.
   */
  contextBridge: {
    /** Base URL of the context bridge (e.g. http://127.0.0.1:3500). Empty = client disabled. */
    url: (process.env.CONTEXT_BRIDGE_URL || '').trim().replace(/\/+$/, ''),
    /** Accept the context-reader role on /v1/internal/* (requires key files). */
    contextReaderEnabled: envBool('HUB_CONTEXT_READER_ENABLED', false),
    /** PKCS#8 PEM used to mint act-as assertions. Required in production when CONTEXT_BRIDGE_URL is set. */
    assertionPrivateKeyFile: (process.env.HUB_ASSERTION_PRIVATE_KEY_FILE || '').trim(),
    /** Key id stamped in the JWT header when minting. */
    assertionKeyId: (process.env.HUB_ASSERTION_KEY_ID || '').trim(),
    /** Optional JWKS for verification/rotation; when empty, derived from the private key. */
    assertionPublicKeyFile: (process.env.HUB_ASSERTION_PUBLIC_KEY_FILE || '').trim(),
    /** JWKS of the bridge's service-token public keys. */
    contextServicePublicKeyFile: (process.env.CONTEXT_SERVICE_PUBLIC_KEY_FILE || '').trim(),
    /** Timeout for ContextClient HTTP calls. */
    timeoutMs: envInt('CONTEXT_BRIDGE_TIMEOUT_MS', 10_000),
    /** Circuit breaker: failures before open. */
    failureThreshold: envInt('CONTEXT_BRIDGE_FAILURE_THRESHOLD', 5),
    /** Circuit breaker: open duration in ms. */
    openMs: envInt('CONTEXT_BRIDGE_CIRCUIT_OPEN_MS', 30_000),
    /** Cap on GET /v1/internal/threads/{id}/messages?limit=. */
    messagesLimitCap: envInt('HUB_INTERNAL_MESSAGES_LIMIT_CAP', 100),
  },

  /** Audit trail (protocol AuditEvent) through the transactional outbox. */
  audit: {
    /** Master switch: when false no audit event is written to audit_outbox. */
    enabled: envBool('AUDIT_ENABLED', true),
    /**
     * Run the relay that moves audit_outbox rows to the Redis stream. Disable on
     * replicas that should only write (the outbox keeps the events until a relay runs).
     * Default: on, except under NODE_ENV=test so test suites control the relay.
     */
    relayEnabled: envBool('AUDIT_RELAY_ENABLED', process.env.NODE_ENV !== 'test'),
    /**
     * Where the relay publishes audit events: `redis` (default; the Redis Stream the audit-consumer
     * reads) or `log` (writes event ids to the Hub log only; no broker, for local diagnostics).
     */
    publisher: envAuditPublisher(),
    /** Redis stream the audit-consumer reads (used by the `redis` publisher). Same default as proba-audit (EVENT_BUS_AUDIT_TOPIC). */
    stream: process.env.AUDIT_STREAM || 'proba.audit.events',
    /**
     * Put the raw text of messages, replies and explanations on audit events (AuditEvent.content),
     * secrets masked. Off by default: turn it on where people are meant to read the conversation
     * in the audit portal. Length fields stay in `details` either way.
     */
    contentEnabled: envBool('AUDIT_CONTENT_ENABLED', false),
    /**
     * When content is enabled, also mask emails, phone numbers and IBANs in `AuditEvent.content`
     * (secrets and cards are always masked). Default on: turn off only for diagnostics.
     */
    contentMaskPii: envBool('AUDIT_CONTENT_MASK_PII', true),
    /** Workspace stamped on events when none is known (the Hub does not model workspaces yet). */
    workspaceId: process.env.AUDIT_WORKSPACE_ID || DEFAULT_WORKSPACE_ID,
    /** `service` field of emitted events. */
    service: 'hub',
    relayPollIntervalMs: envInt('AUDIT_RELAY_POLL_MS', 500),
    relayBatchSize: envInt('AUDIT_RELAY_BATCH_SIZE', 100),
    /** Lease on claimed rows; also the retry delay after a failed publish. */
    relayLeaseMs: envInt('AUDIT_RELAY_LEASE_MS', 30000),
    /** Published rows older than this are pruned from audit_outbox. 0 keeps them. */
    retainPublishedMs: envInt('AUDIT_OUTBOX_RETAIN_MS', 24 * 60 * 60 * 1000),
    /** Approximate XADD MAXLEN for the stream. 0 = unbounded. */
    maxStreamLength: envInt('AUDIT_STREAM_MAXLEN', 0),
  },

  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;
