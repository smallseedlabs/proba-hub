/**
 * Migration entry point: `npm run migrate` (tsx, development) or
 * `node dist/db/migrate-cli.js` (compiled, production image; needs no tsx).
 */
import { pool } from './client.js';
import { runMigrations } from './migrate.js';
import { logger } from '../logger.js';

try {
  await runMigrations();
  await pool.end();
} catch (error) {
  logger.error({ err: error }, 'Migration failed');
  await pool.end().catch(() => undefined);
  process.exit(1);
}
