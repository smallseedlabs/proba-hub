/**
 * Rules for REDIS_URL, kept free of side effects so config.ts can apply them at import time.
 *
 * - `redis://` is plain TCP (inside a private network only), `rediss://` is TLS (node-redis verifies the certificate
 *   and host name; for a private CA set NODE_EXTRA_CA_CERTS). Any other scheme is refused.
 * - Credentials travel in the URL: `redis://user:password@host:6379` (the user is optional: `redis://:password@host`).
 * - With NODE_ENV=production a URL without a password is refused: Redis carries the audit stream and the SSE fan-out.
 */

export class InvalidRedisUrlError extends Error {
  constructor(reason: string) {
    super(`Invalid REDIS_URL: ${reason}`);
    this.name = 'InvalidRedisUrlError';
  }
}

export class RedisPasswordRequiredError extends Error {
  constructor() {
    super(
      'REDIS_URL has no password. With NODE_ENV=production the Hub refuses to use an unauthenticated Redis: ' +
        'set REDIS_URL=redis://<user>:<password>@host:6379 (rediss:// for TLS). docker-compose.yml starts Redis with an ACL user; ' +
        'scripts/generate-local-env.sh writes a local .env with random passwords.'
    );
    this.name = 'RedisPasswordRequiredError';
  }
}

export interface RedisUrlInfo {
  /** True for `rediss://`. */
  tls: boolean;
  /** The ACL user in the URL, or '' (the default user). */
  username: string;
  /** True when the URL carries a non-empty password. */
  hasPassword: boolean;
  host: string;
}

/** Parse a Redis URL without ever returning (or logging) the password. Throws InvalidRedisUrlError. */
export function parseRedisUrl(url: string): RedisUrlInfo {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InvalidRedisUrlError('not a URL (expected redis://[user]:password@host:port or rediss://...)');
  }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new InvalidRedisUrlError(`unsupported scheme "${u.protocol}" (use redis:// or rediss://)`);
  }
  return {
    tls: u.protocol === 'rediss:',
    username: decodeURIComponent(u.username),
    hasPassword: decodeURIComponent(u.password) !== '',
    host: u.hostname,
  };
}

/** Throws unless the URL is valid and, in production, carries a password. Returns the URL unchanged. */
export function assertRedisUrl(url: string, isProduction: boolean): string {
  const info = parseRedisUrl(url);
  if (isProduction && !info.hasPassword) throw new RedisPasswordRequiredError();
  return url;
}
