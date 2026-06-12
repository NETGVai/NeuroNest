/**
 * Affected test execution stage.
 * Uses dependency-graph-based test selection to run only tests affected by changes.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type {
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  Diagnostic,
  DependencyGraph,
} from '../types';
import { STAGE_SCORES } from '../types';

const execAsync = promisify(exec);

// ─── Dependency Graph-Based Test Selection ──────────────────────

/**
 * Resolves which test files are affected by a set of changed source files.
 * Walks the dependency graph to find all dependents, then filters for test files.
 */
export function selectAffectedTests(
  changedFiles: string[],
  graph: DependencyGraph | undefined,
  rootDir: string
): string[] {
  if (!graph) {
    // Without a dependency graph, return all test files related to changed directories
    return changedFiles
      .map(f => inferTestFile(f))
      .filter((f): f is string => f !== null);
  }

  const affectedFiles = new Set<string>();

  // Collect all transitive dependents
  const visited = new Set<string>();
  const queue = [...changedFiles];

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    affectedFiles.add(file);

    const dependents = graph.dependents.get(file);
    if (dependents) {
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  // Filter to test files
  return Array.from(affectedFiles).filter(f => isTestFile(f));
}

/**
 * Infers a likely test file path from a source file.
 */
function inferTestFile(sourceFile: string): string | null {
  // Convert src/foo/bar.ts → tests/unit/foo/bar.test.ts or tests/foo/bar.test.ts
  const ext = path.extname(sourceFile);
  const withoutExt = sourceFile.replace(ext, '');

  // If it's already a test file, return it
  if (isTestFile(sourceFile)) return sourceFile;

  // Try common test file patterns
  const baseName = path.basename(withoutExt);
  const dir = path.dirname(sourceFile);

  // Check for co-located test
  const colocated = `${withoutExt}.test${ext}`;
  return colocated;
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('.test.') ||
    filePath.includes('.spec.') ||
    filePath.includes('__tests__') ||
    filePath.startsWith('tests/')
  );
}

// ─── Test Runner Interface ──────────────────────────────────────

export interface TestRunResult {
  passed: boolean;
  failedTests: FailedTest[];
  totalTests: number;
  passedTests: number;
}

export interface FailedTest {
  name: string;
  file: string;
  line: number;
  message: string;
}

export interface TestRunner {
  run(testFiles: string[], rootDir: string, timeoutMs: number): Promise<TestRunResult>;
}

export class DefaultTestRunner implements TestRunner {
  async run(testFiles: string[], rootDir: string, timeoutMs: number): Promise<TestRunResult> {
    if (testFiles.length === 0) {
      return { passed: true, failedTests: [], totalTests: 0, passedTests: 0 };
    }

    const fileArgs = testFiles.map(f => `"${f}"`).join(' ');
    const cmd = `npx vitest --run --reporter=json ${fileArgs}`;

    try {
      const { stdout } = await execAsync(cmd, {
        cwd: rootDir,
        timeout: timeoutMs,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return this.parseVitestJson(stdout);
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; killed?: boolean };

      if (execError.killed) {
        return {
          passed: false,
          failedTests: [{
            name: 'timeout',
            file: testFiles[0] || 'unknown',
            line: 0,
            message: `Test execution exceeded ${timeoutMs}ms timeout`,
          }],
          totalTests: 0,
          passedTests: 0,
        };
      }

      // vitest exits non-zero on test failure
      if (execError.stdout) {
        return this.parseVitestJson(execError.stdout);
      }

      return {
        passed: false,
        failedTests: [{
          name: 'execution-error',
          file: testFiles[0] || 'unknown',
          line: 0,
          message: 'Test execution failed',
        }],
        totalTests: 0,
        passedTests: 0,
      };
    }
  }

  private parseVitestJson(output: string): TestRunResult {
    try {
      const result = JSON.parse(output);
      const failedTests: FailedTest[] = [];

      if (result.testResults) {
        for (const suite of result.testResults) {
          if (suite.assertionResults) {
            for (const test of suite.assertionResults) {
              if (test.status === 'failed') {
                failedTests.push({
                  name: test.fullName || test.title || 'unknown',
                  file: suite.name || 'unknown',
                  line: test.location?.line || 0,
                  message: (test.failureMessages || []).join('\n') || 'Test failed',
                });
              }
            }
          }
        }
      }

      return {
        passed: (result.numFailedTests ?? failedTests.length) === 0,
        failedTests,
        totalTests: result.numTotalTests ?? 0,
        passedTests: result.numPassedTests ?? 0,
      };
    } catch {
      return {
        passed: false,
        failedTests: [{ name: 'parse-error', file: 'unknown', line: 0, message: 'Could not parse test output' }],
        totalTests: 0,
        passedTests: 0,
      };
    }
  }
}

// ─── Test Stage ─────────────────────────────────────────────────

export class TestStage implements VerificationStage {
  readonly name = 'test' as const;
  readonly score = STAGE_SCORES.test;

  constructor(private runner: TestRunner = new DefaultTestRunner()) {}

  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();

    const changedFiles = edit.changes.map(c => c.filePath);
    const affectedTests = selectAffectedTests(changedFiles, context.dependencyGraph, context.rootDir);

    if (affectedTests.length === 0) {
      // No affected tests — stage passes
      return {
        stageName: 'test',
        passed: true,
        diagnostics: [],
        durationMs: Date.now() - startTime,
      };
    }

    const result = await this.runner.run(affectedTests, context.rootDir, 20_000);

    const diagnostics: Diagnostic[] = result.failedTests.map(t => ({
      file: t.file,
      line: t.line || 1,
      column: 1,
      message: `Test "${t.name}" failed: ${t.message}`,
      severity: 'error' as const,
    }));

    return {
      stageName: 'test',
      passed: result.passed,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }
}
