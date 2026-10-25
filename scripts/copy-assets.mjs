// tsc does not copy non-TS assets. Copy what the compiled app reads at runtime so
// that `npm run build` produces a complete dist/ (also outside Docker):
//  - dist/db/migrations/*.sql   read by dist/db/migrate-cli.js
//  - dist/brain/scenarios/*.yaml read by the mock brain
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const [from, to] of [
  [join('src', 'db', 'migrations'), join('dist', 'db', 'migrations')],
  [join('src', 'brain', 'scenarios'), join('dist', 'brain', 'scenarios')],
]) {
  mkdirSync(join(root, to), { recursive: true });
  cpSync(join(root, from), join(root, to), { recursive: true });
  console.log(`copied ${from} to ${to}`);
}
