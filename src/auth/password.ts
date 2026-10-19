import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with node:crypto scrypt (memory-hard, no native deps).
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>` so the
 * cost parameters can be raised later without invalidating existing hashes.
 */

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** ~64 MiB per hash (128 * N * r). OWASP-compatible scrypt cost. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 16, r: 8, p: 1 };

function scrypt(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    // Must exceed 128 * N * r; leave headroom.
    maxmem: 256 * params.N * params.r,
  };
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEY_LENGTH, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map((v) => Number.parseInt(v, 10));
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return null;
  // Refuse absurd parameters from a tampered row (DoS guard).
  if (N > 2 ** 20 || r > 32 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || hash.length === 0) return null;
  return { params: { N, r, p }, salt, hash };
}

/** Constant-time verification. Returns false for malformed hashes instead of throwing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  const candidate = await scrypt(password, parsed.salt, parsed.hash.length, parsed.params);
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

let dummyHash: Promise<string> | null = null;

/**
 * Burn the same work as a real verification. Used when the email is unknown or
 * has no password so response timing does not reveal which accounts exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
  return false;
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%+=';

/** Generate a strong random password (default 24 chars, ~145 bits of entropy). */
export function generatePassword(length = 24): string {
  if (length < 16) throw new Error('Generated passwords must be at least 16 characters');
  const out: string[] = [];
  // Rejection sampling avoids modulo bias.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit) out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}
