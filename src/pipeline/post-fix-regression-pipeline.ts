/**
 * Post-Fix Regression Pipeline — Wires regression test generation into the
 * post-fix pipeline so that after a successful vulnerability fix (deterministic
 * or self-healing), a regression test is automatically generated and added to
 * the project's test suite.
 *
 * The generated tests are written to disk alongside the fixed file, using the
 * project's detected test framework. They are automatically included in
 * subsequent verification gate runs because the verification gate's test stage
 * executes the project's full test suite.
 *
 * Requirements: 15.1, 15.4
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RegressionTestGenerator,
  type GeneratedTest,
  type TestFramework,
} from './regression-test-generator.js';
import type { DeterministicFix } from './deterministic-fixer.js';
import type { AgentEdit, ProjectContext } from './verification-gate/types.js';
import type { RealtimeAnalysisFinding } from '../runtime-security/realtime-code-analyzer.js';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Input describing a successful vulnerability fix that needs a regression test.
 */
export interface PostFixContext {
  /** The fix that was applied — either a deterministic fix or an agent-generated edit */
  fix: DeterministicFix | AgentEdit;
  /** The security finding that was remediated */
  finding: RealtimeAnalysisFinding;
  /** The project context (rootDir, etc.) */
  projectContext: ProjectContext;
}

/**
 * Result of the post-fix regression test generation.
 */
export interface PostFixRegressionResult {
  /** Whether the regression test was successfully generated and written */
  success: boolean;
  /** The generated test details (if successful) */
  generatedTest?: GeneratedTest;
  /** Error message (if unsuccessful) */
  error?: string;
  /** The path where the test was written */
  testFilePath?: string;
}

// ─── File System Interface ──────────────────────────────────────

/**
 * Abstraction over file system operations to enable testability.
 */
export interface FileWriter {
  writeFile(filePath: string, content: string): Promise<void>;
  mkdir(dirPath: string, options?: { recursive: boolean }): Promise<void>;
}

/** Default file writer using Node's fs module */
const defaultFileWriter: FileWriter = {
  writeFile: (filePath, content) => fs.writeFile(filePath, content, 'utf-8'),
  mkdir: (dirPath, options) => fs.mkdir(dirPath, options).then(() => undefined),
};

// ─── Main Function ──────────────────────────────────────────────

/**
 * Generates and writes a regression test after a successful vulnerability fix.
 *
 * This function is invoked after either:
 * - A deterministic fix is applied via DeterministicFixer.applyFix()
 * - A self-healing loop produces a successful repair via SecurityRemediationBridge.remediate()
 *
 * Requirement 15.1: Auto-generate a regression test that reproduces the original exploit shape.
 * Requirement 15.4: Add the generated test to the project's test suite and include in
 *                   subsequent verification gate runs.
 *
 * @param postFixContext - The context of the successful fix
 * @param fileWriter - Optional file writer for testing (defaults to real fs)
 * @returns The result of the regression test generation
 */
export async function runPostFixRegressionTestGeneration(
  postFixContext: PostFixContext,
  fileWriter: FileWriter = defaultFileWriter,
): Promise<PostFixRegressionResult> {
  const { fix, finding, projectContext } = postFixContext;
  const generator = new RegressionTestGenerator();

  try {
    // Step 1: Detect the project's test framework
    const framework: TestFramework = await generator.detectFramework(
      projectContext.rootDir,
    );

    // Step 2: Generate the regression test
    const generatedTest: GeneratedTest = generator.generate(fix, finding, framework);

    // Step 3: Ensure the target directory exists
    const testDir = path.dirname(generatedTest.filePath);
    await fileWriter.mkdir(testDir, { recursive: true });

    // Step 4: Write the test file to disk
    await fileWriter.writeFile(generatedTest.filePath, generatedTest.content);

    return {
      success: true,
      generatedTest,
      testFilePath: generatedTest.filePath,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Failed to generate regression test: ${message}`,
    };
  }
}

/**
 * Convenience function to invoke regression test generation after a deterministic fix.
 * Called from DeterministicFixer.applyFix() on success.
 *
 * @param fix - The deterministic fix that was successfully applied
 * @param finding - The security finding that was remediated
 * @param projectContext - The project context
 * @param fileWriter - Optional file writer for testing
 */
export async function generateRegressionTestForDeterministicFix(
  fix: DeterministicFix,
  finding: RealtimeAnalysisFinding,
  projectContext: ProjectContext,
  fileWriter: FileWriter = defaultFileWriter,
): Promise<PostFixRegressionResult> {
  return runPostFixRegressionTestGeneration(
    { fix, finding, projectContext },
    fileWriter,
  );
}

/**
 * Convenience function to invoke regression test generation after a self-healing fix.
 * Called from SecurityRemediationBridge.remediate() on success.
 *
 * @param correctedEdit - The agent-generated edit that passed verification
 * @param finding - The security finding that was remediated
 * @param projectContext - The project context
 * @param fileWriter - Optional file writer for testing
 */
export async function generateRegressionTestForSelfHealingFix(
  correctedEdit: AgentEdit,
  finding: RealtimeAnalysisFinding,
  projectContext: ProjectContext,
  fileWriter: FileWriter = defaultFileWriter,
): Promise<PostFixRegressionResult> {
  return runPostFixRegressionTestGeneration(
    { fix: correctedEdit, finding, projectContext },
    fileWriter,
  );
}
