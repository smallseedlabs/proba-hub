import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrations } from './migrate.js';

describe('migration list', () => {
  it('has contiguous ids and lists every .sql file exactly once (so none is forgotten or missing from dist/)', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(migrations.map((m) => m.file)).toEqual(files);
    expect(migrations.map((m) => m.id)).toEqual(files.map((_, i) => i + 1));
    expect(migrations.find((m) => m.name === 'audit_outbox')?.file).toBe('004_audit_outbox.sql');
  });
});
