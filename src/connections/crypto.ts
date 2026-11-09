import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/**
 * At-rest encryption for provider refresh tokens: AES-256-GCM with a 32-byte key read
 * from a mounted file (64 hex characters, e.g. `openssl rand -hex 32`). The additional
 * data binds a ciphertext to its workspace, provider and connection, so a row copied to
 * another workspace or connection does not decrypt. The key is never logged.
 */

export class ConnectionKeyError extends Error {
  constructor(detail: string) {
    super(`HUB_CONNECTIONS_KEY_FILE: ${detail}`);
    this.name = 'ConnectionKeyError';
  }
}

export interface TokenCipher {
  /** Short fingerprint of the key (not the key): stored with each row to detect a key change. */
  readonly keyId: string;
  encrypt(plaintext: string, aad: string): string;
  decrypt(ciphertext: string, aad: string): string;
}

const VERSION = 'v1';

export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== 32) throw new ConnectionKeyError('the key must be 32 bytes (64 hex characters)');
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 12);
  return {
    keyId,
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(ciphertext, aad) {
      const parts = ciphertext.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unsupported ciphertext format');
      const [, iv, tag, ct] = parts as [string, string, string, string];
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

/** Read the key file. Production: absolute path, not readable by group or others. */
export function loadTokenCipher(file: string, nodeEnv: string): TokenCipher {
  const production = nodeEnv === 'production';
  if (production && !isAbsolute(file)) throw new ConnectionKeyError('must be an absolute path when NODE_ENV=production');
  let text: string;
  try {
    const info = statSync(file);
    if (!info.isFile()) throw new ConnectionKeyError(`${file} is not a file`);
    if (production && process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new ConnectionKeyError(`${file} is readable by group or others; run chmod 600 on it`);
    }
    text = readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (err instanceof ConnectionKeyError) throw err;
    throw new ConnectionKeyError(`cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!/^[0-9a-fA-F]{64}$/.test(text)) throw new ConnectionKeyError('the file must hold 64 hex characters (openssl rand -hex 32)');
  return createTokenCipher(Buffer.from(text, 'hex'));
}

export function connectionAad(workspaceId: string, provider: string, connectionId: string): string {
  return `proba-connection|${workspaceId}|${provider}|${connectionId}`;
}
