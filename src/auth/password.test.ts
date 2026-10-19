import { describe, it, expect } from 'vitest';
import { generatePassword, hashPassword, verifyAgainstDummy, verifyPassword } from './password.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { hashToken, normalizeEmail } from './tokens.js';

// Cheap parameters keep the unit suite fast; production uses DEFAULT_SCRYPT_PARAMS.
const FAST = { N: 1024, r: 8, p: 1 };

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(hash.startsWith('scrypt$1024$8$1$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse battery stapl', hash)).resolves.toBe(false);
  });

  it('uses a random salt per hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same', FAST), hashPassword('same', FAST)]);
    expect(a).not.toBe(b);
  });

  it('verifies hashes made with the default (production) parameters', async () => {
    const hash = await hashPassword('pw-default-params');
    expect(hash.startsWith('scrypt$65536$8$1$')).toBe(true);
    await expect(verifyPassword('pw-default-params', hash)).resolves.toBe(true);
  });

  it('returns false for malformed or tampered hashes', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$whatever')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$999999999$8$1$c2FsdA$aGFzaA')).resolves.toBe(false);
  });

  it('rejects empty passwords when hashing', async () => {
    await expect(hashPassword('', FAST)).rejects.toThrow();
  });

  it('dummy verification always fails', async () => {
    await expect(verifyAgainstDummy('anything')).resolves.toBe(false);
  });
});

describe('generatePassword', () => {
  it('generates long, distinct passwords', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).toHaveLength(24);
    expect(a).not.toBe(b);
    expect(generatePassword(32)).toHaveLength(32);
  });

  it('refuses weak lengths', () => {
    expect(() => generatePassword(8)).toThrow();
  });
});

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
