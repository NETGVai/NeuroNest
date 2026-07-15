/**
 * PermissionPatternEngine — Declarative allow/deny pattern matcher for tool operations.
 *
 * Evaluated before the Action_Security_Analyzer to enable zero-prompt execution
 * of approved operations (e.g., read-only ops) during unattended loop runs.
 *
 * Pattern format: "ToolName(argument_pattern)" where argument_pattern supports
 * glob-like matching with * (any chars) and ** (recursive path matching).
 * Examples: "Read(*)", "Bash(git status:*)", "Write(src/**)"
 *
 * Evaluation order (deny-first):
 *   1. Check ALL deny patterns across all hierarchy levels. If ANY deny matches → 'deny'
 *   2. Check allow patterns in hierarchy order (managed → project → local → user).
 *      If match → 'allow'
 *   3. No match → 'no-match' (falls through to Action_Security_Analyzer)
 *
 * Resolution hierarchy: managed > project > local > user
 *   - Managed patterns are injected by enterprise/managed config (highest priority for allow)
 *   - Project patterns come from .neuronest/settings.json
 *   - Local patterns come from .neuronest/settings.local.json (gitignored)
 *   - User patterns are passed in at construction (lowest priority)
 *
 * Never-touch patterns (from NEURONEST.md / GOAL.md) are absolute deny rules
 * that cannot be overridden by any allow pattern.
 *
 * REQ-19.7: When a loop run is active (isLoopActive = true), the engine returns
 * 'allow' for operations that are not explicitly denied, even without explicit
 * allow patterns. This enables zero-prompt execution during unattended loops.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface PermissionPattern {
  tool: string;       // Tool name (e.g., "Bash", "Read", "Write")
  argPattern: string; // Glob pattern for arguments (e.g., "git status:*", "*")
}

export interface PermissionConfig {
  allow: string[]; // e.g., ["Read(*)", "Bash(git status:*)"]
  deny: string[];  // e.g., ["Bash(rm -rf:*)"]
}

export type PatternDecision = 'allow' | 'deny' | 'no-match';

/** Hierarchy levels in priority order (highest first) */
export type HierarchyLevel = 'managed' | 'project' | 'local' | 'user';

// ─── Pattern Parsing ────────────────────────────────────────────

/**
 * Parse a pattern string like "ToolName(arg_pattern)" into structured form.
 * Returns null if the pattern is malformed.
 */
export function parsePattern(pattern: string): PermissionPattern | null {
  const match = pattern.match(/^([A-Za-z_][A-Za-z0-9_]*)\((.+)\)$/);
  if (!match) return null;
  return { tool: match[1]!, argPattern: match[2]! };
}

/**
 * Convert a glob-like argument pattern to a RegExp.
 * Supports:
 *   ** → matches anything (explicit recursive notation for paths)
 *   *  → matches anything (tool args are not file paths, so * is unrestricted)
 *   ?  → matches single character
 *   All other regex-special chars are escaped.
 *
 * In tool argument patterns, * is treated as "match anything" since arguments
 * are not strictly file paths. Patterns like "Read(*)" should match any argument
 * including paths with separators (e.g., "src/index.ts").
 */
export function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches everything (explicit recursive path notation)
      regexStr += '.*';
      i += 2;
      // Skip optional trailing slash after **
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      // * matches anything (unrestricted for tool argument patterns)
      regexStr += '.*';
      i++;
    } else if (ch === '?') {
      regexStr += '.';
      i++;
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      // Escape regex-special characters
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  return new RegExp(`^${regexStr}$`);
}

/**
 * Test whether a tool invocation matches a pattern string.
 */
export function matchesPattern(toolName: string, args: string, pattern: string): boolean {
  const parsed = parsePattern(pattern);
  if (!parsed) return false;

  // Tool name must match exactly (case-sensitive)
  if (parsed.tool !== toolName) return false;

  // Match arguments against the glob pattern
  const regex = globToRegex(parsed.argPattern);
  return regex.test(args);
}

// ─── Main Engine ────────────────────────────────────────────────

const EMPTY_CONFIG: PermissionConfig = { allow: [], deny: [] };

export class PermissionPatternEngine {
  private managedPatterns: PermissionConfig = { ...EMPTY_CONFIG };
  private projectPatterns: PermissionConfig = { ...EMPTY_CONFIG };
  private localPatterns: PermissionConfig = { ...EMPTY_CONFIG };
  private userPatterns: PermissionConfig = { ...EMPTY_CONFIG };
  private neverTouchDeny: string[] = [];
  private _isLoopActive = false;

  constructor(private readonly workspacePath: string) {
    this.reload();
  }

  /**
   * Whether a loop run is currently active.
   * When true, operations that are not denied get 'allow' even without
   * explicit allow patterns (REQ-19.7).
   */
  get isLoopActive(): boolean {
    return this._isLoopActive;
  }

  set isLoopActive(active: boolean) {
    this._isLoopActive = active;
  }

  /**
   * Evaluate a tool invocation against patterns.
   *
   * Deny-first semantics (REQ-19.2):
   *   1. Any deny match (from any level or Never-touch) → 'deny'
   *   2. Allow match (in hierarchy order: managed → project → local → user) → 'allow'
   *   3. If loop is active (REQ-19.7) and not denied → 'allow'
   *   4. No match → 'no-match' (falls through to Action_Security_Analyzer)
   */
  evaluate(toolName: string, args: string): PatternDecision {
    // ── Step 1: Check ALL deny patterns (absolute, unoverridable) ──
    // Never-touch deny patterns are absolute (REQ-19.4, 20.6)
    for (const pattern of this.neverTouchDeny) {
      if (matchesPattern(toolName, args, pattern)) {
        return 'deny';
      }
    }

    // Check deny patterns from all hierarchy levels
    const allConfigs: PermissionConfig[] = [
      this.managedPatterns,
      this.projectPatterns,
      this.localPatterns,
      this.userPatterns,
    ];

    for (const config of allConfigs) {
      for (const pattern of config.deny) {
        if (matchesPattern(toolName, args, pattern)) {
          return 'deny';
        }
      }
    }

    // ── Step 2: Check allow patterns in hierarchy order ──
    // Managed first (highest priority), then project, local, user (REQ-19.4)
    for (const config of allConfigs) {
      for (const pattern of config.allow) {
        if (matchesPattern(toolName, args, pattern)) {
          return 'allow';
        }
      }
    }

    // ── Step 3: Loop-active zero-prompt execution (REQ-19.7) ──
    if (this._isLoopActive) {
      return 'allow';
    }

    // ── Step 4: No match — fall through to ASA ──
    return 'no-match';
  }

  /**
   * Load patterns from .neuronest/settings.json and .neuronest/settings.local.json.
   * Silently handles missing files (no patterns loaded from that source).
   */
  reload(): void {
    this.projectPatterns = this.loadConfigFile(
      join(this.workspacePath, '.neuronest', 'settings.json'),
    );
    this.localPatterns = this.loadConfigFile(
      join(this.workspacePath, '.neuronest', 'settings.local.json'),
    );
  }

  /**
   * Inject absolute deny patterns from Never-touch declarations
   * (NEURONEST.md + GOAL.md). These are unoverridable.
   */
  injectNeverTouch(patterns: string[]): void {
    this.neverTouchDeny = [...patterns];
  }

  /**
   * Set managed-level patterns (enterprise/organizational override).
   * Managed patterns have the highest priority in the allow hierarchy.
   */
  setManagedPatterns(config: PermissionConfig): void {
    this.managedPatterns = { ...config };
  }

  /**
   * Set user-level patterns (personal defaults, lowest priority).
   */
  setUserPatterns(config: PermissionConfig): void {
    this.userPatterns = { ...config };
  }

  /**
   * Get all deny patterns across all levels (for inspection/debugging).
   */
  getAllDenyPatterns(): string[] {
    return [
      ...this.neverTouchDeny,
      ...this.managedPatterns.deny,
      ...this.projectPatterns.deny,
      ...this.localPatterns.deny,
      ...this.userPatterns.deny,
    ];
  }

  /**
   * Get all allow patterns across all levels in hierarchy order.
   */
  getAllAllowPatterns(): string[] {
    return [
      ...this.managedPatterns.allow,
      ...this.projectPatterns.allow,
      ...this.localPatterns.allow,
      ...this.userPatterns.allow,
    ];
  }

  // ─── Private ────────────────────────────────────────────────────

  private loadConfigFile(filePath: string): PermissionConfig {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const json = JSON.parse(content);

      // Extract permission patterns from the settings file
      const permissions = json?.permissions ?? json;
      const allow = Array.isArray(permissions?.allow)
        ? permissions.allow.filter((p: unknown) => typeof p === 'string')
        : [];
      const deny = Array.isArray(permissions?.deny)
        ? permissions.deny.filter((p: unknown) => typeof p === 'string')
        : [];

      return { allow, deny };
    } catch {
      // File doesn't exist or is invalid — no patterns from this source
      return { ...EMPTY_CONFIG };
    }
  }
}
