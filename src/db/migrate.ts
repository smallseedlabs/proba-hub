import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool, query } from './client.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Migration {
  id: number;
  name: string;
  file: string;
}

const migrations: Migration[] = [
  { id: 1, name: 'initial_schema', file: '001_initial_schema.sql' }
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

async function migrate(): Promise<void> {
  try {
    await ensureMigrationsTable();
    const applied = await getAppliedMigrations();
    
    const pending = migrations.filter(m => !applied.has(m.id));
    
    if (pending.length === 0) {
      logger.info('No pending migrations');
      return;
    }
    
    logger.info({ count: pending.length }, 'Applying migrations');
    
    for (const migration of pending) {
      await applyMigration(migration);
    }
    
    logger.info('All migrations applied successfully');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    throw error;
  } finally {
    await pool.end();
  }
}

migrate();
