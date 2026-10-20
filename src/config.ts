import { config as loadEnv } from 'dotenv';

loadEnv();

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
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
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
  
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
} as const;
