/**
 * TypeScript type-checking stage.
 * Runs tsc --noEmit on affected files to detect type errors.
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
} from '../types';
import { STAGE_SCORES } from '../types';

const execAsync = promisify(exec);

// ─── tsc Output Parser ──────────────────────────────────────────

interface TscError {
  file: string;
  line: number;
  column: number;
  message: string;
}

/**
 * Parses tsc output to extract structured error information.
 * tsc format: file(line,col): error TSxxxx: message
 */
function parseTscOutput(output: string, rootDir: string): TscError[] {
  const errors: TscError[] = [];
  const errorRegex = /^(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = errorRegex.exec(output)) !== null) {
    const filePath = match[1].trim();
    errors.push({
      file: path.isAbsolute(filePath) ? path.relative(rootDir, filePath) : filePath,
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      message: match[4].trim(),
    });
  }

  return errors;
}

// ─── TypeCheck Command Runner ───────────────────────────────────

export interface TypeCheckRunner {
  run(files: string[], tsconfigPath: string, rootDir: string): Promise<{ errors: TscError[] }>;
}

export class DefaultTypeCheckRunner implements TypeCheckRunner {
  async run(files: string[], tsconfigPath: string, rootDir: string): Promise<{ errors: TscError[] }> {
    const tsConfigArg = `--project ${tsconfigPath}`;
    const cmd = `npx tsc ${tsConfigArg} --noEmit`;

    try {
      await execAsync(cmd, {
        cwd: rootDir,
        timeout: 20_000,
        env: { ...process.env, NODE_OPTIONS: '' },
      });
      return { errors: [] };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; stderr?: string; message?: string };
      const output = (execError.stdout || '') + (execError.stderr || '');
      const errors = parseTscOutput(output, rootDir);
      return { errors };
    }
  }
}

// ─── TypeCheck Stage ────────────────────────────────────────────

export class TypecheckStage implements VerificationStage {
  readonly name = 'typecheck' as const;
  readonly score = STAGE_SCORES.typecheck;

  constructor(private runner: TypeCheckRunner = new DefaultTypeCheckRunner()) {}

  async execute(edit: AgentEdit, context: ProjectContext): Promise<StageResult> {
    const startTime = Date.now();
    const files = edit.changes.map(c => c.filePath);

    const { errors } = await this.runner.run(files, context.tsconfigPath, context.rootDir);

    const diagnostics: Diagnostic[] = errors.map(e => ({
      file: e.file,
      line: e.line,
      column: e.column,
      message: e.message,
      severity: 'error' as const,
    }));

    return {
      stageName: 'typecheck',
      passed: diagnostics.length === 0,
      diagnostics,
      durationMs: Date.now() - startTime,
    };
  }
}
