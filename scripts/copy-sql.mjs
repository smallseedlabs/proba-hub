// tsc does not copy non-TS assets. The compiled migration runner
// (dist/db/migrate-cli.js) reads the .sql files next to itself, so copy them.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'src', 'db', 'migrations');
const to = join(root, 'dist', 'db', 'migrations');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log(`copied migrations to ${to}`);
