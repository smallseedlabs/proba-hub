/**
 * Create a Proba Hub user with a generated strong password.
 *
 *   npm run user:create -- --email ana@example.com --name "Ana Example"
 *   npm run user:create -- --email ana@example.com --name "Ana" --reset-password
 *   npm run user:create -- --email ana@example.com --name "Ana" --password-file ./login.txt
 *
 * The password is printed exactly once (or written to --password-file with
 * mode 0600 instead of being printed). It is never logged or stored in clear.
 */
import { writeFile, chmod } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pool } from '../db/client.js';
import { createUserWithPassword, UserExistsError } from '../auth/users.js';

function usage(): never {
  console.error('Usage: npm run user:create -- --email <email> --name <name> [--reset-password] [--password-file <path>]');
  process.exit(2);
}

async function main(): Promise<void> {
  let values: { email?: string; name?: string; 'reset-password'?: boolean; 'password-file'?: string };
  try {
    ({ values } = parseArgs({
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
        'reset-password': { type: 'boolean', default: false },
        'password-file': { type: 'string' },
      },
      strict: true,
    }));
  } catch {
    usage();
  }
  if (!values.email || !values.name) usage();

  try {
    const result = await createUserWithPassword({
      email: values.email,
      name: values.name,
      resetPassword: values['reset-password'],
    });
    const verb = result.created ? 'Created' : 'Reset password for';
    const out = process.stdout;

    if (values['password-file']) {
      const path = values['password-file'];
      const content = `Proba sign-in\nemail: ${result.user.email}\npassword: ${result.password}\n`;
      await writeFile(path, content, { mode: 0o600 });
      await chmod(path, 0o600);
      out.write(`${verb} user ${result.user.email} (${result.user.id}).\nPassword written to ${path} (mode 600).\n`);
    } else {
      out.write(
        `${verb} user ${result.user.email} (${result.user.id}).\n\n` +
          `  Password: ${result.password}\n\n` +
          'This password is shown only once. Store it in a password manager now.\n'
      );
    }
  } catch (error) {
    if (error instanceof UserExistsError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      console.error('Failed to create user:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

await main();
