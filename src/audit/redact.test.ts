import { describe, expect, it } from 'vitest';
import { maskSecretsInText, redactDetails, redactString } from './redact.js';

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

describe('maskSecretsInText (raw text of AuditEvent.content)', () => {
  it('keeps ordinary text including emails and phones when pii is off (default)', () => {
    const text = 'Hi Jane Doe (jane@example.com), launch the spring campaign with £1,500 daily; call +44 20 7946 0958. The token is expired, right?';
    expect(maskSecretsInText(text)).toEqual({ text, redactions: 0 });
  });

  it('masks emails, phone numbers and valid IBANs when pii is on', () => {
    const out = maskSecretsInText(
      'Email jane@example.com, call +44 20 7946 0958, IBAN GB82WEST12345698765432 please.',
      { pii: true }
    );
    expect(out.text).toBe(
      'Email [REDACTED:email], call [REDACTED:phone], IBAN [REDACTED:iban] please.'
    );
    expect(out.redactions).toBe(3);
  });

  it('does not treat dates or invalid IBANs as phone/iban when pii is on', () => {
    expect(maskSecretsInText('Due 2026-10-26 and XX00NOTANIBAN', { pii: true }).redactions).toBe(0);
  });

  it('masks passwords, labelled and spoken, keeping the label', () => {
    expect(maskSecretsInText('password: hunter2 ok')).toEqual({ text: 'password: [REDACTED] ok', redactions: 1 });
    expect(maskSecretsInText('my password is hunter2, thanks')).toEqual({ text: 'my password is [REDACTED], thanks', redactions: 1 });
    expect(maskSecretsInText('PASSWD="correct horse battery"').text).toBe('PASSWD=[REDACTED]');
    expect(maskSecretsInText('pin = 4821').text).toBe('pin = [REDACTED]');
  });

  it('masks tokens: bearer, JWT, query parameters, labelled', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxIn0.c2lnbmF0dXJl';
    const out = maskSecretsInText(`Authorization: Bearer abc.def-ghi_123 and ${jwt} and /x?token=zzz999&y=1 and access_token: qwe123`);
    expect(out.text).toBe('Authorization: Bearer [REDACTED] and [REDACTED_TOKEN] and /x?token=[REDACTED]&y=1 and access_token: [REDACTED]');
    expect(out.redactions).toBe(4);
  });

  it('masks API keys by prefix and by label', () => {
    const out = maskSecretsInText(
      'stripe sk_live_51HabcdEFGHijklMNOPqrst, github ghp_abcdefghijklmnopqrstuvwxyz0123456789, aws AKIAIOSFODNN7EXAMPLE, slack xoxb-1234567890-abcdefghij, api_key=abcd1234'
    );
    expect(out.text).toBe('stripe [REDACTED_KEY], github [REDACTED_KEY], aws [REDACTED_KEY], slack [REDACTED_KEY], api_key=[REDACTED]');
    expect(out.redactions).toBe(5);
  });

  it('masks private key blocks', () => {
    const out = maskSecretsInText('key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nthanks');
    expect(out.text).toBe('key:\n[REDACTED_PRIVATE_KEY]\nthanks');
    expect(out.redactions).toBe(1);
  });

  it('masks payment card numbers that pass the Luhn check, with or without separators', () => {
    expect(maskSecretsInText('card 4111 1111 1111 1111 exp 12/29').text).toBe('card [REDACTED_CARD] exp 12/29');
    expect(maskSecretsInText('4242-4242-4242-4242').text).toBe('[REDACTED_CARD]');
    expect(maskSecretsInText('5555555555554444').redactions).toBe(1);
  });

  it('keeps long numbers that are not cards', () => {
    expect(maskSecretsInText('order 1234567890123456 and budget 25000000000000').redactions).toBe(0);
    expect(maskSecretsInText('1234 5678').text).toBe('1234 5678');
  });

  it('returns an empty text for a non-string and never throws', () => {
    expect(maskSecretsInText(undefined)).toEqual({ text: '', redactions: 0 });
    expect(maskSecretsInText({ a: 1 })).toEqual({ text: '', redactions: 0 });
    expect(() => maskSecretsInText('x'.repeat(200_000))).not.toThrow();
  });
});
