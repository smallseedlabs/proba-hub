import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadPublicKeySet } from '../src/auth/assertions/public-key-set.js';

const script = resolve(__dirname, 'generate-assertion-keypair.mjs');
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('generate-assertion-keypair', () => {
  it('writes a private key for the Hub and a public JWKS verifiers accept', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'proba-hub-keygen-')), 'keys');
    const result = run('--kid', 'hub-key-1', '--out', dir);
    expect(result.status).toBe(0);

    const pem = join(dir, 'hub-key-1.private.pem');
    const jwks = join(dir, 'hub-key-1.jwks.json');
    expect(statSync(pem).mode & 0o077).toBe(0);
    expect(readFileSync(jwks, 'utf8')).not.toContain('"d"');

    const set = await loadPublicKeySet(jwks, { envName: 'HUB_ASSERTION_PUBLIC_KEY_FILE', nodeEnv: 'test' });
    expect(set.keyIds).toEqual(['hub-key-1']);

    const token = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'hub-key-1' })
      .sign(createPrivateKey(readFileSync(pem)));
    const verified = await jwtVerify(token, set.keys);
    expect(verified.payload.sub).toBe('user-1');
  });

  it('refuses to replace a key unless asked, and refuses a bad kid or missing arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proba-hub-keygen-'));
    expect(run('--kid', 'k1', '--out', dir).status).toBe(0);
    expect(run('--kid', 'k1', '--out', dir).status).toBe(1);
    expect(run('--kid', 'k1', '--out', dir, '--force').status).toBe(0);
    expect(run('--kid', '../x', '--out', dir).status).toBe(2);
    expect(run('--out', dir).status).toBe(2);
  });
});
