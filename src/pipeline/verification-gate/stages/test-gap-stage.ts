/**
 * Test-Gap Detector Stage
 *
 * Diffs changed exports against existing test files to identify untested public
 * behavior. Prefers property-based templates (fast-check) for pure functions;
 * falls back to example-based tests when PBT is not feasible.
 *
 * Generated tests execute in a Docker sandbox — only green (passing) runs are
 * accepted.
 *
 * Operates in advisory mode by default (warnings, not blocking).
 * Pipeline ordering: Over-Engineering Review → Test-Gap → rest.
 * Gated behind the `test_gap_detection` feature flag.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.7, 12.8, 12.9, 12.10
 */
import { spawn } from 'child_process';
import type {
  VerificationStage,
  AgentEdit,
  ProjectContext,
  StageResult,
  Diagnostic,
  StageName,
  FileChange,
} from '../types';
import { checkSandboxIsolation } from '../../sandbox-environment';

// ─── Types ──────────────────────────────────────────────────────

export type ExportType = 'function' | 'class' | 'constant';
export type RiskLevel = 'low' | 'medium' | 'high';
export type TestTemplate = 'property-based' | 'example-based';

export interface UncoveredExport {
  /** File path where the untested export lives */
  filePath: string;
  /** Name of the exported symbol */
  exportName: string;
  /** Type of the export */
  exportType: ExportType;
  /** Assessed risk level based on export complexity and type */
  riskLevel: RiskLevel;
}

export interface GeneratedTest {
  /** File path for the generated test */
  testFilePath: string;
  /** Generated test source code */
  content: string;
  /** Template type used for generation */
  template: TestTemplate;
  /** Target export being tested */
  targetExport: string;
  /** Whether the test passed in the Docker sandbox */
  passed: boolean;
}

export interface TestGapResult {
  /** Exports identified as lacking test coverage */
  uncoveredExports: UncoveredExport[];
  /** Operating mode — advisory emits warnings, blocking fails the pipeline */
  mode: 'advisory' | 'blocking';
  /** Tests that were generated (if test generation was triggered) */
  generatedTests: GeneratedTest[];
}

/**
 * Result of a Docker sandbox test execution.
 * Reports success ONLY after the test process exits with a success status (R4.1).
 * Returns non-success with reason on unavailability/container-start failure/missing runtime (R4.2).
 * Returns non-success with reason and retained output on non-zero exit/crash/signal (R4.3).
 * Returns timeout status when execution exceeds 300s (R4.4).
 * Never reports success for un-run/skipped/no-exit-status tests (R4.5).
 */
export interface DockerSandboxRunResult {
  /** Status of the test execution */
  status: 'success' | 'failure' | 'error' | 'timeout';
  /** Exit code of the test process, if available */
  exitCode?: number;
  /** Captured stdout/stderr — retained on failure (R4.3) */
  output: string;
  /** Identifies the unavailable/crash/timeout cause (R4.2, R4.3, R4.4) */
  reason?: string;
}

/**
 * Interface for Docker sandbox test execution.
 * In production, this runs tests in an isolated Docker container.
 * Can be substituted with a mock for testing.
 */
export interface DockerSandboxRunner {
  /** Identifies whether this sandbox provides real Docker isolation or is a no-op (R5.1) */
  readonly isolationKind: 'docker' | 'noop';
  /**
   * Execute a test file in the Docker sandbox.
   * @returns A DockerSandboxRunResult reporting success only after verified completion.
   */
  runTest(testContent: string, testFilePath: string): Promise<DockerSandboxRunResult>;
}

/**
 * Interface for feature flag checking.
 */
export interface FeatureFlagChecker {
  isEnabled(flagName: string): boolean;
}

// ─── Export Extraction ──────────────────────────────────────────

/**
 * Regex patterns for detecting exported symbols in TypeScript/JavaScript.
 */
const EXPORT_PATTERNS = {
  namedFunction: /export\s+(?:async\s+)?function\s+(\w+)/g,
  namedClass: /export\s+class\s+(\w+)/g,
  namedConst: /export\s+const\s+(\w+)/g,
  namedLet: /export\s+let\s+(\w+)/g,
  defaultFunction: /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
  defaultClass: /export\s+default\s+class\s+(\w+)/g,
};

/**
 * Extracts exported symbol names and types from file content.
 */
export function extractExports(content: string): Array<{ name: string; type: ExportType }> {
  const exports: Array<{ name: string; type: ExportType }> = [];
  const seen = new Set<string>();

  // Functions
  for (const match of content.matchAll(EXPORT_PATTERNS.namedFunction)) {
    if (!seen.has(match[1])) {
      exports.push({ name: match[1], type: 'function' });
      seen.add(match[1]);
    }
  }
  for (const match of content.matchAll(EXPORT_PATTERNS.defaultFunction)) {
    if (!seen.has(match[1])) {
      exports.push({ name: match[1], type: 'function' });
      seen.add(match[1]);
    }
  }

  // Classes
  for (const match of content.matchAll(EXPORT_PATTERNS.namedClass)) {
    if (!seen.has(match[1])) {
      exports.push({ name: match[1], type: 'class' });
      seen.add(match[1]);
    }
  }
  for (const match of content.matchAll(EXPORT_PATTERNS.defaultClass)) {
    if (!seen.has(match[1])) {
      exports.push({ name: match[1], type: 'class' });
      seen.add(match[1]);
    }
  }

  // Constants and variables
  for (const match of content.matchAll(EXPORT_PATTERNS.namedConst)) {
    if (!seen.has(match[1])) {
      exports.push({ name: match[1], type: 'constant' });
      seen.add(match[1]);
    }
  }
  for (const match of content.matchAll(EXPORT_PATTERNS.namedLet)) {
    if (!seen.has(match[1])) {
      exports.push({ name: match[1], type: 'constant' });
      seen.add(match[1]);
    }
  }

  return exports;
}

// ─── Test File Detection ────────────────────────────────────────

/**
 * Derives conventional test file paths for a given source file.
 * Checks common patterns: __tests__/foo.test.ts, foo.test.ts, foo.spec.ts
 */
export function deriveTestFilePaths(filePath: string): string[] {
  const paths: string[] = [];
  const ext = filePath.match(/\.(ts|tsx|js|jsx)$/)?.[0] ?? '.ts';
  const baseName = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
  const dirParts = filePath.split('/');
  const fileName = dirParts[dirParts.length - 1].replace(/\.(ts|tsx|js|jsx)$/, '');
  const dirPath = dirParts.slice(0, -1).join('/');

  // Pattern 1: co-located .test file
  paths.push(`${baseName}.test${ext}`);
  // Pattern 2: co-located .spec file
  paths.push(`${baseName}.spec${ext}`);
  // Pattern 3: __tests__ directory
  paths.push(`${dirPath}/__tests__/${fileName}.test${ext}`);
  paths.push(`${dirPath}/__tests__/${fileName}.spec${ext}`);

  return paths;
}

/**
 * Checks whether an export name is referenced in any known test content.
 */
export function isExportTested(
  exportName: string,
  testContents: string[],
): boolean {
  for (const content of testContents) {
    // Check for direct references: import, describe, or usage of the symbol
    if (content.includes(exportName)) {
      return true;
    }
  }
  return false;
}

// ─── Purity Heuristic ───────────────────────────────────────────

/**
 * Simple heuristic to determine if a function is likely pure.
 * A function is considered "likely pure" if its body does NOT contain:
 * - this.
 * - await / async indicators within body
 * - console.* / process.* / fs.* side effects
 * - assignments to external state
 *
 * This is a best-effort heuristic — not a formal purity checker.
 */
export function isPureFunction(functionContent: string): boolean {
  const impureIndicators = [
    /\bthis\./,
    /\bawait\b/,
    /\bconsole\./,
    /\bprocess\./,
    /\bfs\./,
    /\bfetch\(/,
    /\bnew\s+Date\(/,
    /\bMath\.random\(/,
    /\bsetTimeout\(/,
    /\bsetInterval\(/,
    /\.write\(/,
    /\.emit\(/,
  ];

  for (const pattern of impureIndicators) {
    if (pattern.test(functionContent)) {
      return false;
    }
  }

  return true;
}

// ─── Risk Assessment ────────────────────────────────────────────

/**
 * Assess the risk level of an untested export based on its type and name.
 */
export function assessRisk(exportName: string, exportType: ExportType): RiskLevel {
  // High risk: classes and functions with security/auth/data in the name
  const highRiskPatterns = /auth|security|crypt|token|password|secret|session|permission/i;
  if (highRiskPatterns.test(exportName)) {
    return 'high';
  }

  // Medium risk: classes and complex functions
  if (exportType === 'class') {
    return 'medium';
  }

  // Low risk: constants and simple functions
  if (exportType === 'constant') {
    return 'low';
  }

  return 'medium';
}

// ─── Test Generation ────────────────────────────────────────────

/**
 * Generate a property-based test template (fast-check) for a pure function.
 */
export function generatePropertyBasedTest(
  exportName: string,
  filePath: string,
): string {
  const importPath = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
  return `/**
 * Property-based test for ${exportName}
 * Generated by Test-Gap Detector
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ${exportName} } from '${importPath}';

describe('${exportName} — property-based', () => {
  it('should not throw for arbitrary valid inputs', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => ${exportName}(input)).not.toThrow();
      }),
    );
  });

  it('should return a consistent type for same input shape', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result1 = ${exportName}(input);
        const result2 = ${exportName}(input);
        expect(typeof result1).toBe(typeof result2);
      }),
    );
  });
});
`;
}

/**
 * Generate an example-based test template for a non-pure function or class.
 */
export function generateExampleBasedTest(
  exportName: string,
  exportType: ExportType,
  filePath: string,
): string {
  const importPath = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');

  if (exportType === 'class') {
    return `/**
 * Example-based test for ${exportName}
 * Generated by Test-Gap Detector
 */
import { describe, it, expect } from 'vitest';
import { ${exportName} } from '${importPath}';

describe('${exportName}', () => {
  it('should be instantiable', () => {
    const instance = new ${exportName}();
    expect(instance).toBeInstanceOf(${exportName});
  });
});
`;
  }

  return `/**
 * Example-based test for ${exportName}
 * Generated by Test-Gap Detector
 */
import { describe, it, expect } from 'vitest';
import { ${exportName} } from '${importPath}';

describe('${exportName}', () => {
  it('should be defined', () => {
    expect(${exportName}).toBeDefined();
  });

  it('should execute without error', () => {
    expect(() => ${exportName}()).not.toThrow();
  });
});
`;
}

// ─── Default Docker Sandbox ──────────────────────────────────────

/** Maximum execution time for a sandbox test run (R4.4). */
const SANDBOX_TIMEOUT_MS = 300_000; // 300 seconds

/**
 * Default Docker sandbox runner implementation.
 * Executes tests inside a Docker container and reports success ONLY after
 * the test process runs to completion with a success exit status (R4.1).
 *
 * Reports non-success when:
 * - The sandbox (Docker) is unavailable (R4.2)
 * - The container fails to start (R4.2)
 * - The test runtime is absent in the container (R4.2)
 * - The process exits non-zero (R4.3)
 * - The process crashes or is terminated by a signal (R4.3)
 * - Execution exceeds 300s (R4.4)
 *
 * Never reports success for un-run/skipped/no-exit-status tests (R4.5).
 */
export class DefaultDockerSandboxRunner implements DockerSandboxRunner {
  readonly isolationKind = 'docker' as const;
  private dockerImage: string;
  private testCommand: string;

  constructor(options?: { dockerImage?: string; testCommand?: string }) {
    this.dockerImage = options?.dockerImage ?? 'node:20-slim';
    this.testCommand = options?.testCommand ?? 'npx vitest run';
  }

  async runTest(testContent: string, testFilePath: string): Promise<DockerSandboxRunResult> {
    // R5.3, R5.4: Check isolation — refuse untrusted execution in production with noop sandbox
    const refusal = checkSandboxIsolation(this.isolationKind);
    if (refusal) {
      return refusal;
    }

    // R4.5: Never report success for un-run tests (empty content means nothing to run)
    if (!testContent || !testContent.trim()) {
      return {
        status: 'error',
        output: '',
        reason: 'Test content is empty — nothing to execute',
      };
    }

    // Check Docker availability (R4.2)
    const dockerAvailable = await this.isDockerAvailable();
    if (!dockerAvailable) {
      return {
        status: 'error',
        output: '',
        reason: 'Docker is unavailable — cannot execute test in sandbox',
      };
    }

    // Execute the test inside a Docker container
    return this.executeInContainer(testContent, testFilePath);
  }

  /**
   * Check if Docker is available on the host.
   */
  private isDockerAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn('docker', ['info'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });

      proc.on('close', (code) => {
        resolve(code === 0);
      });

      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Execute the test content inside a Docker container.
   * Reports honest results per R4.1–R4.5.
   */
  private executeInContainer(
    testContent: string,
    testFilePath: string,
  ): Promise<DockerSandboxRunResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timerHandle: ReturnType<typeof setTimeout> | undefined;

      const settle = (result: DockerSandboxRunResult) => {
        if (settled) return;
        settled = true;
        if (timerHandle) clearTimeout(timerHandle);
        resolve(result);
      };

      // Build the docker run command:
      // - Mount test content via stdin/echo
      // - Run with --rm for cleanup
      // - Set a working directory
      const args = [
        'run',
        '--rm',
        '--network=none', // no network access for test isolation
        '-i',             // read stdin for test content
        '-w', '/workspace',
        this.dockerImage,
        'sh', '-c',
        // Write the test content to a file and run it
        `cat > /workspace/${testFilePath} && ${this.testCommand} /workspace/${testFilePath}`,
      ];

      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn('docker', args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err: unknown) {
        // R4.2: Container fails to start
        settle({
          status: 'error',
          output: '',
          reason: `Failed to start Docker container: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }

      // R4.4: Timeout enforcement — 300s max execution
      timerHandle = setTimeout(() => {
        if (!settled) {
          // Kill the process and report timeout
          try {
            proc.kill('SIGKILL');
          } catch {
            // Best effort kill
          }
          settle({
            status: 'timeout',
            output: stdout + stderr,
            reason: `Test execution exceeded the maximum time limit of ${SANDBOX_TIMEOUT_MS / 1000}s`,
          });
        }
      }, SANDBOX_TIMEOUT_MS);

      // Write test content to the container's stdin
      if (proc.stdin) {
        proc.stdin.write(testContent);
        proc.stdin.end();
      }

      // Capture output
      if (proc.stdout) {
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
      }
      if (proc.stderr) {
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
      }

      // R4.2: Handle spawn/container-start errors
      proc.on('error', (err: Error) => {
        const reason = err.message.includes('ENOENT')
          ? 'Docker is not installed or not in PATH — cannot execute test in sandbox'
          : `Container execution error: ${err.message}`;
        settle({
          status: 'error',
          output: stdout + stderr,
          reason,
        });
      });

      // Handle process exit
      proc.on('close', (code: number | null, signal: string | null) => {
        const combinedOutput = stdout + stderr;

        // R4.3: Terminated by signal (crash)
        if (signal) {
          settle({
            status: 'failure',
            exitCode: code ?? undefined,
            output: combinedOutput,
            reason: `Test process terminated by signal: ${signal}`,
          });
          return;
        }

        // R4.5: No verifiable exit status — never report success
        if (code === null || code === undefined) {
          settle({
            status: 'error',
            output: combinedOutput,
            reason: 'Test process produced no verifiable exit status',
          });
          return;
        }

        // R4.1: Success ONLY on exit code 0
        if (code === 0) {
          settle({
            status: 'success',
            exitCode: 0,
            output: combinedOutput,
          });
          return;
        }

        // R4.3: Non-zero exit — determine if it's a missing runtime or test failure
        const isRuntimeMissing =
          combinedOutput.includes('not found') ||
          combinedOutput.includes('command not found') ||
          combinedOutput.includes('No such file or directory') ||
          code === 127; // standard "command not found" exit code

        if (isRuntimeMissing) {
          // R4.2: Missing runtime
          settle({
            status: 'error',
            exitCode: code,
            output: combinedOutput,
            reason: 'Test runtime is not available in the sandbox container',
          });
        } else {
          // R4.3: Test failure (non-zero exit)
          settle({
            status: 'failure',
            exitCode: code,
            output: combinedOutput,
            reason: `Test process exited with non-zero status: ${code}`,
          });
        }
      });
    });
  }
}

// ─── Default Feature Flag Checker ───────────────────────────────

/**
 * Default feature flag checker with per-flag documented defaults.
 *
 * Documented defaults:
 *   - test_gap_detection: true (enabled by default)
 *   - All other flags: false (disabled by default)
 *
 * When a flags map is provided, flags present in that map use the map value.
 * Flags absent from the map fall back to the documented default — the same
 * value returned when no map is provided at all (Requirement 19.5).
 */
export class DefaultFeatureFlagChecker implements FeatureFlagChecker {
  /** Documented defaults — the canonical source of truth per flag (R19.6). */
  private static readonly DEFAULTS: Record<string, boolean> = {
    // Reconciled with isFeatureEnabled('test_gap_detection') in enhanced-orchestration-constraints.ts
    test_gap_detection: true,
  };

  private flags: Map<string, boolean>;

  constructor(flags?: Record<string, boolean>) {
    this.flags = new Map(Object.entries(flags ?? {}));
  }

  isEnabled(flagName: string): boolean {
    if (this.flags.has(flagName)) {
      return this.flags.get(flagName)!;
    }
    // Missing key falls back to the documented default (same as no-map behavior).
    return DefaultFeatureFlagChecker.DEFAULTS[flagName] ?? false;
  }
}

// ─── Test-Gap Detector Stage ────────────────────────────────────

export class TestGapDetectorStage implements VerificationStage {
  readonly name = 'test-gap' as StageName;
  readonly score = 3;

  private mode: 'advisory' | 'blocking';
  private sandboxRunner: DockerSandboxRunner;
  private featureFlagChecker: FeatureFlagChecker;
  private existingTestContents: Map<string, string>;

  constructor(options?: {
    mode?: 'advisory' | 'blocking';
    sandboxRunner?: DockerSandboxRunner;
    featureFlagChecker?: FeatureFlagChecker;
    /** Map of test file path → content for diffing against */
    existingTestContents?: Map<string, string>;
  }) {
    this.mode = options?.mode ?? 'advisory';
    this.sandboxRunner = options?.sandboxRunner ?? new DefaultDockerSandboxRunner();
    this.featureFlagChecker = options?.featureFlagChecker ?? new DefaultFeatureFlagChecker();
    this.existingTestContents = options?.existingTestContents ?? new Map();
  }

  /**
   * Execute the test-gap detection stage.
   *
   * 1. Check feature flag — skip if disabled
   * 2. Extract exports from changed files
   * 3. Diff against existing tests to find uncovered exports
   * 4. Generate tests (PBT for pure functions, example-based for rest)
   * 5. Run generated tests in Docker sandbox
   * 6. Report results based on mode (advisory/blocking)
   */
  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();

    // Check feature flag — if disabled, pass immediately (no-op)
    if (!this.featureFlagChecker.isEnabled('test_gap_detection')) {
      return {
        stageName: this.name,
        passed: true,
        diagnostics: [],
        durationMs: Date.now() - startTime,
      };
    }

    // Analyze changed files for untested exports
    const result = await this.analyze(edit, context);

    // Convert to diagnostics
    const diagnostics: Diagnostic[] = result.uncoveredExports.map((exp) => ({
      file: exp.filePath,
      line: 0,
      column: 0,
      message: `[test-gap] Untested ${exp.exportType} "${exp.exportName}" (risk: ${exp.riskLevel})`,
      severity: this.mode === 'blocking' ? 'error' as const : 'warning' as const,
    }));

    // Add diagnostics for failed generated tests
    for (const test of result.generatedTests) {
      if (!test.passed) {
        diagnostics.push({
          file: test.testFilePath,
          line: 0,
          column: 0,
          message: `[test-gap] Generated ${test.template} test for "${test.targetExport}" failed in sandbox — rejected`,
          severity: 'warning',
        });
      }
    }

    // Advisory mode always passes; blocking mode fails if uncovered exports exist
    const passed = this.mode === 'advisory' || result.uncoveredExports.length === 0;

    return {
      stageName: this.name,
      passed,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Core analysis: extract exports, diff against tests, generate missing tests.
   */
  async analyze(edit: AgentEdit, _context: ProjectContext): Promise<TestGapResult> {
    const uncoveredExports: UncoveredExport[] = [];
    const generatedTests: GeneratedTest[] = [];

    for (const change of edit.changes) {
      // Only analyze TypeScript/JavaScript source files
      if (!this.isSourceFile(change.filePath)) {
        continue;
      }

      // Skip test files themselves
      if (this.isTestFile(change.filePath)) {
        continue;
      }

      // Extract exports from changed file
      const exports = extractExports(change.content);

      // Gather existing test content for this file
      const testContents = this.getTestContentsForFile(change.filePath);

      // Identify untested exports
      for (const exp of exports) {
        if (!isExportTested(exp.name, testContents)) {
          const riskLevel = assessRisk(exp.name, exp.type);
          uncoveredExports.push({
            filePath: change.filePath,
            exportName: exp.name,
            exportType: exp.type,
            riskLevel,
          });

          // Generate test
          const generated = await this.generateAndRunTest(
            exp.name,
            exp.type,
            change.filePath,
            change.content,
          );
          if (generated) {
            generatedTests.push(generated);
          }
        }
      }
    }

    return {
      uncoveredExports,
      mode: this.mode,
      generatedTests,
    };
  }

  /**
   * Generate a test for an uncovered export and run it in the Docker sandbox.
   * Prefers property-based (fast-check) for pure functions.
   * Falls back to example-based when PBT is not feasible.
   * Only accepts green (passing) test runs.
   */
  private async generateAndRunTest(
    exportName: string,
    exportType: ExportType,
    filePath: string,
    fileContent: string,
  ): Promise<GeneratedTest | null> {
    let template: TestTemplate;
    let testContent: string;

    // Determine template type: prefer PBT for pure functions
    if (exportType === 'function' && isPureFunction(fileContent)) {
      template = 'property-based';
      testContent = generatePropertyBasedTest(exportName, filePath);
    } else {
      template = 'example-based';
      testContent = generateExampleBasedTest(exportName, exportType, filePath);
    }

    const testFilePath = this.deriveTestPath(filePath, exportName);

    // Run in Docker sandbox — only green runs accepted (R4.1)
    const result = await this.sandboxRunner.runTest(testContent, testFilePath);
    const passed = result.status === 'success';

    return {
      testFilePath,
      content: testContent,
      template,
      targetExport: exportName,
      passed,
    };
  }

  /**
   * Derive a test file path for a generated test.
   */
  private deriveTestPath(filePath: string, exportName: string): string {
    const ext = filePath.match(/\.(ts|tsx|js|jsx)$/)?.[0] ?? '.ts';
    const dirParts = filePath.split('/');
    const dirPath = dirParts.slice(0, -1).join('/');
    return `${dirPath}/__tests__/${exportName}.test${ext}`;
  }

  /**
   * Get existing test file contents that cover a source file.
   */
  private getTestContentsForFile(filePath: string): string[] {
    const testPaths = deriveTestFilePaths(filePath);
    const contents: string[] = [];

    for (const testPath of testPaths) {
      const content = this.existingTestContents.get(testPath);
      if (content) {
        contents.push(content);
      }
    }

    return contents;
  }

  /**
   * Check if a file path is a source file (TypeScript/JavaScript).
   */
  private isSourceFile(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx)$/.test(filePath);
  }

  /**
   * Check if a file path is a test file.
   */
  private isTestFile(filePath: string): boolean {
    return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(filePath) ||
      filePath.includes('__tests__/');
  }

  /**
   * Get the operating mode.
   */
  getMode(): 'advisory' | 'blocking' {
    return this.mode;
  }

  /**
   * Get the analysis result without converting to StageResult.
   * Useful for integration with other systems.
   */
  async getAnalysis(edit: AgentEdit, context: ProjectContext): Promise<TestGapResult> {
    return this.analyze(edit, context);
  }
}
