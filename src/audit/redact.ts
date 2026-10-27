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

// ---------------------------------------------------------------------------
// Raw text (AuditEvent.content): secrets always; personal data when AUDIT_CONTENT_MASK_PII.
//
// Secrets (passwords, tokens, API keys, private keys, payment cards) are always masked.
// When `pii` is true (AUDIT_CONTENT_MASK_PII, default on), emails, phone numbers and IBANs
// are masked the same way memory does with REDACT_PII. Better to mask a harmless match
// than to keep a real secret or identifier.
// ---------------------------------------------------------------------------

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
/** Credentials with a recognisable prefix: Stripe/OpenAI/Anthropic style, GitHub, Slack, Google, AWS. */
const KEY_PREFIX_RE =
  /\b(?:(?:sk|pk|rk)[-_](?:live|test|proj|ant|svcacct)?[-_]?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/g;
/** `password: hunter2`, `api_key=abc`, `token: abc`. Keeps the label, masks the value. */
const LABELLED_SECRET_RE =
  /\b((?:pass(?:word|wd|code)?|pwd|secret|api[ _-]?key|apikey|(?:access|auth|refresh|session|id)[ _-]?token|token|client[ _-]?secret|private[ _-]?key|pin)\s*[:=]\s*)(?!\[REDACTED)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
/** `my password is hunter2`: only for words that are secrets in themselves (not "the token is expired"). */
const SPOKEN_SECRET_RE = /\b((?:pass(?:word|wd|code)?|pwd|pin|secret|api[ _-]?key)\s+(?:is|was|=)\s+)(?!\[REDACTED)("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export interface MaskedText {
  text: string;
  /** How many secrets (and, when enabled, PII) were masked. */
  redactions: number;
}

export interface MaskContentOptions {
  /** Also mask emails, phone numbers and IBANs (AUDIT_CONTENT_MASK_PII). */
  pii?: boolean;
}

const EMAIL_CONTENT_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const PHONE_RE =
  /(?<![\w.])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]?\d{3,4}(?!\w|\.\d)/g;

function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of value) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/**
 * Mask secrets in free text (and personal data when `pii` is true). Never throws; non-strings
 * give an empty text. Length is not capped here (buildAuditContent truncates).
 */
export function maskSecretsInText(value: unknown, options: MaskContentOptions = {}): MaskedText {
  if (typeof value !== 'string') return { text: '', redactions: 0 };
  let redactions = 0;
  const mask = (replacement: string) => () => {
    redactions += 1;
    return replacement;
  };
  const maskValue = (_m: string, label: string) => {
    redactions += 1;
    return `${label}[REDACTED]`;
  };
  try {
    let text = value
      .replace(PRIVATE_KEY_BLOCK_RE, mask('[REDACTED_PRIVATE_KEY]'))
      .replace(BEARER_RE, mask('Bearer [REDACTED]'))
      .replace(JWT_RE, mask('[REDACTED_TOKEN]'))
      .replace(KEY_PREFIX_RE, mask('[REDACTED_KEY]'))
      .replace(QUERY_TOKEN_RE, (_m, label: string) => {
        redactions += 1;
        return `${label}[REDACTED]`;
      })
      .replace(LABELLED_SECRET_RE, maskValue)
      .replace(SPOKEN_SECRET_RE, maskValue)
      .replace(CARD_CANDIDATE_RE, (m) => {
        const digits = m.replace(/[ -]/g, '');
        if (digits.length < 13 || digits.length > 19 || !luhnValid(digits)) return m;
        redactions += 1;
        return '[REDACTED_CARD]';
      });
    if (options.pii) {
      text = text
        .replace(EMAIL_CONTENT_RE, mask('[REDACTED:email]'))
        .replace(IBAN_RE, (m) => {
          if (!ibanValid(m)) return m;
          redactions += 1;
          return '[REDACTED:iban]';
        })
        .replace(PHONE_RE, (m) => {
          const digits = m.replace(/\D/g, '');
          if (digits.length < 9 || digits.length > 15 || /^\d{4}-\d{2}-\d{2}$/.test(m.trim())) return m;
          redactions += 1;
          return '[REDACTED:phone]';
        });
    }
    return { text, redactions };
  } catch {
    return { text: '[unavailable]', redactions: 0 };
  }
}
