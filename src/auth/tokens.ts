import { createHash } from 'node:crypto';

/** Sessions store a SHA-256 of the bearer token, never the token itself. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
