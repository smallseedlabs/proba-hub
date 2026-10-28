/**
 * Example requests and responses of the context-reader role, kept in
 * docs/contracts/context-reader/*.json for the context bridge.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { actAsAssertionClaimsSchema } from '@smallseedlabs/proba-protocol';

const DIR = fileURLToPath(new URL('../docs/contracts/context-reader/', import.meta.url));

const REQUIRED = [
  'act-as-assertion.claims.json',
  'service-token.claims.json',
  'goal-state.json',
  'thread-messages.json',
  'authorize.json',
  'error-act-as-required.json',
  'error-assertion-invalid.json',
  'error-goal-of-another-user.json',
  'error-route-not-allowed.json',
  'error-scope-mismatch.json',
  'error-scope-required.json',
];

describe('docs/contracts/context-reader', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

  it('lists the expected fixtures', () => {
    expect(files).toEqual([...REQUIRED].sort());
  });

  for (const file of files) {
    it(`${file} is valid JSON with a description`, () => {
      const example = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as {
        description?: string;
        claims?: unknown;
        request?: { method?: string; path?: string };
        response?: { status?: number };
      };
      expect(example.description?.length).toBeGreaterThan(10);
      if (file.startsWith('act-as')) {
        expect(actAsAssertionClaimsSchema.safeParse(example.claims).success).toBe(true);
      }
      if (file.startsWith('service-token')) {
        const c = example.claims as { iss: string; aud: string; sub: string };
        expect(c).toMatchObject({ iss: 'proba-context', aud: 'proba-hub', sub: 'context-reader' });
      }
      if (file.startsWith('error-') || ['goal-state.json', 'thread-messages.json', 'authorize.json'].includes(file)) {
        expect(example.request?.method).toMatch(/^(GET|POST)$/);
        expect(example.request?.path?.startsWith('/v1/')).toBe(true);
        expect(typeof example.response?.status).toBe('number');
      }
    });
  }
});
