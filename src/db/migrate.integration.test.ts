import { describe, expect, it } from 'vitest';
import { pool } from './client.js';
import { migrations, runMigrations } from './migrate.js';

describe('runMigrations (real Postgres)', () => {
  it('is idempotent and safe to run concurrently (advisory lock)', async () => {
    await runMigrations();
    const [a, b] = await Promise.all([runMigrations(), runMigrations()]);
    expect(a.applied).toEqual([]);
    expect(b.applied).toEqual([]);
    const applied = await pool.query<{ id: number }>('SELECT id FROM migrations ORDER BY id');
    expect(applied.rows.map((r) => r.id)).toEqual(migrations.map((m) => m.id));
  });

  it('creates the audit_outbox table with the proba-audit schema and its relay indexes', async () => {
    const cols = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'audit_outbox' ORDER BY ordinal_position"
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'id', 'event_id', 'payload', 'created_at', 'locked_until', 'attempts', 'last_error', 'published_at',
    ]);
    expect(cols.rows.find((c) => c.column_name === 'payload')).toMatchObject({ data_type: 'jsonb', is_nullable: 'NO' });
    const idx = await pool.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE tablename = 'audit_outbox'");
    expect(idx.rows.map((i) => i.indexname)).toEqual(
      expect.arrayContaining(['audit_outbox_pkey', 'audit_outbox_event_id_key', 'audit_outbox_pending_idx', 'audit_outbox_published_idx'])
    );
  });

  it('applies 004 on top of an existing 001-003 database with data, without touching it', async () => {
    // Upgrade path: a Hub database that predates the audit outbox. Rewind the bookkeeping
    // and drop only the new table, keep users/threads/events, then migrate again.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM events)::int AS events');
      await client.query('DROP TABLE audit_outbox');
      await client.query('DELETE FROM migrations WHERE id = 4');
      await client.query('COMMIT');

      const result = await runMigrations();
      expect(result.applied).toEqual([4]);
      const after = await client.query('SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM events)::int AS events');
      expect(after.rows[0]).toEqual(before.rows[0]);
      const empty = await client.query('SELECT count(*)::int AS n FROM audit_outbox');
      expect(empty.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });
});
