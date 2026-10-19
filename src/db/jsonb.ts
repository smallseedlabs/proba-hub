/**
 * JSONB encoding helper for PostgreSQL jsonb columns.
 * 
 * node-postgres expects pre-stringified JSON for jsonb columns to avoid double-encoding.
 * This helper ensures consistent single-level JSON encoding.
 */

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export interface JsonObject { [key: string]: JsonValue; }
export interface JsonArray extends Array<JsonValue> {}

/**
 * Encodes a value for insertion into a PostgreSQL jsonb column.
 * Returns a JSON string or null.
 */
export function toJsonb(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  
  // If already a string, assume it's pre-stringified (shouldn't happen in practice)
  if (typeof value === 'string') {
    return value;
  }
  
  return JSON.stringify(value);
}

/**
 * Parses a value retrieved from a PostgreSQL jsonb column.
 * node-postgres automatically parses jsonb to objects, so this is typically a no-op.
 */
export function fromJsonb<T = JsonValue>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  
  // If it's a string, parse it (shouldn't happen with node-postgres)
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  
  // Already parsed by node-postgres
  return value as T;
}
