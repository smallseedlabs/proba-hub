import { pool } from '../db/client.js';
import { generatePassword, hashPassword } from './password.js';
import { normalizeEmail } from './tokens.js';

export interface CreateUserInput {
  email: string;
  name: string;
  /** Replace the password of an existing account instead of failing. */
  resetPassword?: boolean;
}

export interface CreateUserResult {
  user: { id: string; email: string; name: string };
  password: string;
  created: boolean;
}

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`A user with email ${email} already exists. Pass --reset-password to issue a new password.`);
    this.name = 'UserExistsError';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Create a password user with a freshly generated strong password, or reset the
 * password of an existing one. Resetting also revokes every existing session.
 */
export async function createUserWithPassword(input: CreateUserInput): Promise<CreateUserResult> {
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!EMAIL_RE.test(email)) throw new Error(`Invalid email: ${input.email}`);
  if (!name) throw new Error('Name is required');

  const password = generatePassword();
  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE LOWER(email) = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE',
      [email]
    );

    let row: { id: string; email: string; name: string };
    let created: boolean;
    if (existing.rows.length > 0) {
      if (!input.resetPassword) throw new UserExistsError(email);
      const updated = await client.query<{ id: string; email: string; name: string }>(
        'UPDATE users SET password_hash = $1, name = $2 WHERE id = $3 RETURNING id, email, name',
        [passwordHash, name, existing.rows[0].id]
      );
      await client.query('DELETE FROM sessions WHERE user_id = $1', [existing.rows[0].id]);
      row = updated.rows[0];
      created = false;
    } else {
      const inserted = await client.query<{ id: string; email: string; name: string }>(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
        [email, name, passwordHash]
      );
      row = inserted.rows[0];
      created = true;
    }
    await client.query('COMMIT');
    return { user: row, password, created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
