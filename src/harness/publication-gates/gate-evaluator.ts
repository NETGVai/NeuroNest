/**
 * Publication Gate Evaluator
 *
 * Evaluates gate categories for publishable artifacts by running test suites
 * and collecting results. Produces ArtifactPublicationDecision records that
 * determine whether an artifact is safe to publish.
 *
 * The evaluator supports independent artifact evaluation — evaluating one
 * MCP artifact does not require starting or depending on the other.
 *
 * Requirements: 33.4–33.9, 46.13, 46.17, 47.13, 47.19
 */

import type {
  ArtifactPublicationDecision,
  GateCategory,
  GateEvaluationResult,
  PublicationGateReport,
  PublishableArtifact,
} from './types.js';
import {
  ARTIFACT_GATES,
  GATE_CATEGORIES,
  getRequiredGatesForArtifacts,
} from './gate-config.js';

/**
 * Interface for test runner implementations.
 * Allows injection of different runners (vitest, stub, etc.) for testing.
 */
export interface TestRunner {
  /**
   * Run tests matching the given patterns and return structured results.
   *
   * @param patterns - Glob patterns for test files to include
   * @param timeout - Maximum time allowed (ms)
   */
  run(patterns: string[], timeout: number): Promise<TestRunResult>;
}

/**
 * Result from running a set of tests.
 */
export interface TestRunResult {
  /** Whether all tests passed */
  success: boolean;
  /** Count of passing tests */
  passed: number;
  /** Count of failing tests */
  failed: number;
  /** Count of skipped tests */
  skipped: number;
  /** Duration of the run (ms) */
  durationMs: number;
  /** Descriptions of failures */
  failures: string[];
}

/**
 * Evaluates a single gate category by running its associated tests.
 */
export async function evaluateGateCategory(
  category: GateCategory,
  runner: TestRunner,
  artifact?: PublishableArtifact,
): Promise<GateEvaluationResult> {
  const config = GATE_CATEGORIES[category];
  const patterns = config.testPatterns;
  const timeout = config.timeout ?? 60_000;

  const start = Date.now();
  let result: TestRunResult;

  try {
    result = await runner.run(patterns, timeout);
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return {
      category,
      passed: false,
      testsPassed: 0,
      testsFailed: 0,
      testsSkipped: 0,
      durationMs,
      summary: `${config.label}: FAILED — runner error: ${message}`,
      failures: [message],
    };
  }

  const durationMs = Date.now() - start;
  const passed = result.success && result.failed === 0;

  return {
    category,
    passed,
    testsPassed: result.passed,
    testsFailed: result.failed,
    testsSkipped: result.skipped,
    durationMs,
    summary: passed
      ? `${config.label}: PASSED (${result.passed} tests, ${durationMs}ms)`
      : `${config.label}: FAILED (${result.failed} failures, ${result.passed} passed, ${durationMs}ms)`,
    failures: result.failures.length > 0 ? result.failures : undefined,
  };
}

/**
 * Evaluates all required gates for a single artifact and produces a publication decision.
 *
 * Each artifact's gates are evaluated independently. If any blocking gate fails,
 * the artifact is not publishable.
 */
export async function evaluateArtifactGates(
  artifact: PublishableArtifact,
  runner: TestRunner,
): Promise<ArtifactPublicationDecision> {
  const artifactConfig = ARTIFACT_GATES[artifact];
  const gateResults: GateEvaluationResult[] = [];
  const blockingGates: GateCategory[] = [];
  const totalStart = Date.now();

  for (const category of artifactConfig.requiredGates) {
    const categoryConfig = GATE_CATEGORIES[category];
    const result = await evaluateGateCategory(category, runner, artifact);
    gateResults.push(result);

    if (!result.passed && categoryConfig.blocking) {
      blockingGates.push(category);
    }
  }

  const totalDurationMs = Date.now() - totalStart;

  return {
    artifact,
    publishable: blockingGates.length === 0,
    blockingGates,
    gateResults,
    evaluatedAt: new Date().toISOString(),
    totalDurationMs,
  };
}

/**
 * Evaluates publication gates for multiple artifacts and produces a full report.
 *
 * Gate categories shared across artifacts are evaluated once and results reused.
 * Each artifact can be evaluated independently.
 */
export async function evaluatePublicationGates(
  artifacts: PublishableArtifact[],
  runner: TestRunner,
): Promise<PublicationGateReport> {
  // Run each unique gate category once and cache the result
  const requiredCategories = getRequiredGatesForArtifacts(artifacts);
  const categoryResults = new Map<GateCategory, GateEvaluationResult>();

  for (const category of requiredCategories) {
    const result = await evaluateGateCategory(category, runner);
    categoryResults.set(category, result);
  }

  // Build per-artifact decisions using cached category results
  const decisions: ArtifactPublicationDecision[] = [];

  for (const artifact of artifacts) {
    const artifactConfig = ARTIFACT_GATES[artifact];
    const gateResults: GateEvaluationResult[] = [];
    const blockingGates: GateCategory[] = [];

    for (const category of artifactConfig.requiredGates) {
      const result = categoryResults.get(category)!;
      gateResults.push(result);

      const categoryConfig = GATE_CATEGORIES[category];
      if (!result.passed && categoryConfig.blocking) {
        blockingGates.push(category);
      }
    }

    decisions.push({
      artifact,
      publishable: blockingGates.length === 0,
      blockingGates,
      gateResults,
      evaluatedAt: new Date().toISOString(),
      totalDurationMs: gateResults.reduce((sum, r) => sum + r.durationMs, 0),
    });
  }

  const blockedCount = decisions.filter((d) => !d.publishable).length;

  return {
    decisions,
    allPublishable: blockedCount === 0,
    blockedCount,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Formats a publication gate report as a human-readable summary.
 */
export function formatPublicationGateReport(report: PublicationGateReport): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  Publication Gate Report');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  for (const decision of report.decisions) {
    const artifactConfig = ARTIFACT_GATES[decision.artifact];
    const status = decision.publishable ? '✅ PUBLISHABLE' : '❌ BLOCKED';
    lines.push(`  ${artifactConfig.label} [${decision.artifact}]: ${status}`);

    for (const result of decision.gateResults) {
      const icon = result.passed ? '  ✓' : '  ✗';
      lines.push(`    ${icon} ${result.summary}`);
    }

    if (decision.blockingGates.length > 0) {
      lines.push(`    ⛔ Blocked by: ${decision.blockingGates.join(', ')}`);
    }

    lines.push('');
  }

  lines.push('───────────────────────────────────────────────────────────────');
  if (report.allPublishable) {
    lines.push('  Result: ALL ARTIFACTS PUBLISHABLE');
  } else {
    lines.push(`  Result: ${report.blockedCount} artifact(s) BLOCKED`);
  }
  lines.push('───────────────────────────────────────────────────────────────');
  lines.push('');

  return lines.join('\n');
}

/**
 * Formats a publication gate report as a GitHub Actions step summary (markdown).
 */
export function formatGitHubSummary(report: PublicationGateReport): string {
  const lines: string[] = [];

  lines.push('## 🚦 Publication Gate Report');
  lines.push('');

  for (const decision of report.decisions) {
    const artifactConfig = ARTIFACT_GATES[decision.artifact];
    const status = decision.publishable ? '✅ Publishable' : '❌ Blocked';
    lines.push(`### ${artifactConfig.label} — ${status}`);
    lines.push('');
    lines.push('| Gate | Status | Tests | Duration |');
    lines.push('|------|--------|-------|----------|');

    for (const result of decision.gateResults) {
      const icon = result.passed ? '✅' : '❌';
      const tests = `${result.testsPassed}/${result.testsPassed + result.testsFailed}`;
      const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
      lines.push(`| ${result.category} | ${icon} | ${tests} | ${duration} |`);
    }

    if (decision.blockingGates.length > 0) {
      lines.push('');
      lines.push(`**Blocked by:** ${decision.blockingGates.join(', ')}`);
    }

    lines.push('');
  }

  const overallIcon = report.allPublishable ? '✅' : '❌';
  lines.push(`**Overall:** ${overallIcon} ${report.allPublishable ? 'All artifacts publishable' : `${report.blockedCount} artifact(s) blocked`}`);
  lines.push('');

  return lines.join('\n');
}
