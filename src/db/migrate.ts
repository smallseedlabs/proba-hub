import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool, query } from './client.js';
import { logger } from '../logger.js';

/** Resolved next to this file, so it works from src/ (tsx) and from dist/ (the compiled image). */
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Arbitrary constant: pg_advisory_lock key for the Hub migration runner. */
const MIGRATION_LOCK_KEY = 727274001;

export interface Migration {
  id: number;
  name: string;
  file: string;
}

export const migrations: Migration[] = [
  { id: 1, name: 'initial_schema', file: '001_initial_schema.sql' },
  { id: 2, name: 'password_auth', file: '002_password_auth.sql' },
  { id: 3, name: 'firebase_auth', file: '003_firebase_auth.sql' },
  { id: 4, name: 'audit_outbox', file: '004_audit_outbox.sql' },
  { id: 5, name: 'execution_state', file: '005_execution_state.sql' },
];

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(): Promise<Set<number>> {
  const result = await query<{ id: number }>('SELECT id FROM migrations ORDER BY id');
  return new Set(result.rows.map(row => row.id));
}

async function applyMigration(migration: Migration): Promise<void> {
  const filePath = join(__dirname, 'migrations', migration.file);
  const sql = await readFile(filePath, 'utf-8');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO migrations (id, name) VALUES ($1, $2)',
      [migration.id, migration.name]
    );
    await client.query('COMMIT');
    logger.info({ migrationId: migration.id, name: migration.name }, 'Migration applied');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Apply every pending migration in order. Safe to call repeatedly (applied ids are
 * recorded in `migrations`). Does not close the pool; the CLI entry point does.
 */
export async function runMigrations(): Promise<{ applied: number[] }> {
  // Serialize concurrent runners (e.g. a one-shot job racing a manual run).
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    return await applyPending();
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}

async function applyPending(): Promise<{ applied: number[] }> {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const pending = migrations.filter(m => !applied.has(m.id));

  if (pending.length === 0) {
    logger.info('No pending migrations');
    return { applied: [] };
  }

  logger.info({ count: pending.length }, 'Applying migrations');

  for (const migration of pending) {
    await applyMigration(migration);
  }

  logger.info('All migrations applied successfully');
  return { applied: pending.map(m => m.id) };
}
