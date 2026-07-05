// ─── Verifier Subagent ─────────────────────────────────────────
// Adversarial fresh-context verifier dispatched after each loop pass.
// Catches fake-done shortcuts that consensus-based verification misses.
// Non-bypassable when harness_subagents flag is enabled.
// Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8

import { getLogger } from '../../utils/structured-logger';

const LOG_SOURCE = 'VerifierSubagent';

// ─── Types ─────────────────────────────────────────────────────

/**
 * Input to the verifier subagent.
 * Contains only the diff, goal, and outputs — zero maker-conversation tokens (REQ-23.1, 23.2).
 */
export interface VerifierInput {
  goalMd: string;
  diff: string;
  testOutput: string;
  lintOutput: string;
}

/**
 * A detected fake-done shortcut pattern.
 */
export interface ShortcutDetection {
  id: string;
  line?: number;
  reason: string;
}

/**
 * Structured result from the verifier subagent.
 */
export interface VerifierResult {
  passes: boolean;
  failures: Array<{ line: number; reason: string }>;
  shortcutsDetected: ShortcutDetection[];
  contextTokensUsed: number;
}

/**
 * Result from verify-array-only mode (when harness_subagents is disabled).
 * Pass/fail determined solely by LoopSpec verify array checks (REQ-23.7).
 */
export interface VerifyArrayOnlyResult {
  passes: boolean;
  failures: Array<{ line: number; reason: string }>;
  mode: 'verify-array-only';
}

// ─── Shortcut Catalog ──────────────────────────────────────────

/**
 * The 11 fake-done shortcut patterns (REQ-23.4).
 * Each pattern has an id, description, and detection regex/heuristic.
 */
export const SHORTCUT_CATALOG = [
  'relaxed_test_assertion',
  'swallowed_error',
  'fake_rename',
  'stub_return',
  'comment_deletion_as_fix',
  'skipped_test',
  'hardcoded_expected',
  'narrowed_test_scope',
  'weakened_types_any_cast',
  'todo_as_done',
  'mocked_away_integration',
] as const;

export type ShortcutId = typeof SHORTCUT_CATALOG[number];

/**
 * Internal pattern definition for shortcut detection.
 */
interface ShortcutPattern {
  id: ShortcutId;
  /** Regex patterns applied to added lines in the diff */
  patterns: RegExp[];
  /** Human-readable reason for the detection */
  reason: string;
}

/**
 * The full catalog of shortcut detection patterns.
 * Each pattern uses regex heuristics against the diff to detect fake-done shortcuts.
 */
const SHORTCUT_PATTERNS: ShortcutPattern[] = [
  {
    id: 'relaxed_test_assertion',
    patterns: [
      // Removed or weakened assertions (e.g., expect().toBeTruthy() replacing strict checks)
      /^\+.*expect\(.*\)\.(toBeTruthy|toBeDefined|not\.toThrow)\(\)/,
      // Deleted assertions (line removed that had expect/assert)
      /^-.*\b(expect|assert|assertEquals|assertEqual)\b/,
    ],
    reason: 'Test assertion was relaxed or deleted — may hide real failures',
  },
  {
    id: 'swallowed_error',
    patterns: [
      // Empty catch blocks
      /^\+.*catch\s*\([^)]*\)\s*\{\s*\}/,
      // Catch with only a comment or empty body
      /^\+.*catch\s*\([^)]*\)\s*\{\s*(\/\/|\/\*)/,
      // Catch that ignores the error variable entirely (single-line)
      /^\+.*catch\s*\(_?\w*\)\s*\{\s*\}/,
    ],
    reason: 'Error is caught but silently swallowed — failures will go undetected',
  },
  {
    id: 'fake_rename',
    patterns: [
      // Renamed function/variable without updating implementation
      /^\+.*(function|const|let|var)\s+\w*(Temp|Dummy|Placeholder|FIXME|HACK)\b/,
      // Rename-only diff: same line removed and added with only identifier changes
      /^\+.*\/\/\s*renamed/i,
    ],
    reason: 'Identifier renamed without meaningful implementation change',
  },
  {
    id: 'stub_return',
    patterns: [
      // Return statements with hardcoded trivial values in functions
      /^\+\s*(return\s+(null|undefined|''|""|``|\[\]|\{\}|0|false|true)\s*;)/,
      // Functions that return nothing meaningful (throw not implemented)
      /^\+.*throw new Error\(['"`](not implemented|TODO|FIXME)/i,
    ],
    reason: 'Function returns a stub/placeholder value instead of real implementation',
  },
  {
    id: 'comment_deletion_as_fix',
    patterns: [
      // Removing TODO/FIXME/HACK comments without implementing the fix
      /^-\s*\/\/\s*(TODO|FIXME|HACK|BUG|XXX)\b/i,
      // Removing block comments describing issues
      /^-\s*\/\*\*?\s*(TODO|FIXME|HACK|BUG)\b/i,
    ],
    reason: 'Comment describing a known issue was deleted without implementing a fix',
  },
  {
    id: 'skipped_test',
    patterns: [
      // Adding .skip to tests
      /^\+.*(describe|it|test)\.(skip|todo)\(/,
      // Adding skip annotations
      /^\+.*@(Skip|Ignore|Disabled|xtest|xit)/,
      // Replacing it() with xit() or xdescribe()
      /^\+\s*(xit|xdescribe|xtest)\(/,
      // Pending tests
      /^\+.*pending\(\s*['"`]/,
    ],
    reason: 'Test was skipped or disabled instead of being fixed',
  },
  {
    id: 'hardcoded_expected',
    patterns: [
      // Changing expected values to match actual (test fitting)
      /^\+.*expect\(.*\)\.(toBe|toEqual|toStrictEqual)\(\s*(true|false|null|undefined|\d+|['"`])/,
      // Snapshot updates (could be legitimate, but flagged as suspicious)
      /^\+.*toMatchInlineSnapshot\(/,
    ],
    reason: 'Expected value appears hardcoded to match current output rather than testing correctness',
  },
  {
    id: 'narrowed_test_scope',
    patterns: [
      // Reducing test coverage by removing test cases
      /^-\s*(it|test|describe)\s*\(/,
      // Removing parameterized test cases
      /^-.*\.(each|forEach)\s*\(/,
      // Adding .only (runs only this test, skipping others)
      /^\+.*(describe|it|test)\.only\(/,
    ],
    reason: 'Test scope was narrowed — fewer cases being validated',
  },
  {
    id: 'weakened_types_any_cast',
    patterns: [
      // Adding 'as any' casts
      /^\+.*\bas\s+any\b/,
      // Adding @ts-ignore or @ts-expect-error
      /^\+.*\/\/\s*@ts-(ignore|expect-error|nocheck)/,
      // Using type assertion to 'unknown' then 'any'
      /^\+.*as\s+unknown\s+as\b/,
      // Changing strict types to 'any'
      /^\+.*:\s*any\b/,
    ],
    reason: 'Type safety was weakened with any-casts or directive suppressions',
  },
  {
    id: 'todo_as_done',
    patterns: [
      // Adding TODO/FIXME in new code claiming to be done
      /^\+.*\/\/\s*(TODO|FIXME|HACK|XXX)\b.*\b(later|eventually|next|someday)\b/i,
      // Placeholder implementations marked as temporary
      /^\+.*\/\/\s*(temporary|placeholder|stub|mock|fake)\b/i,
    ],
    reason: 'New code contains TODO/placeholder markers — implementation is incomplete',
  },
  {
    id: 'mocked_away_integration',
    patterns: [
      // Adding vi.mock/jest.mock for integration-level modules
      /^\+.*(vi|jest)\.(mock|spyOn)\(/,
      // Adding mock implementations that bypass real integration
      /^\+.*mockImplementation\(\s*\(\)\s*=>\s*(null|undefined|\{\}|\[\]|Promise\.resolve)\b/,
      // Replacing real imports with mocks
      /^\+.*mock\(['"`]\.\.?\//,
    ],
    reason: 'Integration test replaced with mocks — real behavior is no longer verified',
  },
];

// ─── Dispatch Log ──────────────────────────────────────────────

/**
 * Log entry for a verifier dispatch, recording context assertion (REQ-23.8).
 */
export interface VerifierDispatchLog {
  timestamp: string;
  makerConversationTokens: number;
  contextAssertionPassed: boolean;
  inputTokenEstimate: number;
}

// ─── VerifierSubagent Class ────────────────────────────────────

/**
 * Estimate tokens using chars/4 approximation (same as context-budget.ts).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parse diff lines and extract added/removed lines with line numbers.
 */
function parseDiffLines(diff: string): Array<{ type: '+' | '-'; lineNumber: number; content: string }> {
  const lines = diff.split('\n');
  const parsed: Array<{ type: '+' | '-'; lineNumber: number; content: string }> = [];
  let currentLine = 0;

  for (const line of lines) {
    // Track line numbers from hunk headers
    const hunkMatch = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch && hunkMatch[1] !== undefined) {
      currentLine = parseInt(hunkMatch[1], 10) - 1;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentLine++;
      parsed.push({ type: '+', lineNumber: currentLine, content: line });
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      parsed.push({ type: '-', lineNumber: currentLine, content: line });
    } else if (!line.startsWith('\\')) {
      currentLine++;
    }
  }

  return parsed;
}

/**
 * VerifierSubagent — adversarial fresh-context verifier.
 *
 * Dispatched after each EXECUTING_PASS with zero maker-conversation tokens.
 * Scans the diff for 11 fake-done shortcut patterns and returns a structured result.
 *
 * Non-bypassable (REQ-23.6): When harness_subagents is enabled, no config can skip dispatch.
 *
 * REQ-23.7: When harness_subagents is disabled, use verifyArrayOnly() — pass/fail
 * determined solely by LoopSpec verify array checks with no additional criteria.
 *
 * REQ-23.8: Zero maker-conversation-token context assertion is enforced only when
 * the verifier is actually dispatched, via a context-size assertion logged per dispatch.
 */
export class VerifierSubagent {
  private readonly dispatchLog: VerifierDispatchLog[] = [];

  /**
   * Dispatch verification with fresh (zero maker-conversation) context.
   * Non-bypassable: no config can skip this when harness_subagents is enabled (REQ-23.6).
   *
   * REQ-23.8: The zero maker-conversation-token context assertion is enforced
   * only when the verifier is actually dispatched, via a context-size assertion
   * logged per dispatch.
   *
   * @param input - The verifier input containing goal, diff, test output, and lint output.
   * @param makerConversationTokens - The number of maker-conversation tokens in context (must be 0).
   * @returns Structured VerifierResult with passes, failures, and shortcutsDetected.
   */
  async verify(input: VerifierInput, makerConversationTokens: number = 0): Promise<VerifierResult> {
    // ─── REQ-23.8: Context-size assertion logged per dispatch ───
    const contextAssertionPassed = makerConversationTokens === 0;
    const inputTokenEstimate = this.estimateInputTokens(input);

    const dispatchEntry: VerifierDispatchLog = {
      timestamp: new Date().toISOString(),
      makerConversationTokens,
      contextAssertionPassed,
      inputTokenEstimate,
    };
    this.dispatchLog.push(dispatchEntry);

    if (!contextAssertionPassed) {
      // Log assertion failure — context is not fresh
      getLogger().warn(LOG_SOURCE, `Context assertion FAILED: ${makerConversationTokens} maker-conversation tokens detected (expected 0)`, {
        timestamp: dispatchEntry.timestamp,
      });
    }

    // ─── Scan diff for shortcut patterns (REQ-23.4) ───
    const shortcutsDetected = this.detectShortcuts(input.diff);
    const failures: Array<{ line: number; reason: string }> = [];

    // Convert shortcut detections to failures
    for (const shortcut of shortcutsDetected) {
      failures.push({
        line: shortcut.line ?? 0,
        reason: `Shortcut detected [${shortcut.id}]: ${shortcut.reason}`,
      });
    }

    // ─── REQ-23.5: Any shortcut detection fails the pass regardless ───
    const passes = shortcutsDetected.length === 0;

    return {
      passes,
      failures,
      shortcutsDetected,
      contextTokensUsed: inputTokenEstimate,
    };
  }

  /**
   * Verify-array-only mode (REQ-23.7).
   * When harness_subagents is disabled, pass/fail is determined solely and exactly
   * by LoopSpec verify array checks — no additional criteria applied.
   *
   * This method does NOT dispatch the verifier subagent, does NOT check for shortcuts,
   * and does NOT enforce the context assertion.
   *
   * @param verifyCheckResults - Array of pass/fail results from LoopSpec verify array.
   * @returns VerifyArrayOnlyResult with passes determined solely by verify checks.
   */
  static verifyArrayOnly(
    verifyCheckResults: Array<{ checkIndex: number; passed: boolean; reason?: string }>,
  ): VerifyArrayOnlyResult {
    const failures: Array<{ line: number; reason: string }> = [];

    for (const result of verifyCheckResults) {
      if (!result.passed) {
        failures.push({
          line: result.checkIndex,
          reason: result.reason ?? `Verify check ${result.checkIndex} failed`,
        });
      }
    }

    return {
      passes: failures.length === 0,
      failures,
      mode: 'verify-array-only',
    };
  }

  /**
   * Get the dispatch log for auditing (REQ-23.8).
   */
  getDispatchLog(): ReadonlyArray<VerifierDispatchLog> {
    return [...this.dispatchLog];
  }

  /**
   * Get the last dispatch log entry.
   */
  getLastDispatchLog(): VerifierDispatchLog | undefined {
    return this.dispatchLog[this.dispatchLog.length - 1];
  }

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * Detect shortcut patterns in the diff (REQ-23.4).
   * Scans each line of the diff against all 11 shortcut pattern regexes.
   */
  private detectShortcuts(diff: string): ShortcutDetection[] {
    const detections: ShortcutDetection[] = [];
    const diffLines = parseDiffLines(diff);

    for (const pattern of SHORTCUT_PATTERNS) {
      for (const diffLine of diffLines) {
        for (const regex of pattern.patterns) {
          if (regex.test(diffLine.content)) {
            detections.push({
              id: pattern.id,
              line: diffLine.lineNumber,
              reason: pattern.reason,
            });
            // Only report first match per pattern per line
            break;
          }
        }
      }
    }

    // Deduplicate: keep only unique (id, line) pairs
    const seen = new Set<string>();
    const unique: ShortcutDetection[] = [];
    for (const detection of detections) {
      const key = `${detection.id}:${detection.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(detection);
      }
    }

    return unique;
  }

  /**
   * Estimate the total token cost of the verifier input.
   */
  private estimateInputTokens(input: VerifierInput): number {
    return (
      estimateTokens(input.goalMd) +
      estimateTokens(input.diff) +
      estimateTokens(input.testOutput) +
      estimateTokens(input.lintOutput)
    );
  }
}
