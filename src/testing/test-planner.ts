/**
 * Test Planner — Interfaces for AI-driven test plan generation.
 *
 * Analyzes codebases and specifications to produce structured test plans
 * with categorized test cases, coverage gap identification, and summaries.
 *
 * Requirements: 8.1–8.7
 */

// Dependencies: CallbackEngine (used at implementation time)

// ─── Types ──────────────────────────────────────────────────────

/** Test case type categorization */
export type TestCaseType = 'unit' | 'integration' | 'property-based' | 'end-to-end';

/** A single test case in a plan */
export interface PlannedTestCase {
  id: string;
  title: string;
  type: TestCaseType;
  targetModule: string;
  targetFunction?: string;
  description: string;
  inputs?: string[];
  expectedBehavior: string;
  priority: 'high' | 'medium' | 'low';
  existingCoverage: boolean;
}

/** A complete test plan */
export interface TestPlan {
  id: string;
  title: string;
  createdAt: string;
  sourceSpec?: string;
  testCases: PlannedTestCase[];
  coverageGaps: CoverageGap[];
  summary: TestPlanSummary;
}

export interface CoverageGap {
  module: string;
  description: string;
  suggestedTestType: TestCaseType;
}

export interface TestPlanSummary {
  totalCases: number;
  byType: Record<TestCaseType, number>;
  coverageGapsFound: number;
}

/** Test Planner interface */
export interface ITestPlanner {
  generatePlan(input: TestPlanInput): Promise<TestPlan>;
  listPlans(): TestPlan[];
  getPlan(planId: string): TestPlan | null;
}

export interface TestPlanInput {
  specificationPath?: string;
  naturalLanguageDescription?: string;
  targetModules?: string[];
}
