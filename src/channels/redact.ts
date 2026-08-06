/**
 * Secret-redaction helpers for logs and error messages.
 * Ensures that sensitive config fields (tokens, passwords, secrets, keys)
 * never leak into logs, status events, or user-facing error messages.
 *
 * @see REQ 15.5, REQ 18.1, REQ 18.2, REQ 18.3, REQ 18.4
 */

/** Pattern matching config keys that must be redacted. */
const SECRET_KEY_PATTERN = /token|password|secret|key|appPassword/i;

/**
 * Redact any object field whose key matches SECRET_KEY_PATTERN.
 * Returns a NEW object; the original is not mutated.
 * Recursive: nested objects and arrays are redacted too.
 */
export function redactSecrets<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item)) as unknown as T;
  }

  if (typeof value === 'object' && !(value instanceof Date)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        result[k] = '<redacted>';
      } else {
        result[k] = redactSecrets(v);
      }
    }
    return result as T;
  }

  return value;
}

/**
 * Redact any occurrence of the given secret values in a string.
 * Used for scrubbing SDK exception messages before they hit logs.
 * Only replaces secrets whose length is >= 4 characters (shorter strings
 * could produce false positives on common substrings).
 *
 * @see REQ 18.4
 */
export function redactString(str: string, secrets: readonly string[]): string {
  let out = str;
  for (const s of secrets) {
    if (s && s.length >= 4) {
      out = out.split(s).join('<redacted>');
    }
  }
  return out;
}
