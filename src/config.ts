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
    scenario: process.env.MOCK_BRAIN_SCENARIO || 'happy_path',
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
