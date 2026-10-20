import { describe, it, expect } from 'vitest';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { hashToken, normalizeEmail } from './tokens.js';

describe('tokens', () => {
  it('hashes tokens to sha256 hex', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('normalizes emails', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
  });
});

describe('FixedWindowRateLimiter', () => {
  it('blocks after max hits and resets after the window', () => {
    let now = 0;
    const limiter = new FixedWindowRateLimiter({ max: 2, windowMs: 1000, now: () => now });
    expect(limiter.retryAfter('k')).toBe(0);
    limiter.hit('k');
    limiter.hit('k');
    expect(limiter.retryAfter('k')).toBe(1);
    now = 1001;
    expect(limiter.retryAfter('k')).toBe(0);
  });

  it('reset clears the key', () => {
    const limiter = new FixedWindowRateLimiter({ max: 1, windowMs: 60_000 });
    limiter.hit('k');
    expect(limiter.retryAfter('k')).toBeGreaterThan(0);
    limiter.reset('k');
    expect(limiter.retryAfter('k')).toBe(0);
  });
});
