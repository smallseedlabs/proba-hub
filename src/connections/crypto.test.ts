import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectionAad, createTokenCipher, loadTokenCipher } from './crypto.js';

describe('refresh-token encryption at rest', () => {
  const cipher = createTokenCipher(randomBytes(32));

  it('round-trips and never contains the plaintext', () => {
    const aad = connectionAad('ws', 'reddit', 'c1');
    const enc = cipher.encrypt('refresh-secret-value', aad);
    expect(enc).not.toContain('refresh-secret-value');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(cipher.decrypt(enc, aad)).toBe('refresh-secret-value');
    expect(cipher.encrypt('refresh-secret-value', aad)).not.toBe(enc);
  });

  it('refuses another workspace, provider or connection (additional data binding)', () => {
    const enc = cipher.encrypt('x', connectionAad('ws', 'reddit', 'c1'));
    expect(() => cipher.decrypt(enc, connectionAad('other', 'reddit', 'c1'))).toThrow();
    expect(() => cipher.decrypt(enc, connectionAad('ws', 'meta', 'c1'))).toThrow();
    expect(() => cipher.decrypt(enc, connectionAad('ws', 'reddit', 'c2'))).toThrow();
  });

  it('refuses another key', () => {
    const enc = cipher.encrypt('x', 'aad');
    expect(() => createTokenCipher(randomBytes(32)).decrypt(enc, 'aad')).toThrow();
  });

  it('loads a 64-hex key file and rejects bad ones (production: absolute, mode 600)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conn-key-'));
    const good = join(dir, 'k');
    writeFileSync(good, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    expect(loadTokenCipher(good, 'production').keyId).toHaveLength(12);
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'short', { mode: 0o600 });
    expect(() => loadTokenCipher(bad, 'development')).toThrow(/64 hex/);
    const open = join(dir, 'open');
    writeFileSync(open, randomBytes(32).toString('hex'), { mode: 0o644 });
    expect(() => loadTokenCipher(open, 'production')).toThrow(/chmod 600/);
    expect(() => loadTokenCipher('relative/key', 'production')).toThrow(/absolute/);
  });
});
