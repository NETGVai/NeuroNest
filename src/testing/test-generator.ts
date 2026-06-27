/**
 * Test Generator — Interfaces for AI-driven test code generation.
 *
 * Generates vitest-compatible test files from test plans or PR diffs,
 * following project conventions and including property-based tests where appropriate.
 *
 * Requirements: 9.1–9.7
 */

import type { TestCaseType } from './test-planner.js';

// ─── Types ──────────────────────────────────────────────────────

/** Generated test file metadata */
export interface GeneratedTestFile {
  id: string;
  planId?: string;
  filePath: string;
  sourceModule: string;
  testType: TestCaseType;
  generatedAt: string;
  lastRunStatus?: 'pass' | 'fail' | 'pending';
}

/** Test generation input */
export interface TestGenerationInput {
  planId?: string;
  diff?: string;               // unified diff string
  gitRange?: string;           // e.g., "HEAD~3..HEAD"
  targetFile?: string;
}

/** Test generation result */
export interface TestGenerationResult {
  files: GeneratedTestFile[];
  totalTestCases: number;
  errors: string[];
}

/** Test Generator interface */
export interface ITestGenerator {
  generate(input: TestGenerationInput): Promise<TestGenerationResult>;
  getGeneratedTests(planId?: string): GeneratedTestFile[];
}
