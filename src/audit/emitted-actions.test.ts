import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTION_INFO, AUDIT_ACTIONS } from '@smallseedlabs/proba-protocol/audit';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOMAINS = Object.keys(AUDIT_ACTIONS);

/** Production sources: no tests, no vendored proba-audit code. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Every string literal in the Hub's code that is shaped like an audit action of a
 * catalog domain ('goal.created', 'control.paused', ...). This sees `action: '...'`
 * as well as ternaries and lookup tables. service.ts is skipped: it only *lists*
 * the generic and alias names (to forbid them).
 */
function emittedActionLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith(join('audit', 'service.ts'))) continue;
    const text = readFileSync(file, 'utf8');
    for (const [, literal] of text.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) {
      if (!DOMAINS.includes(literal.split('.')[0])) continue;
      found.set(literal, [...(found.get(literal) ?? []), relative(SRC, file)]);
    }
  }
  return found;
}

describe('actions the Hub emits', () => {
  const emitted = emittedActionLiterals();

  it('finds the actions in the code (the scan is not vacuous)', () => {
    expect(emitted.size).toBeGreaterThan(20);
    expect(emitted.has('command.received')).toBe(true);
    expect(emitted.has('goal.created')).toBe(true);
  });

  it('only uses actions described in AUDIT_ACTION_INFO', () => {
    const unknown = [...emitted].filter(([action]) => !(action in AUDIT_ACTION_INFO));
    expect(unknown).toEqual([]);
  });

  it("never uses a generic or alias action (status other than 'specific')", () => {
    const offenders = [...emitted]
      .filter(([action]) => AUDIT_ACTION_INFO[action as keyof typeof AUDIT_ACTION_INFO]?.status !== 'specific')
      .map(([action, files]) => ({
        action,
        status: AUDIT_ACTION_INFO[action as keyof typeof AUDIT_ACTION_INFO]?.status,
        preferred: AUDIT_ACTION_INFO[action as keyof typeof AUDIT_ACTION_INFO]?.preferred,
        files,
      }));
    expect(offenders).toEqual([]);
  });

  it('emits the specific names the decisions call for', () => {
    for (const action of [
      'goal.created', 'goal.updated', 'goal.status_changed', 'goal.clarification_answered',
      'goal.budget_proposed', 'goal.budget_approved', 'goal.budget_declined', 'budget.evaluated',
      'stream.connected', 'stream.disconnected',
      'control.paused', 'control.resumed', 'control.emergency_stopped',
      'thread.created', 'thread.message_received', 'thread.access_denied',
      'tool.proposed', 'brain.llm_call', 'brain.reply_generated', 'brain.explanation_generated',
      'brain.clarification_requested',
    ]) {
      expect(emitted.has(action), action).toBe(true);
    }
  });
});
