/**
 * Test Drift Detector — Interfaces for classifying test failures as drift or regression.
 *
 * Determines whether a test failure is caused by test-drift (tests becoming stale
 * due to code evolution) or a real-regression (actual bug introduced by code change).
 * Generates auto-fixes for test-drift; preserves evidence for real-regressions.
 *
 * Requirements: 10.1–10.8
 */

// Dependencies: DriftMonitor, CallbackEngine (used at implementation time)

// ─── Types ──────────────────────────────────────────────────────

/** Drift classification for test failures */
export type TestFailureClassification = 'test-drift' | 'real-regression';

/** Evidence for a test failure classification */
export interface TestFailureEvidence {
  testFilePath: string;
  testName: string;
  failingAssertion: string;
  expectedValue: string;
  actualValue: string;
  codeChangeRef?: string;      // commit or diff that caused the failure
}

/** Classification result */
export interface TestDriftClassification {
  testFilePath: string;
  testName: string;
  classification: TestFailureClassification;
  confidence: number;          // 0-1 confidence in the classification
  evidence: TestFailureEvidence;
  suggestedFix?: string;       // vitest-compatible code fix (only for test-drift)
}

/** Test Drift Detector interface */
export interface ITestDriftDetector {
  classify(failure: TestFailureEvidence): Promise<TestDriftClassification>;
  autoFix(classification: TestDriftClassification): Promise<string | null>;  // returns fixed file content
  getClassifications(since?: string): TestDriftClassification[];
}
