// Vendored from smallseedlabs/proba-audit @ 038d63f (Apache-2.0). See vendor/proba-audit/README.md.
/** Source of identifiers. Swap for a sequential generator in tests. */
export interface IdGenerator {
  /** UUID v4 (event ids, trace ids). */
  uuid(): string;
  /** OpenTelemetry-style span id: 16 lowercase hex characters, not all zeros. */
  spanId(): string;
}
