/**
 * Canary-Safe Labels and Diagnostics
 *
 * Ensures that labels, accessibility text, diagnostics, clipboard content,
 * and exported data never contain:
 * - Secret values (API keys, tokens, passwords)
 * - Private filesystem paths (user home directories)
 * - Private/unauthorized locators (file:// URIs, UNC paths)
 * - Internal correlation identifiers that could leak topology
 *
 * "Canary" refers to test values planted in secret/path stores to detect leakage.
 * A canary-safe label passes all canary checks without triggering.
 *
 * Requirements: 29.2, 41.3, 41.11, 45.10
 */

import type { CanarySafeLabel } from './types';

// ─── Canary Detection Patterns ──────────────────────────────────

/**
 * Patterns that detect secret canaries in labels/diagnostics.
 */
const SECRET_CANARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  // JWT tokens (matches header.payload.signature or header.payload) — check first due to overlap with generic patterns
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g, category: 'jwt_token' },
  // API keys and tokens (common formats)
  { pattern: /(?:api[_-]?key|apikey|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9+/=_-]{16,}/gi, category: 'secret_assignment' },
  // GitHub tokens
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, category: 'github_token' },
  // AWS keys
  { pattern: /AKIA[A-Z0-9]{16}/g, category: 'aws_key' },
  // Generic long hex/base64 strings that look like secrets (32+ chars)
  { pattern: /(?:sk|pk|rk|ak)-[A-Za-z0-9]{20,}/g, category: 'prefixed_secret' },
  // Bearer tokens in headers
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, category: 'bearer_token' },
  // Connection strings with credentials
  { pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^@]+@/gi, category: 'connection_string' },
  // Private key markers
  { pattern: /-----BEGIN\s+(?:RSA|EC|PRIVATE|DSA)\s+/g, category: 'private_key' },
];

/**
 * Patterns that detect private path canaries.
 */
const PATH_CANARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  { pattern: /\/Users\/[^/\s]+\//g, category: 'macos_user_path' },
  { pattern: /\/home\/[^/\s]+\//g, category: 'linux_user_path' },
  { pattern: /\/root\//g, category: 'root_path' },
  { pattern: /[A-Z]:\\Users\\[^\\]+\\/gi, category: 'windows_user_path' },
  { pattern: /~\//g, category: 'tilde_path' },
  { pattern: /\/var\/(?:run|tmp|private)\//g, category: 'system_path' },
  { pattern: /\/tmp\/[^/\s]+/g, category: 'temp_path' },
  { pattern: /\/proc\/\d+\//g, category: 'proc_path' },
];

/**
 * Patterns that detect private locator canaries.
 */
const LOCATOR_CANARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; category: string }> = [
  { pattern: /file:\/\/\//g, category: 'file_uri' },
  { pattern: /\\\\[^\\]+\\/g, category: 'unc_path' },
  { pattern: /blob:[a-z]+:\/\/[a-f0-9-]+/gi, category: 'blob_locator' },
  // Internal storage paths that shouldn't be exposed
  { pattern: /\.neuronest\/(?:vuln-cache|analysis-cache)\//g, category: 'internal_cache_path' },
];

// ─── Replacement Tokens ─────────────────────────────────────────

const REDACTION_REPLACEMENTS: Readonly<Record<string, string>> = {
  secret_assignment: '[redacted]',
  github_token: '[redacted-token]',
  aws_key: '[redacted-key]',
  prefixed_secret: '[redacted-key]',
  jwt_token: '[redacted-token]',
  bearer_token: '[redacted-token]',
  connection_string: '[redacted-connection]',
  private_key: '[redacted-key]',
  macos_user_path: '[path]/',
  linux_user_path: '[path]/',
  root_path: '[path]/',
  windows_user_path: '[path]\\',
  tilde_path: '[path]/',
  system_path: '[path]/',
  temp_path: '[path]',
  proc_path: '[path]/',
  file_uri: '[locator]',
  unc_path: '[locator]\\',
  blob_locator: '[locator]',
  internal_cache_path: '[internal]/',
};

// ─── Public API ─────────────────────────────────────────────────

/**
 * Create a canary-safe label from arbitrary input text.
 *
 * Scans for secret, path, and locator canaries and replaces them
 * with safe redaction tokens. The result is guaranteed to not trigger
 * any canary detection patterns.
 */
export function makeCanarySafeLabel(input: string): CanarySafeLabel {
  if (!input) {
    return { text: '', wasRedacted: false, redactedCategories: [] };
  }

  let text = input;
  const categories: Set<string> = new Set();

  // Apply all canary pattern groups
  const allPatterns = [
    ...SECRET_CANARY_PATTERNS,
    ...PATH_CANARY_PATTERNS,
    ...LOCATOR_CANARY_PATTERNS,
  ];

  for (const { pattern, category } of allPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    if (regex.test(text)) {
      const freshRegex = new RegExp(pattern.source, pattern.flags);
      const replacement = REDACTION_REPLACEMENTS[category] ?? '[redacted]';
      text = text.replace(freshRegex, replacement);
      categories.add(category);
    }
  }

  return {
    text,
    wasRedacted: categories.size > 0,
    redactedCategories: [...categories],
  };
}

/**
 * Create canary-safe diagnostics from a record of key-value pairs.
 * Each value is processed through canary detection and redaction.
 */
export function makeCanarySafeDiagnostics(
  input: Record<string, unknown>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(input)) {
    const strValue = value == null ? '' : String(value);
    const safe = makeCanarySafeLabel(strValue);
    result[key] = safe.text;
  }

  return result;
}

/**
 * Check if a string contains any canary patterns.
 * Returns the categories of detected canaries, or empty array if clean.
 */
export function detectCanaries(input: string): string[] {
  if (!input) return [];

  const categories: Set<string> = new Set();
  const allPatterns = [
    ...SECRET_CANARY_PATTERNS,
    ...PATH_CANARY_PATTERNS,
    ...LOCATOR_CANARY_PATTERNS,
  ];

  for (const { pattern, category } of allPatterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    if (regex.test(input)) {
      categories.add(category);
    }
  }

  return [...categories];
}

/**
 * Assert that a string is canary-safe (contains no detectable canaries).
 * Throws if canaries are detected — use in test assertions.
 */
export function assertCanarySafe(input: string, context?: string): void {
  const detected = detectCanaries(input);
  if (detected.length > 0) {
    const prefix = context ? `[${context}] ` : '';
    throw new Error(
      `${prefix}Canary leak detected: ${detected.join(', ')}`,
    );
  }
}
