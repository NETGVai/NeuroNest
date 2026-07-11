/**
 * Testgaps Worker — Background test coverage gap detection.
 *
 * Sweeps the codebase between sessions to identify test coverage gaps,
 * ranks them by risk, and files them into the task queue. Also includes
 * E2E_Scripts in the sweep for regression checking.
 *
 * Key constraints:
 * - Produces findings only — never edits code
 * - Ranks gaps by risk (high → medium → low)
 * - Includes E2E scripts in sweep for regression checking
 * - Can be triggered by QualityWorkersService
 *
 * Requirements: 12.6, 15.3
 */

import { randomUUID } from 'node:crypto';
import type { WorkerFinding, FindingSeverity, WorkerType } from '../quality-workers-service.js';

// ─── Types ──────────────────────────────────────────────────────

export type CoverageGapRisk = 'high' | 'medium' | 'low';

/**
 * Represents a test coverage gap detected in the codebase.
 */
export interface CoverageGap {
  /** File path with the uncovered export */
  filePath: string;
  /** Name of the uncovered symbol */
  symbolName: string;
  /** Type of symbol (function, class, constant) */
  symbolType: 'function' | 'class' | 'constant';
  /** Risk level of this gap */
  risk: CoverageGapRisk;
  /** Reason the gap is considered risky */
  riskReason: string;
}

/**
 * Represents an E2E script regression check result.
 */
export interface E2EScriptCheckResult {
  /** Path to the E2E script */
  scriptPath: string;
  /** Script ID */
  scriptId: string;
  /** Whether the script is still valid (selectors exist, etc.) */
  valid: boolean;
  /** Reason for invalidity, if applicable */
  invalidReason?: string;
}

/**
 * Result of a testgaps sweep.
 */
export interface TestgapsSweepResult {
  /** Coverage gaps found in the codebase */
  coverageGaps: CoverageGap[];
  /** E2E script regression check results */
  e2eScriptResults: E2EScriptCheckResult[];
  /** Timestamp of the sweep */
  timestamp: string;
  /** Total files scanned */
  filesScanned: number;
  /** Total E2E scripts checked */
  e2eScriptsChecked: number;
}

/**
 * Interface for scanning source files to detect coverage gaps.
 * In production, reads file system and test directories.
 */
export interface SourceFileScanner {
  /**
   * Scan project source files and return exported symbols.
   */
  scanSourceFiles(projectDir: string): Promise<SourceFileExport[]>;

  /**
   * Get existing test file paths for the project.
   */
  getTestFiles(projectDir: string): Promise<string[]>;
}

/**
 * Represents an exported symbol found in a source file.
 */
export interface SourceFileExport {
  filePath: string;
  exportName: string;
  exportType: 'function' | 'class' | 'constant';
  /** Whether the function is pure (no side effects) — used for risk assessment */
  isPure: boolean;
  /** Number of lines in the export */
  lineCount: number;
  /** Whether the file is in a security-sensitive path */
  isSecuritySensitive: boolean;
  /** Whether the file has high churn (many recent changes) */
  isHighChurn: boolean;
}

/**
 * Interface for scanning and validating E2E scripts.
 */
export interface E2EScriptScanner {
  /**
   * Find all E2E scripts in the project.
   */
  findE2EScripts(projectDir: string): Promise<E2EScriptInfo[]>;

  /**
   * Validate an E2E script — check that selectors are still valid.
   */
  validateScript(script: E2EScriptInfo, projectDir: string): Promise<E2EScriptCheckResult>;
}

/**
 * Minimal E2E script info for scanning purposes.
 */
export interface E2EScriptInfo {
  /** Path to the E2E script file */
  scriptPath: string;
  /** Script ID */
  scriptId: string;
  /** Selectors used in the script */
  selectors: string[];
  /** Whether the script was generated from GUI acceptance (vs manual) */
  isGenerated: boolean;
}

/**
 * Interface for filing coverage gaps into the task queue.
 */
export interface TaskQueueFiler {
  /**
   * File a coverage gap as a task in the task queue.
   * Returns the created task ID.
   */
  fileTask(gap: CoverageGap): Promise<string>;

  /**
   * File an E2E regression finding as a task.
   */
  fileE2ERegressionTask(result: E2EScriptCheckResult): Promise<string>;
}

// ─── Risk Ranking ───────────────────────────────────────────────

/** Risk weights for ranking coverage gaps */
const RISK_WEIGHTS: Record<string, number> = {
  securitySensitive: 0.35,
  highChurn: 0.25,
  lineCount: 0.20,
  isPure: 0.10,
  symbolType: 0.10,
};

/** Risk thresholds */
const HIGH_RISK_THRESHOLD = 0.65;
const MEDIUM_RISK_THRESHOLD = 0.35;

/**
 * Compute a risk score for an uncovered export.
 * Deterministic for given input.
 */
export function computeGapRiskScore(exp: SourceFileExport): number {
  let score = 0;

  // Security-sensitive files are always higher risk
  if (exp.isSecuritySensitive) {
    score += RISK_WEIGHTS.securitySensitive;
  }

  // High-churn files need coverage more urgently
  if (exp.isHighChurn) {
    score += RISK_WEIGHTS.highChurn;
  }

  // Larger exports are riskier when untested
  const lineScore = Math.min(exp.lineCount / 100, 1.0);
  score += RISK_WEIGHTS.lineCount * lineScore;

  // Pure functions are slightly less risky (easier to test, less side effects)
  if (!exp.isPure) {
    score += RISK_WEIGHTS.isPure;
  }

  // Classes are riskier than functions, functions riskier than constants
  const typeScore = exp.exportType === 'class' ? 1.0 : exp.exportType === 'function' ? 0.6 : 0.2;
  score += RISK_WEIGHTS.symbolType * typeScore;

  return Math.min(score, 1.0);
}

/**
 * Convert a numeric risk score to a risk level.
 */
export function scoreToRiskLevel(score: number): CoverageGapRisk {
  if (score >= HIGH_RISK_THRESHOLD) return 'high';
  if (score >= MEDIUM_RISK_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * Generate a human-readable risk reason from an export's attributes.
 */
export function generateRiskReason(exp: SourceFileExport, risk: CoverageGapRisk): string {
  const reasons: string[] = [];

  if (exp.isSecuritySensitive) {
    reasons.push('security-sensitive path');
  }
  if (exp.isHighChurn) {
    reasons.push('high churn file');
  }
  if (exp.lineCount > 50) {
    reasons.push(`large export (${exp.lineCount} lines)`);
  }
  if (!exp.isPure) {
    reasons.push('has side effects');
  }
  if (exp.exportType === 'class') {
    reasons.push('class with potential state');
  }

  if (reasons.length === 0) {
    return `Uncovered ${exp.exportType} with ${risk} risk`;
  }

  return reasons.join(', ');
}

// ─── Coverage Detection ─────────────────────────────────────────

/**
 * Check if an export is covered by existing tests.
 * Simple heuristic: looks for the export name referenced in test files.
 */
export function isExportCovered(exp: SourceFileExport, testFileContents: Map<string, string>): boolean {
  const testPatterns = [
    exp.exportName,
    `describe('${exp.exportName}`,
    `describe("${exp.exportName}`,
    `import { ${exp.exportName}`,
    `import {${exp.exportName}`,
    `from '${exp.filePath.replace(/\.ts$/, '')}`,
    `from "${exp.filePath.replace(/\.ts$/, '')}`,
  ];

  for (const [, content] of testFileContents) {
    for (const pattern of testPatterns) {
      if (content.includes(pattern)) {
        return true;
      }
    }
  }

  return false;
}

// ─── Default Implementations ────────────────────────────────────

/**
 * Default source file scanner — in production, reads the filesystem.
 * For testing, can be replaced with a mock.
 */
export class DefaultSourceFileScanner implements SourceFileScanner {
  async scanSourceFiles(projectDir: string): Promise<SourceFileExport[]> {
    // In production, this would:
    // 1. Walk the src/ directory
    // 2. Parse TypeScript/JavaScript files for exports
    // 3. Analyze each export for purity, line count, etc.
    // For now, returns empty — the worker relies on injected scanners.
    void projectDir;
    return [];
  }

  async getTestFiles(projectDir: string): Promise<string[]> {
    // In production, would walk test directories
    void projectDir;
    return [];
  }
}

/**
 * Default E2E script scanner — finds E2E scripts in the project.
 */
export class DefaultE2EScriptScanner implements E2EScriptScanner {
  async findE2EScripts(projectDir: string): Promise<E2EScriptInfo[]> {
    // In production, would scan tests/e2e/ directory
    void projectDir;
    return [];
  }

  async validateScript(script: E2EScriptInfo, projectDir: string): Promise<E2EScriptCheckResult> {
    // In production, would check if selectors still exist in the codebase
    void projectDir;
    return {
      scriptPath: script.scriptPath,
      scriptId: script.scriptId,
      valid: true,
    };
  }
}

/**
 * Default task queue filer — files tasks into the SQLite task queue.
 */
export class DefaultTaskQueueFiler implements TaskQueueFiler {
  async fileTask(gap: CoverageGap): Promise<string> {
    // In production, would insert into task queue table
    void gap;
    return randomUUID();
  }

  async fileE2ERegressionTask(result: E2EScriptCheckResult): Promise<string> {
    // In production, would insert into task queue table
    void result;
    return randomUUID();
  }
}

// ─── Testgaps Worker ────────────────────────────────────────────

export interface TestgapsWorkerConfig {
  /** Source file scanner for detecting exports */
  sourceScanner?: SourceFileScanner;
  /** E2E script scanner for regression checking */
  e2eScanner?: E2EScriptScanner;
  /** Task queue filer for filing gaps */
  taskQueueFiler?: TaskQueueFiler;
  /** Maximum number of gaps to file per sweep (avoids flooding) */
  maxGapsToFile?: number;
  /** Whether to include E2E scripts in the sweep */
  includeE2EScripts?: boolean;
}

/**
 * Testgaps Worker — sweeps the codebase between sessions to identify
 * test coverage gaps, ranks them by risk, and files them into the task queue.
 * Also includes E2E scripts in the sweep for regression checking.
 *
 * Requirements: 12.6, 15.3
 */
export class TestgapsWorker {
  private readonly sourceScanner: SourceFileScanner;
  private readonly e2eScanner: E2EScriptScanner;
  private readonly taskQueueFiler: TaskQueueFiler;
  private readonly maxGapsToFile: number;
  private readonly includeE2EScripts: boolean;

  constructor(config?: TestgapsWorkerConfig) {
    this.sourceScanner = config?.sourceScanner ?? new DefaultSourceFileScanner();
    this.e2eScanner = config?.e2eScanner ?? new DefaultE2EScriptScanner();
    this.taskQueueFiler = config?.taskQueueFiler ?? new DefaultTaskQueueFiler();
    this.maxGapsToFile = config?.maxGapsToFile ?? 20;
    this.includeE2EScripts = config?.includeE2EScripts ?? true;
  }

  /**
   * Execute a full testgaps sweep on the project.
   * 1. Scan source files for exported symbols
   * 2. Check which exports lack test coverage
   * 3. Rank uncovered exports by risk
   * 4. Scan E2E scripts for regression issues
   * 5. File ranked gaps into the task queue
   * 6. Return findings for the QualityWorkersService
   */
  async sweep(projectDir: string): Promise<TestgapsSweepResult> {
    // 1. Scan source files
    const exports = await this.sourceScanner.scanSourceFiles(projectDir);
    const testFiles = await this.sourceScanner.getTestFiles(projectDir);

    // Build a map of test file contents (simulated — in production reads files)
    const testFileContents = new Map<string, string>();
    for (const tf of testFiles) {
      // In production, would read the file content
      testFileContents.set(tf, tf);
    }

    // 2. Identify uncovered exports
    const uncoveredExports = exports.filter(exp => !isExportCovered(exp, testFileContents));

    // 3. Rank by risk
    const rankedGaps: CoverageGap[] = uncoveredExports
      .map(exp => {
        const score = computeGapRiskScore(exp);
        const risk = scoreToRiskLevel(score);
        return {
          filePath: exp.filePath,
          symbolName: exp.exportName,
          symbolType: exp.exportType,
          risk,
          riskReason: generateRiskReason(exp, risk),
        };
      })
      .sort((a, b) => {
        const riskOrder: Record<CoverageGapRisk, number> = { high: 3, medium: 2, low: 1 };
        return riskOrder[b.risk] - riskOrder[a.risk];
      });

    // 4. E2E script regression checking
    let e2eResults: E2EScriptCheckResult[] = [];
    let e2eScriptsChecked = 0;

    if (this.includeE2EScripts) {
      const scripts = await this.e2eScanner.findE2EScripts(projectDir);
      e2eScriptsChecked = scripts.length;

      e2eResults = await Promise.all(
        scripts.map(script => this.e2eScanner.validateScript(script, projectDir)),
      );
    }

    // 5. File top-ranked gaps into the task queue
    const gapsToFile = rankedGaps.slice(0, this.maxGapsToFile);
    for (const gap of gapsToFile) {
      await this.taskQueueFiler.fileTask(gap);
    }

    // File E2E regression issues
    const invalidScripts = e2eResults.filter(r => !r.valid);
    for (const result of invalidScripts) {
      await this.taskQueueFiler.fileE2ERegressionTask(result);
    }

    return {
      coverageGaps: rankedGaps,
      e2eScriptResults: e2eResults,
      timestamp: new Date().toISOString(),
      filesScanned: exports.length,
      e2eScriptsChecked,
    };
  }

  /**
   * Convert sweep results into WorkerFinding objects for the QualityWorkersService.
   * Findings are ranked by severity based on risk level.
   */
  toWorkerFindings(result: TestgapsSweepResult): WorkerFinding[] {
    const findings: WorkerFinding[] = [];

    // Convert coverage gaps to findings
    for (const gap of result.coverageGaps) {
      const severity = riskToSeverity(gap.risk);
      findings.push({
        id: randomUUID(),
        worker: 'testgaps' as WorkerType,
        severity,
        file: gap.filePath,
        description: `Untested ${gap.symbolType} "${gap.symbolName}" — ${gap.riskReason}`,
        recommendation: generateTestRecommendation(gap),
        createdAt: result.timestamp,
        resolved: false,
      });
    }

    // Convert E2E script regression issues to findings
    for (const e2eResult of result.e2eScriptResults) {
      if (!e2eResult.valid) {
        findings.push({
          id: randomUUID(),
          worker: 'testgaps' as WorkerType,
          severity: 'warning',
          file: e2eResult.scriptPath,
          description: `E2E script "${e2eResult.scriptId}" is broken: ${e2eResult.invalidReason || 'unknown reason'}`,
          recommendation: 'Re-run GUI acceptance to regenerate the E2E script, or fix broken selectors manually.',
          createdAt: result.timestamp,
          resolved: false,
        });
      }
    }

    return findings;
  }
}

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Map risk level to finding severity.
 */
function riskToSeverity(risk: CoverageGapRisk): FindingSeverity {
  switch (risk) {
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
      return 'info';
  }
}

/**
 * Generate a test recommendation based on the coverage gap.
 */
function generateTestRecommendation(gap: CoverageGap): string {
  switch (gap.symbolType) {
    case 'function':
      return `Add property-based tests for "${gap.symbolName}" using fast-check. Focus on input domain coverage and edge cases.`;
    case 'class':
      return `Add unit tests for "${gap.symbolName}" covering constructor, public methods, and state transitions.`;
    case 'constant':
      return `Add a snapshot or assertion test verifying the value of "${gap.symbolName}" matches expected shape.`;
  }
}
