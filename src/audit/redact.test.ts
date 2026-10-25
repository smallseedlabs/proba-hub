import { describe, expect, it } from 'vitest';
import { redactDetails, redactString } from './redact.js';

describe('redactString', () => {
  it('masks emails, bearer tokens, JWTs and token query params', () => {
    expect(redactString('contact jane.doe+x@example.co.uk now')).toBe('contact [REDACTED_EMAIL] now');
    expect(redactString('Authorization: Bearer abc.def-ghi_123')).toContain('Bearer [REDACTED]');
    expect(redactString('Authorization: Bearer abc.def-ghi_123')).not.toContain('abc.def');
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxIn0.c2lnbmF0dXJl';
    expect(redactString(`token ${jwt} end`)).toBe('token [REDACTED_TOKEN] end');
    expect(redactString('/v1/events?after=1&token=secret123&x=1')).toBe('/v1/events?after=1&token=[REDACTED]&x=1');
  });

  it('caps the length', () => {
    expect(redactString('x'.repeat(1000), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('redactDetails', () => {
  it('redacts secret and personal keys at any depth, keeps ids and numbers', () => {
    const out = redactDetails({
      userId: 'u-1',
      count: 3,
      ok: true,
      token: 'abc',
      nested: { Authorization: 'Bearer x', apiKey: 'k', email: 'a@b.co', keep: 'fine', list: [{ password: 'p', n: 1 }] },
      idToken: 'firebase',
      jwtSecret: 's',
      cookie: 'c',
      displayName: 'Jane',
      ip: '10.0.0.1',
    });
    expect(out).toEqual({
      userId: 'u-1',
      count: 3,
      ok: true,
      token: '[REDACTED]',
      nested: {
        Authorization: '[REDACTED]',
        apiKey: '[REDACTED]',
        email: '[REDACTED]',
        keep: 'fine',
        list: [{ password: '[REDACTED]', n: 1 }],
      },
      idToken: '[REDACTED]',
      jwtSecret: '[REDACTED]',
      cookie: '[REDACTED]',
      displayName: '[REDACTED]',
      ip: '[REDACTED]',
    });
  });

  it('masks emails and tokens hidden inside string values', () => {
    const out = redactDetails({ reason: 'user bob@example.com sent Bearer abc123' });
    expect(JSON.stringify(out)).not.toContain('bob@example.com');
    expect(JSON.stringify(out)).not.toContain('abc123');
  });

  it('bounds depth, arrays and keys, and survives cycles, bigint, dates and errors', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = redactDetails(
      {
        cyclic,
        big: 10n,
        when: new Date('2026-01-02T03:04:05.000Z'),
        err: new Error('mail me at x@y.com'),
        arr: Array.from({ length: 100 }, (_, i) => i),
        deep: { a: { b: { c: { d: { e: { f: 1 } } } } } },
        fn: () => 1,
      },
      { maxArrayLength: 3 }
    );
    expect(out.cyclic).toEqual({ a: 1, self: '[Circular]' });
    expect(out.big).toBe('10');
    expect(out.when).toBe('2026-01-02T03:04:05.000Z');
    expect(out.err).toBe('mail me at [REDACTED_EMAIL]');
    expect(out.arr).toEqual([0, 1, 2, '[+97 more]']);
    expect(JSON.stringify(out.deep)).toContain('[Truncated]');
    expect('fn' in out).toBe(false);
  });

  it('returns an empty object for non-objects', () => {
    expect(redactDetails(undefined)).toEqual({});
    expect(redactDetails('x')).toEqual({});
    expect(redactDetails([1, 2])).toEqual({});
  });
});
