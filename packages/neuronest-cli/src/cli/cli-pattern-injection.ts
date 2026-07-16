// File: packages/neuronest-cli/src/cli/cli-pattern-injection.ts
//
// Parses and validates `--allow`, `--deny`, and `--ask` CLI permission
// pattern flags and prepares them for injection as user-tier patterns
// into the PermissionPatternEngine (stage 2 of the Authorization Pipeline).
//
// Pattern format: "ToolName(argument_pattern)" where argument_pattern
// supports glob-like matching with * (any chars) and ** (recursive).
//
// Examples:
//   --allow "file_read(*)" --allow "bash(git *)"
//   --deny "bash(rm *)"
//   --ask "file_write(**)"
//
// `--ask` patterns are converted to deny patterns with a special marker
// prefix that the authorization pipeline interprets as "prompt the user"
// rather than "hard deny". For headless CLI where no user is present,
// ask patterns follow the session's permission policy (auto-approve-all
// approves them, deny-all denies them).
//
// Validates: Requirement 10.12

// ─── Types ──────────────────────────────────────────────────────

/**
 * Permission config structure matching the PermissionPatternEngine's
 * PermissionConfig interface. Duplicated here to avoid cross-package
 * value imports; the CLI package only depends on the structure, not the
 * implementation.
 */
export interface PermissionConfig {
  allow: string[];
  deny: string[];
}

/**
 * Raw CLI permission flags as parsed from argv.
 * Each flag can appear multiple times (yargs array option).
 */
export interface CliPermissionFlags {
  allow?: string | string[];
  deny?: string | string[];
  ask?: string | string[];
}

/**
 * Validated and structured permission patterns ready for injection
 * into the PermissionPatternEngine as user-tier patterns.
 */
export interface CliInjectedPatterns {
  /** Patterns to inject into the allow list. */
  allow: string[];
  /** Patterns to inject into the deny list (includes ask-converted patterns). */
  deny: string[];
  /**
   * Original ask patterns (before conversion).
   * These are tracked separately so the authorization pipeline can
   * distinguish hard-deny from ask-deny when a user is present.
   */
  ask: string[];
}

/**
 * Result of pattern validation. If `errors` is non-empty, some
 * patterns were malformed and should cause a config error.
 */
export interface PatternValidationResult {
  /** Successfully validated patterns ready for injection. */
  patterns: CliInjectedPatterns;
  /** Validation errors for malformed patterns. */
  errors: string[];
}

// ─── Constants ──────────────────────────────────────────────────

/**
 * Prefix marker for ask-converted deny patterns.
 * The authorization pipeline checks for this prefix when deciding
 * whether to hard-deny or prompt the user.
 */
export const ASK_PATTERN_PREFIX = '__ask__:';

// ─── Pattern Validation ─────────────────────────────────────────

/**
 * Validate a permission pattern string. Must match "ToolName(arg_pattern)"
 * where ToolName starts with a letter or underscore, followed by
 * alphanumeric/underscore characters, and arg_pattern is non-empty.
 *
 * This is the same regex as PermissionPatternEngine.parsePattern() to
 * ensure CLI-validated patterns are accepted by the engine without
 * needing a cross-package import.
 */
function isValidPattern(pattern: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*\(.+\)$/.test(pattern);
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Normalize a CLI flag value (string or string[]) into a string array.
 * Handles: undefined, single string, array of strings.
 */
export function normalizePatternFlag(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  return value.filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Parse and validate CLI permission patterns from `--allow`, `--deny`,
 * and `--ask` flags. Returns validated patterns and any errors.
 *
 * Each pattern MUST match the format `ToolName(argument_pattern)`.
 * Invalid patterns are collected as errors rather than silently dropped.
 *
 * Ask patterns are converted to deny-list entries with the ASK_PATTERN_PREFIX
 * so that the authorization pipeline can distinguish them from hard denies.
 */
export function validateCliPatterns(flags: CliPermissionFlags): PatternValidationResult {
  const allowRaw = normalizePatternFlag(flags.allow);
  const denyRaw = normalizePatternFlag(flags.deny);
  const askRaw = normalizePatternFlag(flags.ask);

  const errors: string[] = [];
  const validAllow: string[] = [];
  const validDeny: string[] = [];
  const validAsk: string[] = [];

  // Validate --allow patterns
  for (const pattern of allowRaw) {
    if (!isValidPattern(pattern)) {
      errors.push(`Invalid --allow pattern: "${pattern}" (expected format: ToolName(arg_pattern))`);
    } else {
      validAllow.push(pattern);
    }
  }

  // Validate --deny patterns
  for (const pattern of denyRaw) {
    if (!isValidPattern(pattern)) {
      errors.push(`Invalid --deny pattern: "${pattern}" (expected format: ToolName(arg_pattern))`);
    } else {
      validDeny.push(pattern);
    }
  }

  // Validate --ask patterns
  for (const pattern of askRaw) {
    if (!isValidPattern(pattern)) {
      errors.push(`Invalid --ask pattern: "${pattern}" (expected format: ToolName(arg_pattern))`);
    } else {
      validAsk.push(pattern);
    }
  }

  return {
    patterns: {
      allow: validAllow,
      deny: validDeny,
      ask: validAsk,
    },
    errors,
  };
}

/**
 * Build a PermissionConfig suitable for injection via
 * `PermissionPatternEngine.setUserPatterns()`.
 *
 * - `--allow` patterns go into the allow list.
 * - `--deny` patterns go into the deny list.
 * - `--ask` patterns are converted to deny patterns with an ASK_PATTERN_PREFIX
 *   marker so the authorization pipeline can trigger a prompt rather than
 *   a hard deny when in interactive mode. In headless/auto mode, ask patterns
 *   behave as denies (requiring the session's permission policy to override).
 */
export function buildUserTierConfig(patterns: CliInjectedPatterns): PermissionConfig {
  // Ask patterns are added as specially-prefixed deny patterns.
  // The engine's deny evaluation will match them; the pipeline's
  // mode-policy stage can then check for the prefix and convert
  // the denial into a prompt when running interactively.
  const askAsDeny = patterns.ask.map((p) => `${ASK_PATTERN_PREFIX}${p}`);

  return {
    allow: [...patterns.allow],
    deny: [...patterns.deny, ...askAsDeny],
  };
}

/**
 * Convenience: parse flags, validate, build config in one step.
 * Returns either a valid PermissionConfig or error messages.
 */
export function parseAndBuildPermissionConfig(
  flags: CliPermissionFlags,
): { ok: true; config: PermissionConfig; askPatterns: string[] } | { ok: false; errors: string[] } {
  const result = validateCliPatterns(flags);

  if (result.errors.length > 0) {
    return { ok: false, errors: result.errors };
  }

  const config = buildUserTierConfig(result.patterns);
  return { ok: true, config, askPatterns: result.patterns.ask };
}

/**
 * Check whether a deny pattern is actually an ask-converted pattern.
 * Used by the authorization pipeline to distinguish hard denies from prompts.
 */
export function isAskPattern(denyPattern: string): boolean {
  return denyPattern.startsWith(ASK_PATTERN_PREFIX);
}

/**
 * Extract the original pattern from an ask-prefixed deny pattern.
 */
export function extractAskPattern(prefixedPattern: string): string {
  if (prefixedPattern.startsWith(ASK_PATTERN_PREFIX)) {
    return prefixedPattern.slice(ASK_PATTERN_PREFIX.length);
  }
  return prefixedPattern;
}
