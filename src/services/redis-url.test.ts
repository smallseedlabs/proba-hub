import { describe, expect, it } from 'vitest';
import {
  assertRedisUrl,
  InvalidRedisUrlError,
  parseRedisUrl,
  RedisPasswordRequiredError,
} from './redis-url.js';

describe('parseRedisUrl', () => {
  it('reads scheme, user and whether a password is present, never the password', () => {
    expect(parseRedisUrl('redis://proba:s3cret@redis:6379')).toEqual({
      tls: false,
      username: 'proba',
      hasPassword: true,
      host: 'redis',
    });
    expect(parseRedisUrl('rediss://:s3cret@cache.example.com:6380')).toMatchObject({ tls: true, username: '', hasPassword: true });
    expect(parseRedisUrl('redis://localhost:6379').hasPassword).toBe(false);
    expect(parseRedisUrl('redis://proba:@localhost:6379').hasPassword).toBe(false);
  });

  it('refuses anything that is not a redis:// or rediss:// URL', () => {
    expect(() => parseRedisUrl('http://redis:6379')).toThrow(InvalidRedisUrlError);
    expect(() => parseRedisUrl('not a url')).toThrow(InvalidRedisUrlError);
  });
});

describe('assertRedisUrl', () => {
  it('production requires a password', () => {
    expect(() => assertRedisUrl('redis://redis:6379', true)).toThrow(RedisPasswordRequiredError);
    expect(() => assertRedisUrl('redis://proba:@redis:6379', true)).toThrow(RedisPasswordRequiredError);
    expect(assertRedisUrl('redis://proba:pw@redis:6379', true)).toBe('redis://proba:pw@redis:6379');
    expect(assertRedisUrl('rediss://proba:pw@redis:6380', true)).toBe('rediss://proba:pw@redis:6380');
  });

  it('other environments accept a URL without a password (local tests, CI service containers)', () => {
    expect(assertRedisUrl('redis://localhost:6379', false)).toBe('redis://localhost:6379');
  });

  it('the error message never contains the password', () => {
    try {
      assertRedisUrl('http://u:topsecret@redis:6379', true);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('topsecret');
    }
  });
});
