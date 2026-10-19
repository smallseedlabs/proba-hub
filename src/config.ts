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
    /** Failed sign-in attempts allowed per email per window (per-IP limit is 3x). */
    loginRateLimitMax: parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_MAX || '10', 10),
    loginRateLimitWindowMs: parseInt(process.env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS || '900000', 10),
    /** POST /dev/login (password-less). Never registered when NODE_ENV=production. */
    devLoginEnabled:
      process.env.NODE_ENV !== 'production' && process.env.DEV_LOGIN_ENABLED !== 'false',
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
