// Vendored from smallseedlabs/proba-audit @ 038d63f (Apache-2.0). See vendor/proba-audit/README.md.
/**
 * The only place proba-audit pulls runtime helpers from the protocol package.
 * Apps import these through core so that the protocol dependency is declared
 * once (in packages/core) and schemas are never copied.
 */
export {
  AUDIT_ACTIONS,
  buildAuditEvent,
  canonicalizeAuditEvent,
  generateSpanId,
  validateAuditEvent,
  validateStoredAuditEvent,
} from '@smallseedlabs/proba-protocol/audit';
export type { AuditActor, AuditEvent, AuditEventDraft, AuditTarget } from '@smallseedlabs/proba-protocol/audit';
