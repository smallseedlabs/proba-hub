#!/usr/bin/env node
/**
 * Checks that the vendored copy of proba-audit (src/audit/vendor/proba-audit/)
 * still matches the upstream commit pinned in src/audit/vendor/proba-audit/UPSTREAM_COMMIT.
 *
 * Usage:  node scripts/check-vendored-audit.mjs <path to a proba-audit checkout at the pinned commit>
 *
 * CI checks that commit out next to the Hub (see .github/workflows/ci.yml). Locally, without
 * touching your own proba-audit working tree:
 *
 *   mkdir -p /tmp/proba-audit-pin && git -C ../proba-audit archive "$(cat src/audit/vendor/proba-audit/UPSTREAM_COMMIT)" | tar -x -C /tmp/proba-audit-pin
 *   node scripts/check-vendored-audit.mjs /tmp/proba-audit-pin
 *
 * Three kinds of check (see MANIFEST):
 *   exact    the vendored file equals upstream after the listed, documented edits (import paths,
 *            the "Vendored from" header, and the parts the Hub drops).
 *   snippets the Hub reduced the file; the listed upstream blocks must still appear unchanged.
 *   hub-only files that belong to the Hub (index.ts, README.md, UPSTREAM_COMMIT).
 *
 * Any vendored file that is not listed fails the check, so nothing is added unreviewed.
 * To update the copy: re-copy from the new commit, update UPSTREAM_COMMIT, the header lines and
 * README, and run this script until it passes.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'src/audit/vendor/proba-audit');

const CORE = 'packages/core/src';
const ADAPTERS = 'packages/adapters/src';

const portImports = [["'../domain/audit.js'", "'../protocol.js'"]];
const emitterImports = [
  ["'../domain/audit.js'", "'./protocol.js'"],
  ["from '../ports/", "from './ports/"],
];
const relayImports = [["from '../ports/", "from './ports/"]];

/** @type {Array<{vendored: string, upstream: string, mode: string, replace?: Array<[string|RegExp, string]>, snippets?: Array<{start: RegExp, skipFirstLine?: boolean, replace?: Array<[string, string]>}>}>} */
export const MANIFEST = [
  { vendored: 'ports/clock.ts', upstream: `${CORE}/ports/clock.ts`, mode: 'exact' },
  { vendored: 'ports/id-generator.ts', upstream: `${CORE}/ports/id-generator.ts`, mode: 'exact' },
  { vendored: 'ports/logger.ts', upstream: `${CORE}/ports/logger.ts`, mode: 'exact' },
  { vendored: 'ports/audit-emitter.ts', upstream: `${CORE}/ports/audit-emitter.ts`, mode: 'exact', replace: portImports },
  { vendored: 'ports/outbox-store.ts', upstream: `${CORE}/ports/outbox-store.ts`, mode: 'exact', replace: portImports },
  { vendored: 'emitter.ts', upstream: `${CORE}/audit/emitter.ts`, mode: 'exact', replace: emitterImports },
  { vendored: 'outbox-relay.ts', upstream: `${CORE}/audit/outbox-relay.ts`, mode: 'exact', replace: relayImports },
  {
    vendored: 'protocol.ts',
    upstream: `${CORE}/audit/protocol.ts`,
    mode: 'exact',
    // The Hub also re-exports the AuditEvent type from here.
    replace: [['export type { AuditActor, AuditEventDraft,', 'export type { AuditActor, AuditEvent, AuditEventDraft,']],
  },
  {
    vendored: 'postgres-outbox-store.ts',
    upstream: `${ADAPTERS}/postgres/outbox-store.ts`,
    mode: 'exact',
    replace: [
      ["import { readFileSync } from 'node:fs';\nimport { fileURLToPath } from 'node:url';\n", ''],
      [
        "import type { AuditEvent, OutboxEntry, OutboxStore } from '@smallseedlabs/proba-audit-core';",
        "import type { AuditEvent } from './protocol.js';\nimport type { OutboxEntry, OutboxStore } from './ports/outbox-store.js';",
      ],
      [
        ' * of relays can run. The schema is migrations/postgres/0001_audit_outbox.sql.',
        " * of relays can run. The schema is src/db/migrations/004_audit_outbox.sql (a copy of\n * proba-audit's migrations/postgres/0001_audit_outbox.sql).",
      ],
      // The Hub's migration creates the table, so ensureSchema() is dropped.
      [/\n\n {2}\/\*\* Create the table if missing[^\n]*\n {2}async ensureSchema\(\): Promise<void> \{\n[\s\S]*?\n {2}\}\n/, '\n'],
    ],
  },
  {
    vendored: '../../../db/migrations/004_audit_outbox.sql',
    upstream: 'migrations/postgres/0001_audit_outbox.sql',
    mode: 'exact',
  },
  {
    // Publish half only.
    vendored: 'ports/event-bus.ts',
    upstream: `${CORE}/ports/event-bus.ts`,
    mode: 'snippets',
    snippets: [
      { start: /^export interface PublishOptions \{/ },
      { start: /^ {2}publish\(topic: string/ },
      { start: /^ {2}publishBatch\(topic: string/ },
    ],
  },
  {
    // Publish half only: the stream entry format must stay the one the consumer reads.
    vendored: 'redis-streams-publisher.ts',
    upstream: `${ADAPTERS}/redis/redis-streams-event-bus.ts`,
    mode: 'snippets',
    snippets: [
      // The Hub's publisher reads the clock from its options and types the fields as a plain record.
      { start: /^ {2}private fields\(/, skipFirstLine: true, replace: [['this.clock.isoNow()', 'this.options.clock.isoNow()']] },
      { start: /^ {2}private trim\(/ },
    ],
  },
];

/** Files in the vendor directory that belong to the Hub. */
const HUB_ONLY = ['index.ts', 'README.md', 'UPSTREAM_COMMIT'];

const norm = (text) => text.replace(/\r\n/g, '\n');
const lines = (text) => norm(text).split('\n').map((l) => l.trim());

function stripHeader(vendoredText, file) {
  const [first, ...rest] = norm(vendoredText).split('\n');
  const m = /^(?:\/\/ Vendored from smallseedlabs\/proba-audit @ ([0-9a-f]{7,40})|-- Copied from proba-audit \S+ \(([0-9a-f]{7,40})\)\.)/.exec(first);
  if (!m) return { error: `${file}: first line must be the "Vendored from ... @ <commit>" header` };
  return { sha: m[1] ?? m[2], text: rest.join('\n') };
}

function extractBlock(text, start, skipFirstLine) {
  const all = norm(text).split('\n');
  const i = all.findIndex((l) => start.test(l));
  if (i < 0) return null;
  let depth = 0;
  let seenBrace = false;
  const out = [];
  for (let j = i; j < all.length; j++) {
    out.push(all[j]);
    for (const ch of all[j]) {
      if (ch === '{') {
        depth++;
        seenBrace = true;
      } else if (ch === '}') depth--;
    }
    if (!seenBrace && /;\s*$/.test(all[j])) break;
    if (seenBrace && depth === 0) break;
  }
  return (skipFirstLine ? out.slice(1) : out).map((l) => l.trim());
}

function unifiedDiff(expected, actual, label) {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-check-'));
  const a = join(dir, 'upstream-expected');
  const b = join(dir, 'vendored');
  writeFileSync(a, expected);
  writeFileSync(b, actual);
  try {
    execFileSync('git', ['diff', '--no-index', '--no-color', '--', a, b], { encoding: 'utf8' });
    return '';
  } catch (err) {
    return `--- upstream (expected) ${label}\n+++ vendored\n${String(err.stdout ?? '').split('\n').slice(4).join('\n')}`;
  }
}

function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

export function check(upstreamDir) {
  const problems = [];
  const pin = readFileSync(join(vendorDir, 'UPSTREAM_COMMIT'), 'utf8').trim();
  if (!/^[0-9a-f]{40}$/.test(pin)) problems.push('UPSTREAM_COMMIT must hold a full 40-character commit sha');

  if (existsSync(join(upstreamDir, '.git'))) {
    const head = execFileSync('git', ['-C', upstreamDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (head !== pin) problems.push(`proba-audit checkout is at ${head}, but UPSTREAM_COMMIT pins ${pin}`);
  }

  const readme = readFileSync(join(vendorDir, 'README.md'), 'utf8');
  if (!readme.includes(pin.slice(0, 7))) problems.push(`README.md does not mention the pinned commit ${pin.slice(0, 7)}`);

  const covered = new Set();
  for (const entry of MANIFEST) {
    const vendoredPath = resolve(vendorDir, entry.vendored);
    covered.add(vendoredPath);
    const label = `${relative(root, vendoredPath)} <- ${entry.upstream}`;
    if (!existsSync(vendoredPath)) {
      problems.push(`${label}: vendored file is missing`);
      continue;
    }
    const upstreamPath = join(upstreamDir, entry.upstream);
    if (!existsSync(upstreamPath)) {
      problems.push(`${label}: not found in proba-audit at the pinned commit`);
      continue;
    }
    const upstream = norm(readFileSync(upstreamPath, 'utf8'));
    const vendored = norm(readFileSync(vendoredPath, 'utf8'));
    const header = stripHeader(vendored, relative(root, vendoredPath));
    if (header.error) {
      problems.push(header.error);
      continue;
    }
    if (!pin.startsWith(header.sha)) problems.push(`${relative(root, vendoredPath)}: header says ${header.sha}, UPSTREAM_COMMIT is ${pin.slice(0, 7)}`);

    if (entry.mode === 'exact') {
      let expected = upstream;
      for (const [from, to] of entry.replace ?? []) {
        const present = typeof from === 'string' ? expected.includes(from) : from.test(expected);
        if (!present) {
          problems.push(`${label}: expected upstream text no longer present (${String(from).slice(0, 80)}). Upstream changed; re-sync the vendored copy.`);
          expected = null;
          break;
        }
        expected = typeof from === 'string' ? expected.split(from).join(to) : expected.replace(from, to);
      }
      if (expected === null) continue;
      if (expected !== header.text) problems.push(`${label}: differs from upstream\n${unifiedDiff(expected, header.text, entry.upstream)}`);
    } else {
      const haystack = lines(header.text).join('\n');
      for (const snippet of entry.snippets ?? []) {
        let block = extractBlock(upstream, snippet.start, snippet.skipFirstLine);
        if (block && snippet.replace) {
          let joined = block.join('\n');
          for (const [from, to] of snippet.replace) joined = joined.split(from).join(to);
          block = joined.split('\n');
        }
        if (!block) {
          problems.push(`${label}: upstream block ${snippet.start} not found. Upstream changed; re-sync the vendored copy.`);
        } else if (!haystack.includes(block.join('\n'))) {
          problems.push(`${label}: upstream block ${snippet.start} is missing or changed in the vendored file:\n${block.join('\n')}`);
        }
      }
    }
  }

  for (const file of listFiles(vendorDir)) {
    const rel = relative(vendorDir, file);
    if (!covered.has(file) && !HUB_ONLY.includes(rel)) problems.push(`${relative(root, file)}: not in the vendor manifest (scripts/check-vendored-audit.mjs)`);
  }
  return { problems, pin, checked: MANIFEST.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) {
    console.error('Usage: node scripts/check-vendored-audit.mjs <path to proba-audit checkout at the pinned commit>');
    process.exit(2);
  }
  const { problems, pin, checked } = check(resolve(dir));
  if (problems.length > 0) {
    console.error(`Vendored proba-audit copy does not match upstream ${pin}:\n`);
    for (const p of problems) console.error(`- ${p}\n`);
    process.exit(1);
  }
  console.log(`Vendored proba-audit copy matches upstream ${pin.slice(0, 7)} (${checked} files checked).`);
}
