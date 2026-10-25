import { readFileSync } from 'node:fs';

export const DEV_JWT_SECRET = 'dev-secret-change-in-production';

export interface JwtSecretEnv {
  NODE_ENV?: string;
  JWT_SECRET?: string;
  JWT_SECRET_FILE?: string;
}

/**
 * Resolve the secret that signs Hub session tokens.
 *
 * `JWT_SECRET_FILE` (a Docker/Swarm secret mount such as /run/secrets/jwt_secret)
 * takes precedence over `JWT_SECRET`. In production the Hub refuses to start
 * when no secret is configured or when it is the development default.
 */
export function resolveJwtSecret(
  env: JwtSecretEnv = process.env,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string {
  const production = env.NODE_ENV === 'production';
  const filePath = env.JWT_SECRET_FILE?.trim();

  let secret = '';
  if (filePath) {
    try {
      secret = readFile(filePath).trim();
    } catch (err) {
      // Never include the file contents; the path alone is safe to report.
      throw new Error(`JWT_SECRET_FILE is set but could not be read (${filePath}): ${(err as Error).message}`);
    }
    if (!secret) throw new Error(`JWT_SECRET_FILE is set but the file is empty (${filePath})`);
  } else {
    secret = (env.JWT_SECRET ?? '').trim();
  }

  if (production) {
    if (!secret) {
      throw new Error('JWT_SECRET or JWT_SECRET_FILE must be set when NODE_ENV=production');
    }
    if (secret === DEV_JWT_SECRET) {
      throw new Error('The JWT secret is the development default; set a unique value when NODE_ENV=production');
    }
  }

  return secret || DEV_JWT_SECRET;
}
