/**
 * Response Validator — Post-LLM validation and self-correction.
 *
 * Parses LLM responses to extract code blocks, runs TypeScript type-checking
 * and ESLint linting on extracted code, and initiates a self-correction loop
 * when errors are found. Limits correction to a max of 2 iterations, presenting
 * the best result (fewest errors) with a warning if issues remain.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8
 */

import type * as ts from 'typescript';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ValidationResult, Diagnostic } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * The TypeScript compiler is an OPTIONAL runtime capability. It is a
 * devDependency (used by the build/typecheck tooling and the test suite) and is
 * NOT bundled into the packaged Electron app, which ships only production
 * `dependencies`. Importing it eagerly at module load crashed the packaged app
 * on startup with "Cannot find module 'typescript'". We therefore load it
 * lazily and treat its absence like the ESLint path below: runtime TS
 * type-checking is simply skipped (graceful degradation), never a crash.
 *
 * Cached to avoid repeated resolution attempts. `undefined` = not yet attempted,
 * `null` = attempted and unavailable.
 */
let cachedTs: typeof ts | null | undefined;

function loadTypeScript(): typeof ts | null {
  if (cachedTs !== undefined) return cachedTs;
  try {
    // The main process is compiled to CommonJS (tsconfig.main.json:
    // "module": "CommonJS"), so `require` is available natively at runtime.
    // A dynamic (non-literal) specifier keeps bundlers from treating this as a
    // hard dependency edge.
    const moduleName = 'typescript';
    cachedTs = (require as NodeRequire)(moduleName) as typeof ts;
  } catch {
    cachedTs = null;
  }
  return cachedTs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path to forward slashes for consistent map lookups.
 * The TypeScript compiler uses forward slashes internally regardless of platform.
 */
function normalizeToForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Target file descriptor: the file path and content extracted from the LLM response.
 */
export interface FileTarget {
  path: string;
  content: string;
}

/**
 * Result of a self-correction attempt.
 */
export interface CorrectionResult {
  response: string;
  diagnostics: Diagnostic[];
  iterationsUsed: number;
  passed: boolean;
}

/**
 * LLM provider interface for the self-correction loop.
 */
export interface LLMProvider {
  complete(prompt: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum correction iterations. */
const DEFAULT_MAX_CORRECTION_ITERATIONS = 2;

/** Default validation timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Response Validator
// ---------------------------------------------------------------------------

export class ResponseValidator {
  private readonly projectDir: string;
  private readonly maxCorrectionIterations: number;
  private readonly timeoutMs: number;
  private readonly validationDisabled: boolean;
  private llmProvider: LLMProvider | null = null;

  constructor(options: {
    projectDir: string;
    maxCorrectionIterations?: number;
    timeoutMs?: number;
    validationDisabled?: boolean;
  }) {
    this.projectDir = options.projectDir;
    this.maxCorrectionIterations = options.maxCorrectionIterations ?? DEFAULT_MAX_CORRECTION_ITERATIONS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.validationDisabled = options.validationDisabled ?? false;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Set the LLM provider used for self-correction.
   */
  setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Validate an LLM response by running type-checking and linting on extracted
   * code blocks. If validation is disabled, passes through with
   * 'validation_disabled' status.
   */
  async validate(response: string, targetFiles: FileTarget[]): Promise<ValidationResult> {
    if (this.validationDisabled) {
      return {
        passed: true,
        diagnostics: [],
        status: 'validation_disabled',
      };
    }

    const diagnostics = await this.runValidationWithTimeout(targetFiles);
    const errorDiagnostics = diagnostics.filter((d) => d.severity === 'error');

    if (errorDiagnostics.length === 0) {
      return {
        passed: true,
        diagnostics,
        status: 'validated',
      };
    }

    return {
      passed: false,
      diagnostics,
      status: 'errors_found',
    };
  }

  /**
   * Initiate a self-correction loop: re-prompt the LLM with the original prompt,
   * the failed response, and diagnostics. Limited to maxCorrectionIterations.
   * Returns the best result (fewest errors).
   */
  async selfCorrect(
    originalPrompt: string,
    failedResponse: string,
    diagnostics: Diagnostic[],
  ): Promise<CorrectionResult> {
    if (!this.llmProvider) {
      return {
        response: failedResponse,
        diagnostics,
        iterationsUsed: 0,
        passed: false,
      };
    }

    let bestResponse = failedResponse;
    let bestDiagnostics = diagnostics;
    let bestErrorCount = diagnostics.filter((d) => d.severity === 'error').length;
    let iterationsUsed = 0;

    for (let i = 0; i < this.maxCorrectionIterations; i++) {
      iterationsUsed++;

      const correctionPrompt = this.buildCorrectionPrompt(
        originalPrompt,
        i === 0 ? failedResponse : bestResponse,
        i === 0 ? diagnostics : bestDiagnostics,
      );

      let correctedResponse: string;
      try {
        correctedResponse = await this.llmProvider.complete(correctionPrompt);
      } catch {
        // LLM call failed; break out and return best so far
        break;
      }

      // Extract targets from the corrected response and re-validate
      const targets = this.extractCodeBlocks(correctedResponse);
      const newDiagnostics = await this.runValidationWithTimeout(targets);
      const newErrorCount = newDiagnostics.filter((d) => d.severity === 'error').length;

      // Track the best (fewest errors) result
      if (newErrorCount < bestErrorCount) {
        bestResponse = correctedResponse;
        bestDiagnostics = newDiagnostics;
        bestErrorCount = newErrorCount;
      }

      // If no errors remain, we're done
      if (newErrorCount === 0) {
        return {
          response: bestResponse,
          diagnostics: bestDiagnostics,
          iterationsUsed,
          passed: true,
        };
      }
    }

    return {
      response: bestResponse,
      diagnostics: bestDiagnostics,
      iterationsUsed,
      passed: bestErrorCount === 0,
    };
  }

  // -------------------------------------------------------------------------
  // Code Block Extraction
  // -------------------------------------------------------------------------

  /**
   * Parse LLM response to extract code blocks and identify target file paths.
   *
   * Supports markdown fenced code blocks with optional file path annotations:
   * - ```typescript // path/to/file.ts
   * - ```ts file: path/to/file.ts
   * - A preceding line containing a file path (e.g., "**`path/to/file.ts`**:")
   */
  extractCodeBlocks(response: string): FileTarget[] {
    const targets: FileTarget[] = [];
    const codeBlockRegex = /```(?:typescript|ts|javascript|js)?[ \t]*(?:\/\/\s*|file:\s*)?([^\n]*)\n([\s\S]*?)```/g;

    let match: RegExpExecArray | null;
    const lines = response.split('\n');

    while ((match = codeBlockRegex.exec(response)) !== null) {
      let filePath = match[1].trim();
      const content = match[2];

      // If no path in the fence line, look for file path in the preceding line
      if (!filePath || !this.looksLikeFilePath(filePath)) {
        const blockStart = response.substring(0, match.index).split('\n').length - 1;
        if (blockStart > 0) {
          const precedingLine = lines[blockStart - 1] || '';
          const pathMatch = precedingLine.match(
            /(?:`([^`]+\.[a-z]+)`|(\S+\.[a-z]+))/,
          );
          if (pathMatch) {
            const candidate = (pathMatch[1] || pathMatch[2]).replace(/[*:]/g, '').trim();
            if (this.looksLikeFilePath(candidate)) {
              filePath = candidate;
            }
          }
        }
      }

      // Clean up path: remove surrounding quotes, backticks, etc.
      filePath = filePath.replace(/^["'`]+|["'`]+$/g, '').trim();

      if (filePath && this.looksLikeFilePath(filePath)) {
        targets.push({ path: filePath, content });
      } else {
        // Use a generated temp name for unidentified code blocks
        targets.push({ path: `_unnamed_block_${targets.length}.ts`, content });
      }
    }

    return targets;
  }

  // -------------------------------------------------------------------------
  // TypeScript Type-Checking
  // -------------------------------------------------------------------------

  /**
   * Run TypeScript compiler type-checking on the given file targets.
   * Creates a virtual program with the extracted files overlaid on the project.
   */
  private runTypeCheck(targets: FileTarget[]): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    // TypeScript is an optional runtime capability (dev-only dependency, not
    // shipped in the packaged app). If it is unavailable, skip TS type-checking
    // entirely — same graceful-degradation contract as the ESLint path.
    const ts = loadTypeScript();
    if (!ts) {
      return diagnostics;
    }

    // Find tsconfig.json in the project directory
    const tsconfigPath = ts.findConfigFile(
      this.projectDir,
      ts.sys.fileExists,
      'tsconfig.json',
    );

    let compilerOptions: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: true,
      skipLibCheck: true,
    };

    if (tsconfigPath) {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      if (!configFile.error) {
        const parsedConfig = ts.parseJsonConfigFileContent(
          configFile.config,
          ts.sys,
          this.projectDir,
        );
        compilerOptions = { ...parsedConfig.options, noEmit: true };
      }
    }

    // Create a file map for the targets (virtual overlay)
    // Keys are normalized to forward slashes for consistent lookups —
    // the TypeScript compiler uses forward slashes internally on all platforms.
    const fileMap = new Map<string, string>();
    const fileNames: string[] = [];

    for (const target of targets) {
      const resolvedPath = path.isAbsolute(target.path)
        ? target.path
        : path.resolve(this.projectDir, target.path);
      const normalizedPath = normalizeToForwardSlash(resolvedPath);
      fileMap.set(normalizedPath, target.content);
      fileNames.push(normalizedPath);
    }

    // Create a custom compiler host that serves our virtual files
    const defaultHost = ts.createCompilerHost(compilerOptions);
    const customHost: ts.CompilerHost = {
      ...defaultHost,
      getSourceFile(fileName, languageVersion) {
        const virtualContent = fileMap.get(normalizeToForwardSlash(fileName));
        if (virtualContent !== undefined) {
          return ts.createSourceFile(fileName, virtualContent, languageVersion);
        }
        return defaultHost.getSourceFile(fileName, languageVersion);
      },
      fileExists(fileName) {
        return fileMap.has(normalizeToForwardSlash(fileName)) || defaultHost.fileExists(fileName);
      },
      readFile(fileName) {
        const virtualContent = fileMap.get(normalizeToForwardSlash(fileName));
        if (virtualContent !== undefined) {
          return virtualContent;
        }
        return defaultHost.readFile(fileName);
      },
    };

    const program = ts.createProgram(fileNames, compilerOptions, customHost);
    const tsDiagnostics = ts.getPreEmitDiagnostics(program);

    for (const diag of tsDiagnostics) {
      // Only report diagnostics for our target files
      if (!diag.file || !fileMap.has(normalizeToForwardSlash(diag.file.fileName))) {
        continue;
      }

      const lineAndChar = diag.file.getLineAndCharacterOfPosition(diag.start ?? 0);
      diagnostics.push({
        file: path.relative(this.projectDir, diag.file.fileName),
        line: lineAndChar.line + 1,
        severity: diag.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
        message: ts.flattenDiagnosticMessageText(diag.messageText, '\n'),
        source: 'typescript',
      });
    }

    return diagnostics;
  }

  // -------------------------------------------------------------------------
  // ESLint Linting
  // -------------------------------------------------------------------------

  /**
   * Run ESLint on the given file targets. Uses the ESLint CLI via child process.
   * If ESLint is not available, returns an empty array (stub behavior).
   */
  private async runLint(targets: FileTarget[]): Promise<Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];

    // Determine if eslint is available in the project
    const eslintBin = this.findEslintBinary();
    if (!eslintBin) {
      // ESLint not available; stub — return no diagnostics
      return diagnostics;
    }

    // Write target files to temporary locations for linting
    const tempFiles: Array<{ tempPath: string; originalPath: string }> = [];

    try {
      for (const target of targets) {
        const resolvedPath = path.isAbsolute(target.path)
          ? target.path
          : path.resolve(this.projectDir, target.path);

        // Write content to the actual target path temporarily
        // (so ESLint resolves configs relative to the file's location)
        const tempDir = path.dirname(resolvedPath);
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        // Back up existing file if present
        const backupPath = resolvedPath + '.__validator_backup__';
        let hadOriginal = false;
        if (fs.existsSync(resolvedPath)) {
          fs.copyFileSync(resolvedPath, backupPath);
          hadOriginal = true;
        }

        fs.writeFileSync(resolvedPath, target.content, 'utf-8');
        tempFiles.push({ tempPath: resolvedPath, originalPath: hadOriginal ? backupPath : '' });
      }

      // Run ESLint on all target files
      const filePaths = tempFiles.map((f) => f.tempPath);
      try {
        const { stdout } = await execFileAsync(
          eslintBin,
          ['--format', 'json', '--no-eslintrc', ...filePaths],
          {
            cwd: this.projectDir,
            timeout: this.timeoutMs,
            maxBuffer: 1024 * 1024,
          },
        );

        const results = JSON.parse(stdout) as Array<{
          filePath: string;
          messages: Array<{
            line: number;
            severity: number;
            message: string;
          }>;
        }>;

        for (const result of results) {
          for (const msg of result.messages) {
            if (msg.severity === 2) {
              // error-level only
              diagnostics.push({
                file: path.relative(this.projectDir, result.filePath),
                line: msg.line,
                severity: 'error',
                message: msg.message,
                source: 'eslint',
              });
            }
          }
        }
      } catch (error: unknown) {
        // ESLint exits with code 1 when there are lint errors; parse stdout
        if (error && typeof error === 'object' && 'stdout' in error) {
          const errObj = error as { stdout: string };
          try {
            const results = JSON.parse(errObj.stdout) as Array<{
              filePath: string;
              messages: Array<{
                line: number;
                severity: number;
                message: string;
              }>;
            }>;

            for (const result of results) {
              for (const msg of result.messages) {
                if (msg.severity === 2) {
                  diagnostics.push({
                    file: path.relative(this.projectDir, result.filePath),
                    line: msg.line,
                    severity: 'error',
                    message: msg.message,
                    source: 'eslint',
                  });
                }
              }
            }
          } catch {
            // Failed to parse ESLint output; skip lint diagnostics
          }
        }
      }
    } finally {
      // Restore original files
      for (const { tempPath, originalPath } of tempFiles) {
        if (originalPath) {
          fs.copyFileSync(originalPath, tempPath);
          fs.unlinkSync(originalPath);
        } else {
          // Remove the file we created
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }

    return diagnostics;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Run validation (type-check + lint) with a timeout guard.
   */
  private async runValidationWithTimeout(targets: FileTarget[]): Promise<Diagnostic[]> {
    if (targets.length === 0) {
      return [];
    }

    const timeoutPromise = new Promise<Diagnostic[]>((resolve) => {
      setTimeout(() => {
        resolve([
          {
            file: '_timeout',
            line: 0,
            severity: 'error' as const,
            message: `Validation timed out after ${this.timeoutMs}ms`,
            source: 'typescript' as const,
          },
        ]);
      }, this.timeoutMs);
    });

    const validationPromise = (async (): Promise<Diagnostic[]> => {
      // Run TypeScript type-checking synchronously (compiler API is sync)
      const tsDiagnostics = this.runTypeCheck(targets);

      // Run linting asynchronously
      const lintDiagnostics = await this.runLint(targets);

      return [...tsDiagnostics, ...lintDiagnostics];
    })();

    return Promise.race([validationPromise, timeoutPromise]);
  }

  /**
   * Build a correction prompt including the original prompt, failed response,
   * and error diagnostics.
   */
  private buildCorrectionPrompt(
    originalPrompt: string,
    failedResponse: string,
    diagnostics: Diagnostic[],
  ): string {
    const errorMessages = diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `[${d.source}] ${d.file}:${d.line} — ${d.message}`)
      .join('\n');

    return [
      'The following code response failed validation. Please fix the errors and provide a corrected version.',
      '',
      '## Original Prompt',
      originalPrompt,
      '',
      '## Failed Response',
      failedResponse,
      '',
      '## Validation Errors',
      errorMessages,
      '',
      '## Instructions',
      'Fix all the above errors while preserving the original intent. Return only the corrected code blocks in the same format.',
    ].join('\n');
  }

  /**
   * Check whether a string looks like a file path.
   */
  private looksLikeFilePath(str: string): boolean {
    if (!str || str.length === 0) return false;
    // Must contain at least one path separator or a file extension
    return /[/\\]/.test(str) || /\.\w{1,10}$/.test(str);
  }

  /**
   * Find the ESLint binary in the project's node_modules.
   */
  private findEslintBinary(): string | null {
    const candidates = [
      path.resolve(this.projectDir, 'node_modules', '.bin', 'eslint'),
      path.resolve(this.projectDir, 'node_modules', 'eslint', 'bin', 'eslint.js'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}
