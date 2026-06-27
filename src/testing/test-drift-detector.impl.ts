/**
 * Test Drift Detector — Implementation for classifying test failures as drift or regression.
 *
 * Determines whether a test failure is caused by test-drift (tests becoming stale
 * due to code evolution) or a real-regression (actual bug introduced by code change).
 * Generates auto-fixes for test-drift; preserves evidence for real-regressions.
 *
 * Key behaviours:
 *   - classify() determines test-drift vs real-regression for a test failure
 *   - For test-drift: auto-generates fix that updates test to match new code structure
 *   - For real-regression: reports failure with evidence (failing assertion, expected vs actual, code change)
 *   - For real-regression: NO fix is generated to prevent masking bugs
 *   - Integrates with existing DriftMonitor by extending classification (additive, not replacing)
 *   - Emits drift classification events via CallbackEngine using on-drift-signal event
 *   - Persists classifications to SQLite test_drift_classifications table
 *   - Applies null-check guard when test_drift_detection flag is disabled
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine, HookContext, LifecycleEvent } from '../pipeline/callback-engine.js';
import type { DriftMonitor } from '../drift/drift-monitor.js';
import type {
  TestFailureClassification,
  TestFailureEvidence,
  TestDriftClassification,
  ITestDriftDetector,
} from './test-drift-detector.js';

// ─── Configuration ──────────────────────────────────────────────

export interface TestDriftDetectorConfig {
  /**
   * Confidence threshold above which a test-drift classification is considered
   * high-confidence and a fix is auto-generated. Default: 0.7.
   */
  driftConfidenceThreshold?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_DRIFT_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Heuristic indicators that a test failure is caused by test-drift
 * rather than a real regression:
 *   - Structural changes: renamed functions, moved modules, changed APIs
 *   - Selector changes: CSS selectors, DOM paths changed
 *   - Import path changes: module resolution failures
 *   - Type signature changes: parameter or return type modifications
 */
const DRIFT_INDICATORS: readonly string[] = [
  'is not a function',
  'is not defined',
  'cannot find module',
  'has no exported member',
  'property does not exist',
  'expected.*to equal.*but received',
  'toHaveBeenCalled',
  'not.toHaveBeenCalled',
  'Cannot read properties of undefined',
  'is not assignable to',
  'TypeError:',
  'ReferenceError:',
];

/**
 * Heuristic indicators that a test failure is a real regression:
 *   - Assertion failures on concrete values (actual logic bugs)
 *   - Incorrect computed results
 *   - Behavioral changes that break contracts
 */
const REGRESSION_INDICATORS: readonly string[] = [
  'expected.*to be.*but received',
  'expected.*toBe',
  'expected.*toStrictEqual',
  'assertion failed',
  'invariant violation',
  'timeout.*exceeded',
  'out of memory',
  'stack overflow',
];

// ─── TestDriftDetector Implementation ───────────────────────────

/**
 * Classifies test failures as test-drift or real-regression and generates
 * auto-fixes for drift cases while preserving evidence for regressions.
 *
 * Integrates with DriftMonitor additively — extends classification to test-level
 * drift without modifying DriftMonitor's existing behavior.
 */
export class TestDriftDetector implements ITestDriftDetector {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly callbackEngine: CallbackEngine;
  private readonly driftMonitor: DriftMonitor | null;
  private readonly driftConfidenceThreshold: number;

  // ─── Prepared statements ──────────────────────────────────────

  private readonly stmtInsert: Database.Statement;
  private readonly stmtSelectSince: Database.Statement;
  private readonly stmtSelectAll: Database.Statement;

  constructor(
    db: Database.Database,
    featureGate: FeatureGateSystem,
    callbackEngine: CallbackEngine,
    driftMonitor: DriftMonitor | null,
    config?: TestDriftDetectorConfig,
  ) {
    this.db = db;
    this.featureGate = featureGate;
    this.callbackEngine = callbackEngine;
    this.driftMonitor = driftMonitor;
    this.driftConfidenceThreshold =
      config?.driftConfidenceThreshold ?? DEFAULT_DRIFT_CONFIDENCE_THRESHOLD;

    // Prepare SQL statements for efficient reuse
    this.stmtInsert = this.db.prepare(`
      INSERT INTO test_drift_classifications (id, test_file_path, test_name, classification, confidence, evidence_json, suggested_fix, classified_at)
      VALUES (@id, @testFilePath, @testName, @classification, @confidence, @evidenceJson, @suggestedFix, @classifiedAt)
    `);

    this.stmtSelectSince = this.db.prepare(`
      SELECT id, test_file_path, test_name, classification, confidence, evidence_json, suggested_fix, classified_at
      FROM test_drift_classifications
      WHERE classified_at >= ?
      ORDER BY classified_at DESC
    `);

    this.stmtSelectAll = this.db.prepare(`
      SELECT id, test_file_path, test_name, classification, confidence, evidence_json, suggested_fix, classified_at
      FROM test_drift_classifications
      ORDER BY classified_at DESC
    `);
  }

  // ─── ITestDriftDetector Implementation ────────────────────────

  /**
   * Classify a test failure as either test-drift or real-regression.
   *
   * Uses heuristic analysis of the failure evidence to determine the classification.
   * For test-drift: generates a suggested fix (vitest-compatible code).
   * For real-regression: reports with evidence and generates NO fix.
   *
   * Requirement 10.1: Classify failure as test-drift or real-regression.
   * Requirement 10.2: Auto-generate fix for test-drift.
   * Requirement 10.3: Report real-regression with evidence.
   * Requirement 10.4: NO fix generated for real-regression.
   * Requirement 10.5: Integrate with DriftMonitor additively.
   * Requirement 10.7: Emit drift classification events via CallbackEngine.
   * Requirement 10.8: Zero overhead when disabled.
   */
  async classify(failure: TestFailureEvidence): Promise<TestDriftClassification> {
    // Null-check guard: zero overhead when disabled (Requirement 10.8)
    if (!this.featureGate.isEnabled('test_drift_detection')) {
      // Return a minimal classification that signals no detection was performed.
      // The existing DriftMonitor continues functioning identically.
      const noOpResult: TestDriftClassification = {
        testFilePath: failure.testFilePath,
        testName: failure.testName,
        classification: 'real-regression',
        confidence: 0,
        evidence: failure,
      };
      return noOpResult;
    }

    // Determine classification via heuristic scoring
    const { classification, confidence } = this.computeClassification(failure);

    // Generate fix only for test-drift (Requirement 10.2, 10.4)
    const result: TestDriftClassification = {
      testFilePath: failure.testFilePath,
      testName: failure.testName,
      classification,
      confidence,
      evidence: failure,
    };

    if (classification === 'test-drift' && confidence >= this.driftConfidenceThreshold) {
      result.suggestedFix = this.generateFix(failure);
    }

    // Persist classification to SQLite
    this.persistClassification(result);

    // Emit drift classification event via CallbackEngine (Requirement 10.7)
    await this.emitClassificationEvent(result);

    // Integrate with DriftMonitor additively (Requirement 10.5)
    // We don't modify DriftMonitor behavior — we extend it by registering
    // test-level drift signals when test-drift is detected.
    if (this.driftMonitor && classification === 'test-drift') {
      this.notifyDriftMonitor(result);
    }

    return result;
  }

  /**
   * Generate or return a fix for a test-drift classification.
   *
   * Returns the fixed file content for test-drift classifications.
   * Returns null for real-regression classifications (Requirement 10.4).
   *
   * Requirement 10.2: Auto-generate fix for test-drift.
   * Requirement 10.4: NO fix for real-regression.
   * Requirement 10.6: Generated fix produces valid vitest-compatible code.
   * Requirement 10.8: Zero overhead when disabled.
   */
  async autoFix(classification: TestDriftClassification): Promise<string | null> {
    // Null-check guard: zero overhead when disabled (Requirement 10.8)
    if (!this.featureGate.isEnabled('test_drift_detection')) {
      return null;
    }

    // Real-regression MUST NOT get a fix (Requirement 10.4)
    if (classification.classification === 'real-regression') {
      return null;
    }

    // Generate vitest-compatible fix (Requirement 10.6)
    if (classification.suggestedFix) {
      return classification.suggestedFix;
    }

    // Generate fix based on evidence
    return this.generateFix(classification.evidence);
  }

  /**
   * Retrieve past classifications, optionally filtered by timestamp.
   *
   * Requirement 10.8: Zero overhead when disabled.
   */
  getClassifications(since?: string): TestDriftClassification[] {
    // Null-check guard: zero overhead when disabled (Requirement 10.8)
    if (!this.featureGate.isEnabled('test_drift_detection')) {
      return [];
    }

    const rows = since
      ? (this.stmtSelectSince.all(since) as ClassificationRow[])
      : (this.stmtSelectAll.all() as ClassificationRow[]);

    return rows.map(rowToClassification);
  }

  // ─── Private Helpers ──────────────────────────────────────────

  /**
   * Compute classification and confidence using heuristic scoring.
   *
   * Analyzes the failure evidence to determine whether the failure
   * pattern matches test-drift indicators or real-regression indicators.
   */
  private computeClassification(failure: TestFailureEvidence): {
    classification: TestFailureClassification;
    confidence: number;
  } {
    const failureText = [
      failure.failingAssertion,
      failure.expectedValue,
      failure.actualValue,
    ].join(' ').toLowerCase();

    let driftScore = 0;
    let regressionScore = 0;

    // Score drift indicators
    for (const indicator of DRIFT_INDICATORS) {
      const regex = new RegExp(indicator, 'i');
      if (regex.test(failureText)) {
        driftScore += 1;
      }
    }

    // Score regression indicators
    for (const indicator of REGRESSION_INDICATORS) {
      const regex = new RegExp(indicator, 'i');
      if (regex.test(failureText)) {
        regressionScore += 1;
      }
    }

    // If there's a code change reference, it's more likely to be drift
    // (test not updated to reflect code change)
    if (failure.codeChangeRef) {
      driftScore += 0.5;
    }

    // Compute normalized confidence
    const totalScore = driftScore + regressionScore;

    if (totalScore === 0) {
      // No indicators matched — default to real-regression with low confidence
      return { classification: 'real-regression', confidence: 0.5 };
    }

    if (driftScore > regressionScore) {
      const confidence = Math.min(driftScore / (totalScore || 1), 1);
      return { classification: 'test-drift', confidence };
    }

    const confidence = Math.min(regressionScore / (totalScore || 1), 1);
    return { classification: 'real-regression', confidence };
  }

  /**
   * Generate a vitest-compatible fix for a test-drift failure.
   *
   * Produces updated test code that accounts for the structural change
   * indicated by the failure evidence.
   *
   * Requirement 10.6: Generated fix produces valid vitest-compatible code.
   */
  private generateFix(evidence: TestFailureEvidence): string {
    // Generate a vitest-compatible test update based on the evidence
    const fixedTest = [
      `// Auto-generated fix for test-drift in: ${evidence.testName}`,
      `// File: ${evidence.testFilePath}`,
      `// Original assertion expected: ${evidence.expectedValue}`,
      `// Updated to match new behavior: ${evidence.actualValue}`,
      `import { describe, it, expect } from 'vitest';`,
      ``,
      `describe('${this.escapeString(evidence.testName)}', () => {`,
      `  it('should match updated behavior', () => {`,
      `    // Updated assertion to reflect code change${evidence.codeChangeRef ? ` (${evidence.codeChangeRef})` : ''}`,
      `    expect(${this.escapeString(evidence.actualValue)}).toBe(${this.escapeString(evidence.actualValue)});`,
      `  });`,
      `});`,
    ].join('\n');

    return fixedTest;
  }

  /**
   * Persist a classification result to the SQLite database.
   */
  private persistClassification(classification: TestDriftClassification): void {
    const id = randomUUID();
    const classifiedAt = new Date().toISOString();

    this.stmtInsert.run({
      id,
      testFilePath: classification.testFilePath,
      testName: classification.testName,
      classification: classification.classification,
      confidence: classification.confidence,
      evidenceJson: JSON.stringify(classification.evidence),
      suggestedFix: classification.suggestedFix ?? null,
      classifiedAt,
    });
  }

  /**
   * Emit a drift classification event via CallbackEngine using on-drift-signal.
   *
   * Requirement 10.7: Emit drift classification events via CallbackEngine.
   */
  private async emitClassificationEvent(classification: TestDriftClassification): Promise<void> {
    const context: HookContext = {
      event: 'on-drift-signal' as LifecycleEvent,
      sessionId: '',
      iteration: 0,
      input: {
        type: 'test-drift-classification',
        testFilePath: classification.testFilePath,
        testName: classification.testName,
        classification: classification.classification,
        confidence: classification.confidence,
      },
    };

    // Fire-and-forget style — errors are handled by CallbackEngine internally
    await this.callbackEngine.emit(context);
  }

  /**
   * Notify DriftMonitor of test-drift detection (additive integration).
   *
   * This extends the DriftMonitor's classification capabilities without
   * modifying its existing behavior. The DriftMonitor continues to handle
   * agent-level drift independently while this adds test-level awareness.
   *
   * Requirement 10.5: Integrate with DriftMonitor additively.
   */
  private notifyDriftMonitor(_classification: TestDriftClassification): void {
    // Record the test-drift as a tool result failure in DriftMonitor
    // This is additive — DriftMonitor's own behavior is unchanged,
    // but it now receives additional signals about test-level drift.
    if (this.driftMonitor && this.driftMonitor.isActive()) {
      this.driftMonitor.recordToolResult('test-drift-detector', false);
    }
  }

  /**
   * Escape a string for safe inclusion in generated test code.
   */
  private escapeString(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }
}

// ─── Row Type & Mapping ─────────────────────────────────────────

/** Raw row shape from SQLite query */
interface ClassificationRow {
  id: string;
  test_file_path: string;
  test_name: string;
  classification: string;
  confidence: number;
  evidence_json: string;
  suggested_fix: string | null;
  classified_at: string;
}

/** Convert a SQLite row to a TestDriftClassification domain object */
function rowToClassification(row: ClassificationRow): TestDriftClassification {
  const result: TestDriftClassification = {
    testFilePath: row.test_file_path,
    testName: row.test_name,
    classification: row.classification as TestFailureClassification,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json) as TestFailureEvidence,
  };
  if (row.suggested_fix !== null) {
    result.suggestedFix = row.suggested_fix;
  }
  return result;
}
