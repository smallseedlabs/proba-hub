/**
 * Redaction for audit event `details` (and error messages).
 *
 * Protocol rules: no secrets, no raw personal data. Callers should not pass such
 * values in the first place; this is the safety net. It removes values by key
 * name, masks token/email-shaped strings, bounds size and depth, and never
 * throws.
 */

const REDACTED = '[REDACTED]';

/** Keys whose values are secrets. Matched case-insensitively as substrings. */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|apikey|credential|bearer|jwt|private[-_]?key|session[-_]?id|id[-_]?token)/i;

/** Keys that carry personal data (the protocol wants ids, not these). */
const PERSONAL_KEY_RE = /^(email|e-mail|phone|phonenumber|displayname|display_name|fullname|full_name|firstname|lastname|address|ip|ipaddress|remoteaddress|useragent|user_agent)$/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const QUERY_TOKEN_RE = /([?&](?:token|access_token|id_token|key|api_key)=)[^&#\s]*/gi;

export interface RedactOptions {
  maxStringLength?: number;
  maxDepth?: number;
  maxArrayLength?: number;
  maxKeys?: number;
}

const DEFAULTS: Required<RedactOptions> = { maxStringLength: 300, maxDepth: 5, maxArrayLength: 25, maxKeys: 40 };

/** Mask secrets and email addresses inside one string and cap its length. */
export function redactString(value: string, maxLength: number = DEFAULTS.maxStringLength): string {
  const masked = value
    .replace(BEARER_RE, 'Bearer [REDACTED]')
    .replace(JWT_RE, '[REDACTED_TOKEN]')
    .replace(QUERY_TOKEN_RE, '$1[REDACTED]')
    .replace(EMAIL_RE, '[REDACTED_EMAIL]');
  return masked.length > maxLength ? `${masked.slice(0, maxLength)}…` : masked;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>, o: Required<RedactOptions>): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
      return redactString(value, o.maxStringLength);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined; // functions, symbols
  }
  const obj = value as object;
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
  if (obj instanceof Error) return redactString(obj.message, o.maxStringLength);
  if (seen.has(obj)) return '[Circular]';
  if (depth >= o.maxDepth) return '[Truncated]';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const items = obj.slice(0, o.maxArrayLength).map((v) => redactValue(v, depth + 1, seen, o));
      if (obj.length > o.maxArrayLength) items.push(`[+${obj.length - o.maxArrayLength} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(obj as Record<string, unknown>);
    for (const [key, v] of entries.slice(0, o.maxKeys)) {
      if (SECRET_KEY_RE.test(key) || PERSONAL_KEY_RE.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      const redacted = redactValue(v, depth + 1, seen, o);
      if (redacted !== undefined) out[key] = redacted;
    }
    if (entries.length > o.maxKeys) out['[truncated]'] = `+${entries.length - o.maxKeys} keys`;
    return out;
  } finally {
    seen.delete(obj);
  }
}

/** Redact an audit `details` object. Always returns a plain JSON-safe object. */
export function redactDetails(details: unknown, options: RedactOptions = {}): Record<string, unknown> {
  const o = { ...DEFAULTS, ...options };
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return {};
  try {
    return redactValue(details, 0, new WeakSet(), o) as Record<string, unknown>;
  } catch {
    return { redactionError: true };
  }
}
