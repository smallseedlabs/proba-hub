import type { PoolClient } from 'pg';
import { pool } from '../db/client.js';
import type { FirebaseIdentity } from './firebase.js';
import { normalizeEmail } from './tokens.js';

export interface HubUser {
  id: string;
  email: string;
  name: string;
}

export type UserResolutionErrorCode = 'email_required' | 'email_not_verified' | 'account_conflict' | 'not_allowed';

export class UserResolutionError extends Error {
  constructor(
    readonly code: UserResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'UserResolutionError';
  }
}

export interface ResolveUserOptions {
  /** Lower-case email domains allowed to sign in. Empty = any Firebase user. */
  allowedEmailDomains?: readonly string[];
}

function displayName(identity: FirebaseIdentity, email: string): string {
  return (identity.name ?? email.split('@')[0]).slice(0, 255);
}

function checkAllowed(identity: FirebaseIdentity, email: string, opts: ResolveUserOptions): void {
  const domains = opts.allowedEmailDomains ?? [];
  if (domains.length === 0) return;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!identity.emailVerified || !domains.includes(domain)) {
    throw new UserResolutionError('not_allowed', 'This account is not allowed to sign in to this workspace.');
  }
}

const RETURNING = 'RETURNING id, email, name';

/**
 * Find or create the Hub user for a verified Firebase identity.
 *
 * 1. A user already linked to this Firebase uid is updated with the latest
 *    email, display name and verification state.
 * 2. Otherwise an existing, unlinked user with the same email is linked, but
 *    only when Firebase says the email is verified (an unverified email proves
 *    nothing about who owns it).
 * 3. Otherwise a new user is created.
 */
export async function resolveFirebaseUser(
  identity: FirebaseIdentity,
  opts: ResolveUserOptions = {}
): Promise<HubUser> {
  try {
    return await resolveOnce(identity, opts);
  } catch (error) {
    // Two first sign-ins racing: one insert wins, the retry finds its row.
    if ((error as { code?: string }).code === '23505') return resolveOnce(identity, opts);
    throw error;
  }
}

async function resolveOnce(identity: FirebaseIdentity, opts: ResolveUserOptions): Promise<HubUser> {
  if (!identity.email) {
    throw new UserResolutionError('email_required', 'This account has no email address.');
  }
  const email = normalizeEmail(identity.email);
  checkAllowed(identity, email, opts);
  const name = displayName(identity, email);

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const linked = await client.query<HubUser>('SELECT id FROM users WHERE firebase_uid = $1 FOR UPDATE', [
      identity.uid,
    ]);

    // Another row owning this email (unlinked or linked to a different uid).
    const byEmail = await client.query<{ id: string; firebaseUid: string | null }>(
      `SELECT id, firebase_uid as "firebaseUid" FROM users
       WHERE LOWER(email) = $1 AND (firebase_uid IS NULL OR firebase_uid <> $2)
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
      [email, identity.uid]
    );
    const other = byEmail.rows[0];

    let user: HubUser;
    if (linked.rows.length > 0) {
      if (other) {
        throw new UserResolutionError('account_conflict', 'Another account already uses this email address.');
      }
      const updated = await client.query<HubUser>(
        `UPDATE users SET email = $2, name = $3, email_verified = $4, last_sign_in_at = NOW(), updated_at = NOW()
         WHERE id = $1 ${RETURNING}`,
        [linked.rows[0].id, email, name, identity.emailVerified]
      );
      user = updated.rows[0];
    } else if (other) {
      if (other.firebaseUid !== null) {
        throw new UserResolutionError('account_conflict', 'Another account already uses this email address.');
      }
      if (!identity.emailVerified) {
        throw new UserResolutionError(
          'email_not_verified',
          'Verify your email address to sign in to your existing account.'
        );
      }
      const updated = await client.query<HubUser>(
        `UPDATE users SET firebase_uid = $2, email = $3, email_verified = TRUE, last_sign_in_at = NOW(), updated_at = NOW()
         WHERE id = $1 ${RETURNING}`,
        [other.id, identity.uid, email]
      );
      user = updated.rows[0];
    } else {
      const inserted = await client.query<HubUser>(
        `INSERT INTO users (firebase_uid, email, name, email_verified, last_sign_in_at)
         VALUES ($1, $2, $3, $4, NOW()) ${RETURNING}`,
        [identity.uid, email, name, identity.emailVerified]
      );
      user = inserted.rows[0];
    }

    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
