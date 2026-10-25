import { describe, expect, it } from 'vitest';
import { DEV_JWT_SECRET, resolveJwtSecret } from './jwt-secret.js';

const reader = (files: Record<string, string>) => (p: string) => {
  if (!(p in files)) throw new Error(`ENOENT: ${p}`);
  return files[p];
};

describe('resolveJwtSecret', () => {
  it('falls back to the dev default outside production', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'development' })).toBe(DEV_JWT_SECRET);
    expect(resolveJwtSecret({})).toBe(DEV_JWT_SECRET);
  });

  it('reads JWT_SECRET', () => {
    expect(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'from-env-secret' })).toBe('from-env-secret');
  });

  it('prefers JWT_SECRET_FILE over JWT_SECRET and trims the trailing newline', () => {
    const secret = resolveJwtSecret(
      { NODE_ENV: 'production', JWT_SECRET: 'from-env', JWT_SECRET_FILE: '/run/secrets/jwt_secret' },
      reader({ '/run/secrets/jwt_secret': 'from-file\n' }),
    );
    expect(secret).toBe('from-file');
  });

  it('fails fast when the secret file cannot be read or is empty', () => {
    expect(() =>
      resolveJwtSecret({ JWT_SECRET: 'x'.repeat(20), JWT_SECRET_FILE: '/missing' }, reader({})),
    ).toThrow(/could not be read/);
    expect(() => resolveJwtSecret({ JWT_SECRET_FILE: '/empty' }, reader({ '/empty': '\n' }))).toThrow(/empty/);
  });

  it('fails fast in production without a secret', () => {
    expect(() => resolveJwtSecret({ NODE_ENV: 'production' })).toThrow(/must be set/);
    expect(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: '  ' })).toThrow(/must be set/);
  });

  it('fails fast in production when the secret is the dev default (env or file)', () => {
    expect(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: DEV_JWT_SECRET })).toThrow(/development default/);
    expect(() =>
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET_FILE: '/s' }, reader({ '/s': DEV_JWT_SECRET })),
    ).toThrow(/development default/);
  });

  it('never leaks the secret in error messages', () => {
    try {
      resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET_FILE: '/s' }, reader({ '/s': DEV_JWT_SECRET }));
    } catch (e) {
      expect((e as Error).message).not.toContain(DEV_JWT_SECRET);
    }
  });
});
