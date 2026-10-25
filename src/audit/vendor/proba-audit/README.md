# Vendored from proba-audit

This directory is a **copy** of the audit emitter, transactional outbox and relay
from [`smallseedlabs/proba-audit`](https://github.com/smallseedlabs/proba-audit)
(commit `038d63f`, Apache-2.0). It exists so the Hub can emit audit events
without publishing packages. Do not add Hub logic here; Hub code lives in
`src/audit/` and talks to this directory only through its public interfaces.

| Here | Source in proba-audit |
| --- | --- |
| `ports/audit-emitter.ts`, `ports/outbox-store.ts`, `ports/clock.ts`, `ports/id-generator.ts`, `ports/logger.ts` | `packages/core/src/ports/` (identical apart from the import of the protocol types) |
| `emitter.ts`, `outbox-relay.ts` | `packages/core/src/audit/` (identical apart from import paths) |
| `protocol.ts` | `packages/core/src/audit/protocol.ts` (+ the `AuditEvent` type export) |
| `postgres-outbox-store.ts` | `packages/adapters/src/postgres/outbox-store.ts` (without `ensureSchema()`; the Hub migration `004_audit_outbox.sql` creates the table) |
| `ports/event-bus.ts` | the **publish half** of `packages/core/src/ports/event-bus.ts` (the Hub never subscribes) |
| `redis-streams-publisher.ts` | the **publish half** of `packages/adapters/src/redis/redis-streams-event-bus.ts` (same stream entry format) |
| `../../db/migrations/004_audit_outbox.sql` | `migrations/postgres/0001_audit_outbox.sql` |

The interfaces (`AuditEmitter`, `OutboxStore`) are unchanged, so this directory can
later be replaced by `@smallseedlabs/proba-audit-core` / `-adapters` imports without
touching Hub code.
