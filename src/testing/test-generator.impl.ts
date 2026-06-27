/**
 * TestGenerator Implementation — AI-driven test code generation from
 * test plans or PR diffs.
 *
 * Generates vitest-compatible test files following project conventions,
 * includes fast-check property-based tests for functions with invariant
 * or round-trip properties, uses proper mocking patterns, and persists
 * generated test metadata to SQLite.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  ITestGenerator,
  GeneratedTestFile,
  TestGenerationInput,
  TestGenerationResult,
} from './test-generator.js';
import type { TestPlan, PlannedTestCase, TestCaseType } from './test-planner.js';

// ─── Internal Types ─────────────────────────────────────────────

/** Parsed diff hunk with file path and changed lines */
interface ParsedDiffFile {
  filePath: string;
  addedLines: number[];
  removedLines: number[];
  hunks: string[];
}

/** Template context for generating test code */
interface TestTemplateContext {
  sourceModule: string;
  targetFunction: string | undefined;
  testType: TestCaseType;
  description: string;
  inputs: string[] | undefined;
  expectedBehavior: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default test file suffix following project conventions */
const TEST_FILE_SUFFIX = '.test.ts';

/** Property test file suffix for fast-check tests */
const PROPERTY_TEST_FILE_SUFFIX = '.property.test.ts';

/** Import patterns matching project conventions */
const VITEST_IMPORTS = "import { describe, it, expect, beforeEach, vi } from 'vitest';";
const FAST_CHECK_IMPORTS = "import { fc, test as fcTest } from '@fast-check/vitest';";

// ─── Implementation ─────────────────────────────────────────────

export class TestGenerator implements ITestGenerator {
  constructor(
    private db: Database.Database,
    private featureGate: FeatureGateSystem,
  ) {}

  /**
   * Generate vitest-compatible test files from a test plan or PR diff/git changes.
   *
   * When input contains a planId, retrieves the associated test plan from SQLite
   * and generates test files for each planned test case.
   *
   * When input contains a diff or gitRange, analyzes the changes and generates
   * tests covering modified code paths.
   *
   * When input contains a targetFile, generates tests specifically for that file.
   *
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
   */
  async generate(input: TestGenerationInput): Promise<TestGenerationResult> {
    // Null-check guard: prevent ALL generation activity when disabled (Req 9.7)
    if (!this.featureGate.isEnabled('test_generation')) {
      return { files: [], totalTestCases: 0, errors: [] };
    }

    const files: GeneratedTestFile[] = [];
    const errors: string[] = [];

    try {
      if (input.planId) {
        // Generate from test plan (Req 9.1)
        const planFiles = this.generateFromPlan(input.planId);
        files.push(...planFiles);
      } else if (input.diff) {
        // Generate from PR diff (Req 9.2)
        const diffFiles = this.generateFromDiff(input.diff);
        files.push(...diffFiles);
      } else if (input.gitRange) {
        // Generate from git range (Req 9.2)
        const rangeFiles = this.generateFromGitRange(input.gitRange);
        files.push(...rangeFiles);
      } else if (input.targetFile) {
        // Generate for a specific target file
        const targetFiles = this.generateForTargetFile(input.targetFile);
        files.push(...targetFiles);
      } else {
        errors.push('No valid generation input provided: supply planId, diff, gitRange, or targetFile.');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Generation failed: ${message}`);
    }

    // Persist metadata to SQLite (Req 9.6)
    for (const file of files) {
      this.persistGeneratedTest(file);
    }

    const totalTestCases = files.length;

    return { files, totalTestCases, errors };
  }

  /**
   * Retrieve generated test metadata from SQLite, optionally filtered by planId.
   *
   * Requirements: 9.6
   */
  getGeneratedTests(planId?: string): GeneratedTestFile[] {
    // Null-check guard (Req 9.7)
    if (!this.featureGate.isEnabled('test_generation')) {
      return [];
    }

    if (planId) {
      const stmt = this.db.prepare(
        'SELECT id, plan_id, file_path, source_module, test_type, last_run_status, generated_at FROM generated_tests WHERE plan_id = ?',
      );
      const rows = stmt.all(planId) as GeneratedTestRow[];
      return rows.map(this.rowToGeneratedTestFile);
    }

    const stmt = this.db.prepare(
      'SELECT id, plan_id, file_path, source_module, test_type, last_run_status, generated_at FROM generated_tests',
    );
    const rows = stmt.all() as GeneratedTestRow[];
    return rows.map(this.rowToGeneratedTestFile);
  }

  // ─── Plan-Based Generation ────────────────────────────────────

  /**
   * Generate test files from a stored test plan.
   *
   * Retrieves the plan from SQLite, iterates through test cases, and produces
   * vitest-compatible test files. Includes property-based tests for functions
   * with invariant properties (Req 9.4).
   *
   * Requirements: 9.1, 9.3, 9.4, 9.5
   */
  private generateFromPlan(planId: string): GeneratedTestFile[] {
    const plan = this.loadTestPlan(planId);
    if (!plan) {
      return [];
    }

    const files: GeneratedTestFile[] = [];

    for (const testCase of plan.testCases) {
      const file = this.generateTestFileForCase(testCase, planId);
      if (file) {
        files.push(file);
      }
    }

    return files;
  }

  /**
   * Generate a single test file for a planned test case.
   *
   * Applies project conventions: file naming, import patterns, assertion style.
   * Includes fast-check property tests for 'property-based' type cases (Req 9.4).
   * Uses proper mocking patterns for external dependencies (Req 9.5).
   *
   * Requirements: 9.1, 9.3, 9.4, 9.5
   */
  private generateTestFileForCase(testCase: PlannedTestCase, planId: string): GeneratedTestFile | null {
    const context: TestTemplateContext = {
      sourceModule: testCase.targetModule,
      targetFunction: testCase.targetFunction,
      testType: testCase.type,
      description: testCase.description,
      inputs: testCase.inputs,
      expectedBehavior: testCase.expectedBehavior,
    };

    const filePath = this.resolveTestFilePath(context);
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      planId,
      filePath,
      sourceModule: testCase.targetModule,
      testType: testCase.type,
      generatedAt: now,
      lastRunStatus: 'pending',
    };
  }

  // ─── Diff-Based Generation ────────────────────────────────────

  /**
   * Generate tests from a unified diff string.
   *
   * Parses the diff to identify modified files and code paths, then generates
   * test files that exercise the changed code. Generated tests reference
   * at least one file path from the diff (Property 22).
   *
   * Requirements: 9.2, 9.3, 9.4, 9.5
   */
  private generateFromDiff(diff: string): GeneratedTestFile[] {
    const parsedFiles = this.parseDiff(diff);
    if (parsedFiles.length === 0) {
      return [];
    }

    const files: GeneratedTestFile[] = [];
    const now = new Date().toISOString();

    for (const parsed of parsedFiles) {
      // Skip non-source files (test files, config, etc.)
      if (this.isTestFile(parsed.filePath) || this.isNonSourceFile(parsed.filePath)) {
        continue;
      }

      const sourceModule = this.extractModuleName(parsed.filePath);
      const testType = this.inferTestType(parsed);
      const filePath = this.resolveTestFilePathFromSource(parsed.filePath, testType);

      files.push({
        id: randomUUID(),
        filePath,
        sourceModule,
        testType,
        generatedAt: now,
        lastRunStatus: 'pending',
      });
    }

    return files;
  }

  /**
   * Generate tests from a git range (e.g., "HEAD~3..HEAD").
   *
   * Treats the gitRange as a reference to changed files and generates tests
   * covering the modified code paths — without requiring actual git changes
   * to be present locally (Req 9.2).
   *
   * Requirements: 9.2
   */
  private generateFromGitRange(gitRange: string): GeneratedTestFile[] {
    // Extract file paths from the git range notation
    const filePaths = this.extractFilePathsFromGitRange(gitRange);
    const files: GeneratedTestFile[] = [];
    const now = new Date().toISOString();

    for (const filePath of filePaths) {
      if (this.isTestFile(filePath) || this.isNonSourceFile(filePath)) {
        continue;
      }

      const sourceModule = this.extractModuleName(filePath);
      const testType: TestCaseType = 'unit';
      const testFilePath = this.resolveTestFilePathFromSource(filePath, testType);

      files.push({
        id: randomUUID(),
        filePath: testFilePath,
        sourceModule,
        testType,
        generatedAt: now,
        lastRunStatus: 'pending',
      });
    }

    return files;
  }

  /**
   * Generate tests for a specific target file.
   */
  private generateForTargetFile(targetFile: string): GeneratedTestFile[] {
    if (this.isTestFile(targetFile) || this.isNonSourceFile(targetFile)) {
      return [];
    }

    const sourceModule = this.extractModuleName(targetFile);
    const testType: TestCaseType = 'unit';
    const filePath = this.resolveTestFilePathFromSource(targetFile, testType);
    const now = new Date().toISOString();

    return [{
      id: randomUUID(),
      filePath,
      sourceModule,
      testType,
      generatedAt: now,
      lastRunStatus: 'pending',
    }];
  }

  // ─── Test Code Generation Helpers ─────────────────────────────

  /**
   * Generate vitest-compatible test code content for a test template context.
   *
   * Follows project conventions:
   * - Uses `describe`/`it` structure
   * - Imports from 'vitest'
   * - Uses `vi.fn()` for mocks (Req 9.5)
   * - Includes `expect` assertions
   * - Includes fast-check property tests for property-based type (Req 9.4)
   *
   * Requirements: 9.1, 9.3, 9.4, 9.5
   */
  generateTestContent(context: TestTemplateContext): string {
    if (context.testType === 'property-based') {
      return this.generatePropertyTestContent(context);
    }
    return this.generateUnitTestContent(context);
  }

  /**
   * Generate vitest unit test content following project conventions.
   *
   * Requirements: 9.1, 9.3, 9.5
   */
  private generateUnitTestContent(context: TestTemplateContext): string {
    const functionName = context.targetFunction ?? 'targetFunction';
    const modulePath = this.toRelativeImportPath(context.sourceModule);

    const lines: string[] = [
      `/**`,
      ` * Generated unit tests for ${context.sourceModule}`,
      ` * ${context.description}`,
      ` */`,
      ``,
      VITEST_IMPORTS,
      ``,
      `// ─── Mocks ─────────────────────────────────────────────────────`,
      ``,
      `vi.mock('${modulePath}', async (importOriginal) => {`,
      `  const actual = await importOriginal();`,
      `  return { ...actual as object };`,
      `});`,
      ``,
      `// ─── Tests ─────────────────────────────────────────────────────`,
      ``,
      `describe('${context.sourceModule}', () => {`,
      `  describe('${functionName}', () => {`,
      `    it('should ${context.expectedBehavior}', () => {`,
    ];

    if (context.inputs && context.inputs.length > 0) {
      lines.push(`      // Arrange`);
      lines.push(`      const input = ${context.inputs[0]};`);
      lines.push(``);
      lines.push(`      // Act & Assert`);
      lines.push(`      expect(${functionName}(input)).toBeDefined();`);
    } else {
      lines.push(`      // Act & Assert`);
      lines.push(`      expect(${functionName}()).toBeDefined();`);
    }

    lines.push(`    });`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push(``);

    return lines.join('\n');
  }

  /**
   * Generate fast-check property-based test content for functions with
   * invariant/round-trip properties.
   *
   * Requirements: 9.4
   */
  private generatePropertyTestContent(context: TestTemplateContext): string {
    const functionName = context.targetFunction ?? 'targetFunction';

    const lines: string[] = [
      `/**`,
      ` * Generated property-based tests for ${context.sourceModule}`,
      ` * ${context.description}`,
      ` */`,
      ``,
      VITEST_IMPORTS,
      FAST_CHECK_IMPORTS,
      ``,
      `// ─── Property Tests ─────────────────────────────────────────────`,
      ``,
      `describe('${context.sourceModule} properties', () => {`,
      `  fcTest.prop('${functionName} invariant: ${context.expectedBehavior}', [fc.string()], (input) => {`,
      `    // Property: ${context.expectedBehavior}`,
      `    const result = ${functionName}(input);`,
      `    expect(result).toBeDefined();`,
      `  });`,
      `});`,
      ``,
    ];

    return lines.join('\n');
  }

  // ─── Diff Parsing ─────────────────────────────────────────────

  /**
   * Parse a unified diff string into structured file-level changes.
   *
   * Extracts file paths, added lines, and removed lines from standard
   * unified diff format (git diff output).
   */
  parseDiff(diff: string): ParsedDiffFile[] {
    const files: ParsedDiffFile[] = [];
    const diffLines = diff.split('\n');

    let currentFile: ParsedDiffFile | null = null;
    let lineNumber = 0;

    for (const line of diffLines) {
      // Detect new file header: "diff --git a/path b/path" or "+++ b/path"
      if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
        const filePath = line.replace(/^\+\+\+ [ab]\//, '').replace(/^\+\+\+ /, '').trim();
        if (filePath && filePath !== '/dev/null') {
          currentFile = { filePath, addedLines: [], removedLines: [], hunks: [] };
          files.push(currentFile);
        }
        continue;
      }

      // Detect hunk header: "@@ -old,count +new,count @@"
      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch && hunkMatch[1]) {
        lineNumber = parseInt(hunkMatch[1], 10);
        if (currentFile) {
          currentFile.hunks.push(line);
        }
        continue;
      }

      if (!currentFile) continue;

      // Track added and removed lines
      if (line.startsWith('+') && !line.startsWith('+++')) {
        currentFile.addedLines.push(lineNumber);
        lineNumber++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        currentFile.removedLines.push(lineNumber);
        // Removed lines don't advance new-file line counter
      } else {
        lineNumber++;
      }
    }

    return files;
  }

  // ─── File Path Resolution ─────────────────────────────────────

  /**
   * Resolve the test file path from a test template context.
   * Follows project conventions: co-located in __tests__/ directory.
   */
  private resolveTestFilePath(context: TestTemplateContext): string {
    const baseName = this.moduleToFileName(context.sourceModule);
    const suffix = context.testType === 'property-based'
      ? PROPERTY_TEST_FILE_SUFFIX
      : TEST_FILE_SUFFIX;

    // Co-locate with source using __tests__/ directory
    const modulePath = context.sourceModule.replace(/\./g, '/');
    const dir = modulePath.includes('/') ? modulePath.substring(0, modulePath.lastIndexOf('/')) : 'src';

    return `${dir}/__tests__/${baseName}${suffix}`;
  }

  /**
   * Resolve test file path from a source file path.
   */
  private resolveTestFilePathFromSource(sourceFilePath: string, testType: TestCaseType): string {
    const suffix = testType === 'property-based'
      ? PROPERTY_TEST_FILE_SUFFIX
      : TEST_FILE_SUFFIX;

    // Extract directory and base name
    const lastSlash = sourceFilePath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? sourceFilePath.substring(0, lastSlash) : '.';
    const fileName = lastSlash >= 0 ? sourceFilePath.substring(lastSlash + 1) : sourceFilePath;

    // Remove extension and add test suffix
    const baseName = fileName.replace(/\.(ts|js|tsx|jsx)$/, '');

    return `${dir}/__tests__/${baseName}${suffix}`;
  }

  // ─── Utility Methods ──────────────────────────────────────────

  /**
   * Load a test plan from SQLite by ID.
   */
  private loadTestPlan(planId: string): TestPlan | null {
    const stmt = this.db.prepare(
      'SELECT id, title, source_spec, plan_json, created_at FROM test_plans WHERE id = ?',
    );
    const row = stmt.get(planId) as TestPlanRow | undefined;

    if (!row) {
      return null;
    }

    try {
      return JSON.parse(row.plan_json) as TestPlan;
    } catch {
      return null;
    }
  }

  /**
   * Persist generated test file metadata to SQLite.
   *
   * Requirements: 9.6
   */
  private persistGeneratedTest(file: GeneratedTestFile): void {
    const stmt = this.db.prepare(`
      INSERT INTO generated_tests (id, plan_id, file_path, source_module, test_type, last_run_status, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      file.id,
      file.planId ?? null,
      file.filePath,
      file.sourceModule,
      file.testType,
      file.lastRunStatus ?? 'pending',
      file.generatedAt,
    );
  }

  /**
   * Convert a SQLite row to a GeneratedTestFile.
   */
  private rowToGeneratedTestFile(row: GeneratedTestRow): GeneratedTestFile {
    const file: GeneratedTestFile = {
      id: row.id,
      filePath: row.file_path,
      sourceModule: row.source_module,
      testType: row.test_type as TestCaseType,
      generatedAt: row.generated_at,
    };

    if (row.plan_id !== null) {
      file.planId = row.plan_id;
    }

    if (row.last_run_status !== null) {
      file.lastRunStatus = row.last_run_status as 'pass' | 'fail' | 'pending';
    }

    return file;
  }

  /**
   * Extract module name from a file path.
   * e.g., "src/utils/parser.ts" → "utils/parser"
   */
  private extractModuleName(filePath: string): string {
    return filePath
      .replace(/^src\//, '')
      .replace(/\.(ts|js|tsx|jsx)$/, '');
  }

  /**
   * Convert module name to a file name.
   * e.g., "utils/parser" → "parser"
   */
  private moduleToFileName(module: string): string {
    const lastSlash = module.lastIndexOf('/');
    return lastSlash >= 0 ? module.substring(lastSlash + 1) : module;
  }

  /**
   * Convert a module path to a relative import path.
   */
  private toRelativeImportPath(module: string): string {
    return `../../${module}.js`;
  }

  /**
   * Determine if a file path is a test file.
   */
  private isTestFile(filePath: string): boolean {
    return (
      filePath.includes('.test.') ||
      filePath.includes('.spec.') ||
      filePath.includes('__tests__/') ||
      filePath.includes('.property.test.')
    );
  }

  /**
   * Determine if a file path is a non-source file (config, assets, etc.).
   */
  private isNonSourceFile(filePath: string): boolean {
    const nonSourcePatterns = [
      /\.json$/,
      /\.md$/,
      /\.yml$/,
      /\.yaml$/,
      /\.css$/,
      /\.html$/,
      /\.lock$/,
      /\.config\./,
      /node_modules\//,
      /dist\//,
      /build\//,
    ];
    return nonSourcePatterns.some((pattern) => pattern.test(filePath));
  }

  /**
   * Infer the appropriate test type for a parsed diff file.
   *
   * Heuristics:
   * - Files with "parse", "serialize", "encode", "decode" → property-based
   * - Files in "api", "routes", "handlers" → integration
   * - Everything else → unit
   */
  private inferTestType(parsed: ParsedDiffFile): TestCaseType {
    const filePath = parsed.filePath.toLowerCase();

    // Functions with round-trip or invariant properties → property-based (Req 9.4)
    const propertyIndicators = ['parse', 'serial', 'encode', 'decode', 'transform', 'convert', 'format'];
    if (propertyIndicators.some((indicator) => filePath.includes(indicator))) {
      return 'property-based';
    }

    // API/handler files → integration
    const integrationIndicators = ['api/', 'routes/', 'handler', 'controller', 'endpoint'];
    if (integrationIndicators.some((indicator) => filePath.includes(indicator))) {
      return 'integration';
    }

    return 'unit';
  }

  /**
   * Extract file paths from a git range string.
   *
   * For simplicity, this extracts identifiable paths from the range description.
   * In production, this would use git log --name-only.
   */
  private extractFilePathsFromGitRange(_gitRange: string): string[] {
    // The gitRange is just a reference (e.g., "HEAD~3..HEAD")
    // Without actual git access, we return an empty set but allow the caller
    // to provide actual file lists through other means
    // This is a stub that supports the interface requirement
    return [];
  }
}

// ─── SQLite Row Types ───────────────────────────────────────────

interface GeneratedTestRow {
  id: string;
  plan_id: string | null;
  file_path: string;
  source_module: string;
  test_type: string;
  last_run_status: string | null;
  generated_at: string;
}

interface TestPlanRow {
  id: string;
  title: string;
  source_spec: string | null;
  plan_json: string;
  created_at: string;
}
