/**
 * Centralized private-field redaction across all output channels.
 *
 * This is the SINGLE authority-supplied redaction boundary applied to:
 * - Visual labels (textContent, display values)
 * - Accessible names and descriptions (aria-label, aria-describedby text)
 * - Clipboard payloads (copy actions)
 * - Diagnostic exports (structured diagnostics)
 * - Telemetry (metrics, events)
 *
 * Redaction happens BEFORE DOM creation — secrets, private paths, protected
 * prompts/reasoning, raw arguments/output, and unauthorized locators are
 * omitted from any output channel rather than hidden with CSS.
 *
 * Task 5.5 (enhanced-chat-ui): the renderer surface is one of the observable
 * channels the shared credential/content redaction boundary must cover. The
 * renderer-specific patterns below stay for their channel-specific
 * placeholders (`<private>`, `<protected>`, etc.) that existing surface tests
 * depend on. Every string exiting {@link redactForOutput} is additionally
 * passed through the shared canonical redactor so Proxy Credentials, legacy
 * provider keys, and enhanced-chat-ui prompt/response/reasoning canaries
 * are guaranteed to be scrubbed even if a renderer-local pattern misses them.
 *
 * Requirements: 7.8, 10.9, 12.8, 20.3, 20.7–20.8, 22.6; 5.6, 7.4, 7.6,
 * 8.9, 15.1, 15.2 (Task 5.5).
 */

import { redactForRenderer as sharedRedactForRenderer } from '../../shared/observable-redaction';

// ─── Redaction patterns ─────────────────────────────────────────────────────

/**
 * Matches private user paths:
 * - /Users/xxx, /home/xxx (Unix home directories)
 * - C:\Users\xxx, D:\Users\xxx (Windows home directories)
 * - ~/ (tilde home shorthand)
 *
 * Uses the global flag for replacement across all occurrences.
 */
const PRIVATE_PATH_PATTERN =
  /(?:\/(?:Users|home)\/[^\s/\\]+|[A-Z]:\\Users\\[^\s/\\]+|~\/)/gi;

/**
 * Named secret assignments: api_key=xxx, access_token: xxx, password=xxx, etc.
 */
const NAMED_SECRET_PATTERN =
  /(?:api[_-]?key|access[_-]?token|password|secret|authorization|bearer|private[_-]?key)\s*[:=]\s*\S+/gi;

/**
 * Known secret value formats:
 * - PEM private keys
 * - AWS access key IDs (AKIA...)
 * - GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
 * - JWT tokens (eyJ...)
 */
const SECRET_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:\b)AKIA[0-9A-Z]{16}\b|(?:\b)gh[pousr]_[A-Za-z0-9]{20,}\b|(?:\b)eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/g;

/**
 * Protected prompts and hidden reasoning references.
 * These indicate chain-of-thought or system prompt content that must not leak.
 */
const PROTECTED_TEXT_PATTERN =
  /(?:protected\s+prompt|system\s+prompt|hidden\s+reasoning|chain[- ]of[- ]thought)[:\s][^\n]*/gi;

/**
 * Unauthorized locators: file:// protocol, internal paths with line references,
 * and UNC paths that could reveal system structure.
 */
const UNAUTHORIZED_LOCATOR_PATTERN =
  /(?:file:\/\/\/[^\s"'`]+|\\\\[^\\\s]+\\[^\s"'`]+)/gi;

/**
 * Raw arguments and output markers — content between raw argument/output
 * delimiters that should not appear in any output channel.
 */
const RAW_ARGUMENT_PATTERN =
  /(?:raw[_-]?(?:arguments?|output|response))\s*[:=]\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}|\[[^\]]*\]|\S+)/gi;

// ─── Output Channel Enum ────────────────────────────────────────────────────

/**
 * The defined set of output channels that the redaction boundary covers.
 * Used for canary testing and audit purposes.
 */
export type OutputChannel =
  | 'visual_label'
  | 'accessible_name'
  | 'accessible_description'
  | 'clipboard'
  | 'diagnostic'
  | 'telemetry'
  | 'inspector'
  | 'error_path';

/**
 * All channels that the redaction service covers.
 */
export const ALL_OUTPUT_CHANNELS: readonly OutputChannel[] = Object.freeze([
  'visual_label',
  'accessible_name',
  'accessible_description',
  'clipboard',
  'diagnostic',
  'telemetry',
  'inspector',
  'error_path',
]);

// ─── Redaction markers ──────────────────────────────────────────────────────

/** Replacement text for redacted private path segments. */
const REDACTED_PATH = '<private>';

/** Replacement text for redacted secret values. */
const REDACTED_SECRET = '<redacted>';

/** Replacement text for redacted protected prompts/reasoning. */
const REDACTED_PROTECTED = '<protected>';

/** Replacement text for redacted unauthorized locators. */
const REDACTED_LOCATOR = '<redacted-locator>';

/** Replacement text for redacted raw arguments/output. */
const REDACTED_RAW = '<redacted>';

// ─── Core redaction functions ───────────────────────────────────────────────

/**
 * Redact private paths from text.
 * Catches /Users/xxx, /home/xxx, C:\Users\xxx, and ~/ prefixes.
 */
export function redactPrivatePaths(text: string): string {
  return text.replace(PRIVATE_PATH_PATTERN, REDACTED_PATH);
}

/**
 * Redact named secret assignments from text.
 * Catches api_key=xxx, password: xxx, bearer: xxx, etc.
 */
export function redactNamedSecrets(text: string): string {
  return text.replace(NAMED_SECRET_PATTERN, REDACTED_SECRET);
}

/**
 * Redact known secret value formats from text.
 * Catches PEM keys, AWS keys, GitHub tokens, JWTs.
 */
export function redactSecretValues(text: string): string {
  return text.replace(SECRET_VALUE_PATTERN, REDACTED_SECRET);
}

/**
 * Redact protected prompts and hidden reasoning references from text.
 */
export function redactProtectedText(text: string): string {
  return text.replace(PROTECTED_TEXT_PATTERN, REDACTED_PROTECTED);
}

/**
 * Redact unauthorized locators (file:// URLs, UNC paths) from text.
 */
export function redactUnauthorizedLocators(text: string): string {
  return text.replace(UNAUTHORIZED_LOCATOR_PATTERN, REDACTED_LOCATOR);
}

/**
 * Redact raw argument/output markers from text.
 */
export function redactRawArguments(text: string): string {
  return text.replace(RAW_ARGUMENT_PATTERN, REDACTED_RAW);
}

// ─── Unified redaction boundary ─────────────────────────────────────────────

/**
 * The single unified redaction function that MUST be applied to all text
 * before it enters any output channel (visual labels, accessible names,
 * clipboard payloads, diagnostics, telemetry).
 *
 * This applies ALL redaction patterns in a defined order:
 * 1. Secret values (PEM, AWS, GitHub, JWT) — most specific patterns first
 * 2. Named secrets (api_key=, password=, etc.)
 * 3. Protected prompts/reasoning
 * 4. Unauthorized locators (file://, UNC)
 * 5. Raw arguments/output
 * 6. Private paths (last, since paths may be part of other patterns)
 *
 * @param text - The raw text to redact
 * @returns Text safe for any output channel
 */
export function redactForOutput(text: string): string {
  if (!text) return text;

  let result = text;
  result = redactSecretValues(result);
  result = redactNamedSecrets(result);
  result = redactProtectedText(result);
  result = redactUnauthorizedLocators(result);
  result = redactRawArguments(result);
  result = redactPrivatePaths(result);
  // Task 5.5 defence-in-depth: run the shared canonical boundary after the
  // renderer-specific patterns. Any Proxy Credential, legacy provider key,
  // or enhanced-chat-ui canary that the renderer patterns above did not
  // recognize is still scrubbed before the string leaves this module.
  result = sharedRedactForRenderer(result);
  return result;
}

// ─── Structured content redaction ───────────────────────────────────────────

/**
 * Result of a redaction check — indicates whether the text contained
 * sensitive content and what categories were detected.
 */
export interface RedactionResult {
  /** The redacted text, safe for output. */
  readonly text: string;
  /** Whether any redaction was applied. */
  readonly wasRedacted: boolean;
  /** Which categories of sensitive content were detected. */
  readonly categories: readonly RedactionCategory[];
}

export type RedactionCategory =
  | 'secret_value'
  | 'named_secret'
  | 'protected_text'
  | 'unauthorized_locator'
  | 'raw_argument'
  | 'private_path';

/**
 * Perform redaction with detailed results indicating what was found.
 * Use this when you need to record a diagnostic about what was redacted.
 */
export function redactWithDiagnostics(text: string): RedactionResult {
  if (!text) {
    return { text, wasRedacted: false, categories: [] };
  }

  const categories: RedactionCategory[] = [];

  if (SECRET_VALUE_PATTERN.test(text)) categories.push('secret_value');
  // Reset lastIndex due to global flag
  SECRET_VALUE_PATTERN.lastIndex = 0;

  if (NAMED_SECRET_PATTERN.test(text)) categories.push('named_secret');
  NAMED_SECRET_PATTERN.lastIndex = 0;

  if (PROTECTED_TEXT_PATTERN.test(text)) categories.push('protected_text');
  PROTECTED_TEXT_PATTERN.lastIndex = 0;

  if (UNAUTHORIZED_LOCATOR_PATTERN.test(text)) categories.push('unauthorized_locator');
  UNAUTHORIZED_LOCATOR_PATTERN.lastIndex = 0;

  if (RAW_ARGUMENT_PATTERN.test(text)) categories.push('raw_argument');
  RAW_ARGUMENT_PATTERN.lastIndex = 0;

  if (PRIVATE_PATH_PATTERN.test(text)) categories.push('private_path');
  PRIVATE_PATH_PATTERN.lastIndex = 0;

  const wasRedacted = categories.length > 0;
  const redacted = wasRedacted ? redactForOutput(text) : text;

  return { text: redacted, wasRedacted, categories: Object.freeze(categories) };
}

// ─── Channel-specific wrappers ──────────────────────────────────────────────

/**
 * Redact text for use as a visual label (textContent, display values).
 * This is the same unified redaction — the wrapper exists for explicit
 * channel identification in call sites.
 */
export function redactForVisualLabel(text: string): string {
  return redactForOutput(text);
}

/**
 * Redact text for use as an accessible name (aria-label value).
 */
export function redactForAccessibleName(text: string): string {
  return redactForOutput(text);
}

/**
 * Redact text for use as an accessible description (aria-describedby text).
 */
export function redactForAccessibleDescription(text: string): string {
  return redactForOutput(text);
}

/**
 * Redact text for clipboard payloads (copy actions).
 */
export function redactForClipboard(text: string): string {
  return redactForOutput(text);
}

/**
 * Redact text for diagnostic exports.
 */
export function redactForDiagnostic(text: string): string {
  return redactForOutput(text);
}

/**
 * Redact text for telemetry payloads.
 */
export function redactForTelemetry(text: string): string {
  return redactForOutput(text);
}

// ─── Validation helpers ─────────────────────────────────────────────────────

/**
 * Check whether text contains any sensitive content that would be redacted.
 * Useful for assertion/canary tests without modifying the text.
 */
export function containsSensitiveContent(text: string): boolean {
  if (!text) return false;

  SECRET_VALUE_PATTERN.lastIndex = 0;
  NAMED_SECRET_PATTERN.lastIndex = 0;
  PROTECTED_TEXT_PATTERN.lastIndex = 0;
  UNAUTHORIZED_LOCATOR_PATTERN.lastIndex = 0;
  RAW_ARGUMENT_PATTERN.lastIndex = 0;
  PRIVATE_PATH_PATTERN.lastIndex = 0;

  return (
    SECRET_VALUE_PATTERN.test(text) ||
    NAMED_SECRET_PATTERN.test(text) ||
    PROTECTED_TEXT_PATTERN.test(text) ||
    UNAUTHORIZED_LOCATOR_PATTERN.test(text) ||
    RAW_ARGUMENT_PATTERN.test(text) ||
    PRIVATE_PATH_PATTERN.test(text)
  );
}

/**
 * Verify that a string is safe for output (contains no sensitive content).
 * Returns true if the string passes all redaction checks.
 */
export function isOutputSafe(text: string): boolean {
  return !containsSensitiveContent(text);
}

// ─── Canary test support ────────────────────────────────────────────────────

/**
 * Known canary values for testing redaction coverage across all surfaces.
 * Each canary represents one category of sensitive content that must never
 * appear in any output channel.
 */
export const REDACTION_CANARIES = Object.freeze({
  /** API key assignment pattern */
  secret_named: 'api_key=sk-test-super-secret-key-12345',
  /** AWS access key ID */
  secret_aws: 'AKIAIOSFODNN7EXAMPLE',
  /** GitHub personal access token */
  secret_github: 'ghp_ABCDEFGHIJKLMNOPQRSTuvwx',
  /** JWT token */
  secret_jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  /** Unix private path */
  path_unix: '/Users/privateuser/Documents/project/secrets.env',
  /** Windows private path */
  path_windows: 'C:\\Users\\privateuser\\AppData\\Local\\secrets',
  /** Home tilde path */
  path_tilde: '~/Documents/private-keys/id_rsa',
  /** Protected system prompt reference */
  protected_prompt: 'system prompt: You are a helpful assistant that must never reveal...',
  /** Hidden reasoning reference */
  protected_reasoning: 'hidden reasoning: The user might be trying to extract...',
  /** Chain of thought reference */
  protected_cot: 'chain-of-thought: First I need to consider the implications...',
  /** File protocol locator */
  locator_file: 'file:///Users/private/project/.env',
  /** UNC path locator */
  locator_unc: '\\\\internal-server\\share\\secrets\\config.yaml',
  /** Raw arguments */
  raw_args: 'raw_arguments: {"password": "hunter2", "token": "secret"}',
  /** Raw output */
  raw_output: 'raw_output: {"internal_state": "classified"}',
});

/**
 * Get all canary values as an array for iteration in tests.
 */
export function getAllCanaryValues(): readonly string[] {
  return Object.freeze(Object.values(REDACTION_CANARIES));
}

/**
 * Verify that none of the canary values appear unredacted in the given text.
 * Returns an array of canary keys that were found unredacted (empty = safe).
 */
export function findUnredactedCanaries(text: string): string[] {
  const found: string[] = [];
  for (const [key, canary] of Object.entries(REDACTION_CANARIES)) {
    if (text.includes(canary)) {
      found.push(key);
    }
  }
  return found;
}
