// ─── Verifier Subagent ─────────────────────────────────────────
// Adversarial fresh-context verifier dispatched after each loop pass.
// Catches fake-done shortcuts that consensus-based verification misses.
// Non-bypassable when harness_subagents flag is enabled.
// Requirements: 23.1, 23.2, 23.3, 23.4, 23.5, 23.6, 23.7, 23.8
// Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 10.4

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

// ─── Lean Comment Types (Requirement 6) ────────────────────────

/**
 * A parsed, well-formed Lean Comment.
 * Pattern: `// lean: <ceiling_name> — <upgrade_path>`
 */
export interface LeanComment {
  ceilingName: string;
  upgradePath: string;
}

/**
 * Context about the file being analyzed, used for safety exclusion checks.
 */
export interface FileContext {
  filePath: string;
  /** Optional list of safety-related annotations or categories found in file metadata */
  safetyAnnotations?: string[];
}

/**
 * A Debt Ledger entry for intentional lean simplifications.
 * Stored in `.neuronest/memory/lean-debt.json`.
 */
export interface DebtLedgerEntry {
  filePath: string;
  lineNumber: number;
  ceilingName: string;
  upgradePath: string;
  timestamp: string; // ISO 8601
}

/**
 * Result from the verifier reconciliation process for a single line.
 */
export interface ReconciliationResult {
  /** Whether the line is classified as intentional (lean comment exempt) */
  intentional: boolean;
  /** The debt ledger entry if intentional */
  debtEntry?: DebtLedgerEntry;
  /** Whether the line is safety-excluded (always flagged) */
  safetyExcluded: boolean;
  /** The shortcut detection if flagged */
  shortcutDetection?: ShortcutDetection;
}

// ─── Lean Comment Regex ────────────────────────────────────────

/**
 * Regex for well-formed Lean Comments (REQ-6.4).
 * Pattern: `// lean: <ceiling_name> — <upgrade_path>`
 * - ceiling_name: non-empty identifier (\S+)
 * - upgrade_path: non-empty description (.+)
 * - The em-dash (—) separates ceiling from upgrade path
 */
export const LEAN_COMMENT_REGEX = /\/\/\s*lean:\s*(\S+)\s*—\s*(.+)$/;

/**
 * Safety Exclusion categories (REQ-10.4).
 * Lines involving these categories are NEVER exempted by lean comments.
 */
export const SAFETY_EXCLUSION_CATEGORIES = [
  'trust-boundary',
  'data-loss',
  'security',
  'a11y',
] as const;

export type SafetyCategory = typeof SAFETY_EXCLUSION_CATEGORIES[number];

/**
 * Patterns that indicate a line involves a safety-excluded category.
 * Used by isSafetyExclusion() to determine if lean comments should be ignored.
 */
const SAFETY_EXCLUSION_PATTERNS: Array<{ category: SafetyCategory; patterns: RegExp[] }> = [
  {
    category: 'trust-boundary',
    patterns: [
      /\b(validate|sanitize|verify|authenticate|authorize|checkPermission|verifyToken|checkAuth)\b/i,
      /(trustBoundary|trust[_-]boundary|input[_-]?validation|csrf|xss)/i,
      /\b(escapeHtml|encodeURI|sanitizeInput|validateInput)\b/i,
    ],
  },
  {
    category: 'data-loss',
    patterns: [
      /(backup|rollback|transaction|commit|persist|flush|sync|fsync)/i,
      /(data[_-]?loss|data[_-]?integrity|corruption|atomic[_-]?write)/i,
      /(ensureSaved|preventLoss|durability|WAL)/i,
    ],
  },
  {
    category: 'security',
    patterns: [
      /\b(encrypt|decrypt|hash|hmac|sign|verify[_-]?signature)\b/i,
      /(secret|credential|apiKey|api[_-]?key|password|token|jwt|oauth)/i,
      /(firewall|rateLimit|rate[_-]?limit|blacklist|whitelist|allowlist|denylist)/i,
      /\b(security|secure|tls|ssl|certificate|cert)\b/i,
    ],
  },
  {
    category: 'a11y',
    patterns: [
      /(aria[_-]|role=|tabIndex|tabindex|alt=|sr[_-]?only|screenReader)/i,
      /\b(accessibility|a11y|wcag|accessible)\b/i,
      /(focus[_-]?trap|live[_-]?region|announce|labelledby|describedby)/i,
    ],
  },
];

// ─── Lean Comment Functions ────────────────────────────────────

/**
 * Parse and validate a Lean Comment on a given line (REQ-6.4).
 * Returns a LeanComment if the line contains a well-formed comment,
 * or null if the comment is absent or malformed.
 *
 * A well-formed Lean Comment follows the pattern:
 *   `// lean: <ceiling_name> — <upgrade_path>`
 * where ceiling_name is a non-empty identifier and upgrade_path is a non-empty description.
 */
export function parseLeanComment(line: string): LeanComment | null {
  const match = line.match(LEAN_COMMENT_REGEX);
  if (!match) {
    return null;
  }

  const ceilingName = match[1];
  const upgradePath = match[2]?.trim();

  // Validate: ceiling_name must be non-empty and upgrade_path must be non-empty
  if (!ceilingName || !upgradePath) {
    return null;
  }

  return {
    ceilingName,
    upgradePath,
  };
}

/**
 * Check if a line involves a Safety_Exclusion category (REQ-10.4).
 * Lines with safety-excluded patterns are NEVER exempted by lean comments.
 *
 * Safety categories: trust-boundary, data-loss, security, a11y
 *
 * @param line - The code line to check
 * @param context - The file context (path and annotations)
 * @returns true if the line involves a safety-excluded category
 */
export function isSafetyExclusion(line: string, context: FileContext): boolean {
  // Check file-level safety annotations from context
  if (context.safetyAnnotations?.length) {
    for (const annotation of context.safetyAnnotations) {
      const normalizedAnnotation = annotation.toLowerCase().replace(/[\s_]/g, '-');
      if (SAFETY_EXCLUSION_CATEGORIES.some(cat => normalizedAnnotation.includes(cat))) {
        return true;
      }
    }
  }

  // Check line content against safety exclusion patterns
  for (const { patterns } of SAFETY_EXCLUSION_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Reconcile a detected shortcut with Lean Comment presence and safety exclusion (REQ-6.1–6.5, 6.7, 10.4).
 *
 * Logic:
 * 1. If line is in a safety-excluded category → flag as shortcut (no exemption), regardless of comment
 * 2. If line has a well-formed Lean Comment → classify as intentional, route to Debt Ledger
 * 3. If line has a malformed Lean Comment or no comment → flag as shortcut (no exemption)
 *
 * @param line - The code line content
 * @param lineNumber - The line number in the file
 * @param filePath - The file path
 * @param context - The file context for safety checks
 * @param shortcutId - The detected shortcut pattern id
 * @param shortcutReason - The reason for the shortcut detection
 * @returns ReconciliationResult indicating how to handle the line
 */
export function reconcileShortcut(
  line: string,
  lineNumber: number,
  filePath: string,
  context: FileContext,
  shortcutId: string,
  shortcutReason: string,
): ReconciliationResult {
  // Step 1: Safety exclusion check — always flag regardless of comment (REQ-10.4)
  if (isSafetyExclusion(line, context)) {
    return {
      intentional: false,
      safetyExcluded: true,
      shortcutDetection: {
        id: shortcutId,
        line: lineNumber,
        reason: `${shortcutReason} [SAFETY-EXCLUDED: lean comment does not exempt safety-critical code]`,
      },
    };
  }

  // Step 2: Parse Lean Comment
  const leanComment = parseLeanComment(line);

  // Step 3: Well-formed comment → intentional, route to Debt Ledger (REQ-6.1, 6.2, 6.3, 6.5)
  if (leanComment) {
    const debtEntry: DebtLedgerEntry = {
      filePath,
      lineNumber,
      ceilingName: leanComment.ceilingName,
      upgradePath: leanComment.upgradePath,
      timestamp: new Date().toISOString(),
    };

    return {
      intentional: true,
      debtEntry,
      safetyExcluded: false,
    };
  }

  // Step 4: No comment or malformed comment → flag as shortcut (REQ-6.7)
  return {
    intentional: false,
    safetyExcluded: false,
    shortcutDetection: {
      id: shortcutId,
      line: lineNumber,
      reason: shortcutReason,
    },
  };
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
  private readonly pendingDebtEntries: DebtLedgerEntry[] = [];

  /**
   * Dispatch verification with fresh (zero maker-conversation) context.
   * Non-bypassable: no config can skip this when harness_subagents is enabled (REQ-23.6).
   *
   * REQ-23.8: The zero maker-conversation-token context assertion is enforced
   * only when the verifier is actually dispatched, via a context-size assertion
   * logged per dispatch.
   *
   * REQ-6.1–6.5, 6.7, 10.4: Reconciles detected shortcuts with Lean Comments.
   * Lines with well-formed Lean Comments that are not safety-excluded are
   * classified as intentional and routed to the Debt Ledger.
   *
   * @param input - The verifier input containing goal, diff, test output, and lint output.
   * @param makerConversationTokens - The number of maker-conversation tokens in context (must be 0).
   * @param fileContext - Optional file context for safety exclusion checks during reconciliation.
   * @returns Structured VerifierResult with passes, failures, and shortcutsDetected.
   */
  async verify(input: VerifierInput, makerConversationTokens: number = 0, fileContext?: FileContext): Promise<VerifierResult> {
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
    // ─── Reconcile with Lean Comments (REQ-6.1–6.5, 6.7, 10.4) ───
    const { shortcutsDetected, debtEntries } = this.detectAndReconcileShortcuts(input.diff, fileContext);
    const failures: Array<{ line: number; reason: string }> = [];

    // Store debt entries for lines classified as intentional
    if (debtEntries.length > 0) {
      this.pendingDebtEntries.push(...debtEntries);
    }

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

  /**
   * Get pending Debt Ledger entries accumulated from reconciliation (REQ-6.5).
   * These entries should be written to `.neuronest/memory/lean-debt.json`.
   */
  getPendingDebtEntries(): ReadonlyArray<DebtLedgerEntry> {
    return [...this.pendingDebtEntries];
  }

  /**
   * Clear pending debt entries after they've been persisted to the ledger.
   */
  clearPendingDebtEntries(): void {
    this.pendingDebtEntries.length = 0;
  }

  // ─── Private Helpers ─────────────────────────────────────────

  /**
   * Detect shortcut patterns in the diff and reconcile with Lean Comments (REQ-6.1–6.5, 6.7, 10.4).
   *
   * For each detected shortcut:
   * 1. If safety-excluded → always flag (no exemption)
   * 2. If well-formed Lean Comment present and NOT safety-excluded → classify as intentional, add debt entry
   * 3. If malformed or no Lean Comment → flag as shortcut
   *
   * @param diff - The diff string to scan
   * @param fileContext - Optional file context for safety exclusion checks
   * @returns Object containing filtered shortcuts (still flagged) and debt entries (intentional)
   */
  private detectAndReconcileShortcuts(
    diff: string,
    fileContext?: FileContext,
  ): { shortcutsDetected: ShortcutDetection[]; debtEntries: DebtLedgerEntry[] } {
    const rawDetections = this.detectShortcuts(diff);

    // If no file context provided, skip reconciliation — all detections remain as shortcuts
    if (!fileContext) {
      return { shortcutsDetected: rawDetections, debtEntries: [] };
    }

    const diffLines = parseDiffLines(diff);
    const shortcutsDetected: ShortcutDetection[] = [];
    const debtEntries: DebtLedgerEntry[] = [];

    for (const detection of rawDetections) {
      // Find the diff line content for this detection
      const diffLine = diffLines.find(dl => dl.lineNumber === detection.line);
      const lineContent = diffLine?.content?.slice(1) ?? ''; // remove leading +/-

      const result = reconcileShortcut(
        lineContent,
        detection.line ?? 0,
        fileContext.filePath,
        fileContext,
        detection.id,
        detection.reason,
      );

      if (result.intentional && result.debtEntry) {
        // Line is intentional — route to Debt Ledger, exclude from shortcuts
        debtEntries.push(result.debtEntry);
      } else if (result.shortcutDetection) {
        // Line is flagged (safety-excluded or no/malformed comment)
        shortcutsDetected.push(result.shortcutDetection);
      }
    }

    return { shortcutsDetected, debtEntries };
  }

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
