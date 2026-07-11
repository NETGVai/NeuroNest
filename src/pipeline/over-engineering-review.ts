/**
 * Over-Engineering Review Pass
 *
 * Analyzes session diffs for bloat patterns and emits advisory findings.
 * Integrates as a verification gate stage BEFORE TestGapDetectorStage.
 *
 * Detects five bloat patterns:
 * 1. Reinvented standard library functionality
 * 2. Redundant dependencies
 * 3. Single-implementation abstractions
 * 4. Unnecessary wrapper classes
 * 5. Premature generalization
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
 */
import type {
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  Diagnostic,
  StageName,
} from './verification-gate/types';
import type { RepairFeedback } from './self-healing-loop';

// ─── Types ──────────────────────────────────────────────────────

export type BloatTag = 'delete' | 'stdlib' | 'native' | 'yagni' | 'shrink';

export interface BloatFinding {
  /** Classification tag for the type of bloat detected */
  tag: BloatTag;
  /** File path where the bloat was found */
  file: string;
  /** Line number where the bloat starts */
  line: number;
  /** Human-readable description of the finding */
  description: string;
  /** Estimated net line reduction (positive integer) */
  netLineReduction: number;
}

export interface OverEngineeringReviewResult {
  /** List of bloat findings */
  findings: BloatFinding[];
  /** Sum of all netLineReduction values */
  totalNetReduction: number;
  /** Operating mode — advisory presents suggestions, blocking fails the pipeline */
  mode: 'advisory' | 'blocking';
}

// ─── Pattern Detectors ──────────────────────────────────────────

/**
 * Known stdlib patterns that are commonly reinvented.
 * Maps regex patterns to descriptions and tags.
 */
const STDLIB_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
  estimatedLines: number;
}> = [
  {
    pattern: /function\s+flatten\s*[<(]/,
    description: 'Reinvented Array.prototype.flat() — use native flat()',
    estimatedLines: 8,
  },
  {
    pattern: /function\s+deepClone\s*[<(]/,
    description: 'Reinvented structuredClone() — use native structuredClone()',
    estimatedLines: 15,
  },
  {
    pattern: /function\s+debounce\s*[<(]/,
    description: 'Reinvented debounce — consider using a well-known utility library',
    estimatedLines: 10,
  },
  {
    pattern: /function\s+throttle\s*[<(]/,
    description: 'Reinvented throttle — consider using a well-known utility library',
    estimatedLines: 10,
  },
  {
    pattern: /function\s+isEqual\s*[<(]/,
    description: 'Reinvented deep equality check — use Node.js util.isDeepStrictEqual()',
    estimatedLines: 20,
  },
  {
    pattern: /function\s+groupBy\s*[<(]/,
    description: 'Reinvented groupBy — use Object.groupBy() or Map.groupBy()',
    estimatedLines: 8,
  },
  {
    pattern: /function\s+sleep\s*\(/,
    description: 'Reinvented sleep — use util.promisify(setTimeout) or timers/promises',
    estimatedLines: 3,
  },
  {
    pattern: /function\s+padStart\s*[<(]/,
    description: 'Reinvented padStart — use String.prototype.padStart()',
    estimatedLines: 5,
  },
];

/**
 * Patterns indicating single-implementation abstractions.
 */
const SINGLE_IMPL_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
  estimatedLines: number;
}> = [
  {
    pattern: /(?:abstract\s+class|interface)\s+(?:\w*(?:Base|Abstract)\w*|I[A-Z]\w*)/,
    description: 'Abstract class/interface with likely single implementation — consider inlining',
    estimatedLines: 12,
  },
];

/**
 * Patterns indicating unnecessary wrapper classes.
 */
const WRAPPER_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
  estimatedLines: number;
}> = [
  {
    pattern: /class\s+\w+Wrapper\s/,
    description: 'Unnecessary wrapper class — consider removing delegation layer',
    estimatedLines: 15,
  },
  {
    pattern: /class\s+\w+Proxy\s(?!.*implements\s+ProxyHandler)/,
    description: 'Custom proxy class — consider using native Proxy if delegation is needed',
    estimatedLines: 12,
  },
];

/**
 * Patterns indicating premature generalization.
 */
const GENERALIZATION_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
  estimatedLines: number;
}> = [
  {
    pattern: /class\s+\w+Factory\s/,
    description: 'Factory pattern with possibly single product — may be premature generalization',
    estimatedLines: 20,
  },
  {
    pattern: /class\s+\w+Strategy\s/,
    description: 'Strategy pattern — verify multiple strategies exist before abstracting',
    estimatedLines: 15,
  },
  {
    pattern: /class\s+\w+Builder\s.*\{/,
    description: 'Builder pattern — verify complexity warrants builder over direct construction',
    estimatedLines: 25,
  },
];

// ─── Analysis Engine ────────────────────────────────────────────

/**
 * Scans file content lines for bloat patterns and returns findings.
 */
function detectPatterns(
  content: string,
  filePath: string,
  patterns: Array<{ pattern: RegExp; description: string; estimatedLines: number }>,
  tag: BloatTag,
): BloatFinding[] {
  const findings: BloatFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, description, estimatedLines } of patterns) {
      if (pattern.test(lines[i])) {
        findings.push({
          tag,
          file: filePath,
          line: i + 1, // 1-indexed
          description,
          netLineReduction: estimatedLines,
        });
      }
    }
  }

  return findings;
}

/**
 * Detects redundant dependencies by finding imports from packages
 * that duplicate stdlib functionality.
 */
const REDUNDANT_DEP_PATTERNS: Array<{
  pattern: RegExp;
  description: string;
  estimatedLines: number;
}> = [
  {
    pattern: /import\s+.*\bfrom\s+['"]is-number['"]/,
    description: 'Redundant dep "is-number" — use Number.isFinite() or typeof check',
    estimatedLines: 1,
  },
  {
    pattern: /import\s+.*\bfrom\s+['"]is-odd['"]/,
    description: 'Redundant dep "is-odd" — use n % 2 !== 0',
    estimatedLines: 1,
  },
  {
    pattern: /import\s+.*\bfrom\s+['"]is-even['"]/,
    description: 'Redundant dep "is-even" — use n % 2 === 0',
    estimatedLines: 1,
  },
  {
    pattern: /import\s+.*\bfrom\s+['"]left-pad['"]/,
    description: 'Redundant dep "left-pad" — use String.prototype.padStart()',
    estimatedLines: 1,
  },
  {
    pattern: /import\s+.*\bfrom\s+['"]is-array['"]/,
    description: 'Redundant dep "is-array" — use Array.isArray()',
    estimatedLines: 1,
  },
  {
    pattern: /import\s+.*\bfrom\s+['"]object-assign['"]/,
    description: 'Redundant dep "object-assign" — use Object.assign() or spread syntax',
    estimatedLines: 1,
  },
];

// ─── Over-Engineering Review Class ──────────────────────────────

export class OverEngineeringReview {
  private mode: 'advisory' | 'blocking';

  constructor(mode: 'advisory' | 'blocking' = 'advisory') {
    this.mode = mode;
  }

  /**
   * Analyze a diff for bloat patterns.
   * Detects: reinvented stdlib, redundant deps, single-impl abstractions,
   * unnecessary wrappers, premature generalization.
   */
  analyze(diff: AgentEdit, context: ProjectContext): OverEngineeringReviewResult {
    const allFindings: BloatFinding[] = [];

    for (const change of diff.changes) {
      const content = change.content;
      const filePath = change.filePath;

      // 1. Reinvented stdlib
      allFindings.push(...detectPatterns(content, filePath, STDLIB_PATTERNS, 'stdlib'));

      // 2. Redundant dependencies
      allFindings.push(...detectPatterns(content, filePath, REDUNDANT_DEP_PATTERNS, 'delete'));

      // 3. Single-implementation abstractions
      allFindings.push(...detectPatterns(content, filePath, SINGLE_IMPL_PATTERNS, 'yagni'));

      // 4. Unnecessary wrappers
      allFindings.push(...detectPatterns(content, filePath, WRAPPER_PATTERNS, 'native'));

      // 5. Premature generalization
      allFindings.push(...detectPatterns(content, filePath, GENERALIZATION_PATTERNS, 'shrink'));
    }

    const totalNetReduction = allFindings.reduce((sum, f) => sum + f.netLineReduction, 0);

    return {
      findings: allFindings,
      totalNetReduction,
      mode: this.mode,
    };
  }

  /**
   * Feed findings into self-healing loop as structured repair feedback.
   * Converts BloatFinding[] into RepairFeedback[] consumable by the self-healing loop.
   */
  toRepairFeedback(findings: BloatFinding[]): RepairFeedback[] {
    return findings.map((finding) => ({
      stage: 'over-engineering-review',
      errorMessage: `[${finding.tag}] ${finding.description} (net: -${finding.netLineReduction} lines)`,
      filePath: finding.file,
      lineNumber: finding.line,
    }));
  }
}

// ─── Verification Gate Stage ────────────────────────────────────

export class OverEngineeringReviewStage implements VerificationStage {
  readonly name = 'over-engineering-review' as StageName;
  readonly score = 2;

  private review: OverEngineeringReview;

  constructor(mode: 'advisory' | 'blocking' = 'advisory') {
    this.review = new OverEngineeringReview(mode);
  }

  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();

    const result = this.review.analyze(edit, context);

    // Map findings to diagnostics
    const diagnostics: Diagnostic[] = result.findings.map((finding) => ({
      file: finding.file,
      line: finding.line,
      column: 0,
      message: `[${finding.tag}] ${finding.description} (net: -${finding.netLineReduction} lines)`,
      severity: result.mode === 'blocking' ? 'error' as const : 'warning' as const,
    }));

    // Advisory mode always passes; blocking mode fails if findings exist
    const passed = result.mode === 'advisory' || result.findings.length === 0;

    return {
      stageName: this.name,
      passed,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Get the underlying review instance for self-healing integration.
   */
  getReview(): OverEngineeringReview {
    return this.review;
  }
}
