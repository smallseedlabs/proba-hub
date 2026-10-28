import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { exportJWK, type JWK } from 'jose';

/**
 * Loads the Hub's Ed25519 assertion signing key from HUB_ASSERTION_PRIVATE_KEY_FILE
 * (PKCS#8 PEM). Production requires an absolute path outside the OS temp directory,
 * a file mode that is not group/other-writable, and refuses world/group-readable
 * private material when the platform supports mode bits.
 */

export class PrivateKeyFileError extends Error {
  constructor(
    readonly envName: string,
    detail: string
  ) {
    super(`${envName}: ${detail}`);
    this.name = 'PrivateKeyFileError';
  }
}

export interface AssertionSigningKey {
  kid: string;
  privateKey: KeyObject;
  /** Public JWK for the signing key (no private members). */
  publicJwk: JWK;
}

export interface LoadPrivateKeyOptions {
  envName?: string;
  kid: string;
  nodeEnv: string;
}

function isUnderTempDir(file: string): boolean {
  const abs = resolvePath(file);
  const temp = resolvePath(tmpdir());
  return abs === temp || abs.startsWith(`${temp}/`) || abs.startsWith('/tmp/') || abs.startsWith('/var/folders/');
}

export async function loadAssertionPrivateKey(file: string, options: LoadPrivateKeyOptions): Promise<AssertionSigningKey> {
  const envName = options.envName ?? 'HUB_ASSERTION_PRIVATE_KEY_FILE';
  if (file.trim() === '') throw new PrivateKeyFileError(envName, 'no file is configured');
  if (options.kid.trim() === '') throw new PrivateKeyFileError(envName, 'HUB_ASSERTION_KEY_ID is required when a private key is configured');

  const production = options.nodeEnv === 'production';
  if (production && !isAbsolute(file)) {
    throw new PrivateKeyFileError(envName, 'must be an absolute path when NODE_ENV=production');
  }
  if (production && isUnderTempDir(file)) {
    throw new PrivateKeyFileError(
      envName,
      'a locally generated key under a temporary directory is not allowed when NODE_ENV=production'
    );
  }

  let pem: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new PrivateKeyFileError(envName, `${file} is not a file`);
    if (production && process.platform !== 'win32') {
      if ((info.mode & 0o022) !== 0) {
        throw new PrivateKeyFileError(envName, `${file} is writable by group or others; run chmod go-w on it`);
      }
      if ((info.mode & 0o077) !== 0) {
        throw new PrivateKeyFileError(envName, `${file} must not be readable by group or others; run chmod 600 on it`);
      }
    }
    pem = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof PrivateKeyFileError) throw err;
    throw new PrivateKeyFileError(envName, `cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }

  if (!/BEGIN (?:PRIVATE KEY|OKP PRIVATE KEY|ED25519 PRIVATE KEY)/.test(pem)) {
    throw new PrivateKeyFileError(envName, `${file} is not a PKCS#8 PEM private key`);
  }

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (err) {
    throw new PrivateKeyFileError(envName, `cannot parse ${file}: ${(err as Error).message}`);
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new PrivateKeyFileError(envName, `${file} must be an Ed25519 key`);
  }

  const publicJwk = {
    ...(await exportJWK(createPublicKey(privateKey))),
    kid: options.kid,
    alg: 'EdDSA',
    use: 'sig',
  };
  return { kid: options.kid, privateKey, publicJwk };
}
