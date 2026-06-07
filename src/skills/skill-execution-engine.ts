// Skill execution engine: 4-mode execution with timeout, audit logging

import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillDefinition } from './skill-metadata-parser.js';
import { writeFileWithHeader } from '../utils/project-headers';

export interface ExecutionInput {
  prompt: string;
  filePaths?: string[];
  projectDir: string;
  parameters?: Record<string, unknown>;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  structured?: Record<string, unknown>;
  error?: string;
  logs: string[];
  durationMs: number;
}

export type ExecutionMode = 'pure-instruction' | 'shell-script' | 'node-script' | 'workspace-action';

const DEFAULT_TIMEOUT = 30_000;
const SIGKILL_DELAY = 1_000;

/**
 * Determine the execution mode for a skill based on its metadata.
 */
function resolveMode(skill: SkillDefinition): ExecutionMode {
  const meta = skill.metadata;
  if (meta.mode && typeof meta.mode === 'string') {
    const m = meta.mode as string;
    if (m === 'pure-instruction' || m === 'shell-script' || m === 'node-script' || m === 'workspace-action') {
      return m;
    }
  }

  // Infer from entrypoint
  if (!skill.entrypoint) return 'pure-instruction';

  if (skill.entrypoint.endsWith('.sh') || skill.entrypoint.endsWith('.bash')) {
    return 'shell-script';
  }
  if (
    skill.entrypoint.endsWith('.js') ||
    skill.entrypoint.endsWith('.ts') ||
    skill.entrypoint.endsWith('.mjs') ||
    skill.entrypoint.endsWith('.tsx')
  ) {
    return 'node-script';
  }

  return 'shell-script';
}

export class ExecutionEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Execute a skill in its declared mode. */
  async execute(
    skill: SkillDefinition,
    input: ExecutionInput,
    options?: { timeout?: number; isTest?: boolean },
  ): Promise<ExecutionResult> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    const isTest = options?.isTest ?? false;
    const mode = resolveMode(skill);
    const startTime = Date.now();

    let result: ExecutionResult;

    try {
      switch (mode) {
        case 'pure-instruction':
          result = this.executePureInstruction(skill, input);
          break;
        case 'shell-script':
          result = await this.executeShellScript(skill, input, timeout);
          break;
        case 'node-script':
          result = await this.executeNodeScript(skill, input, timeout);
          break;
        case 'workspace-action':
          result = this.executeWorkspaceAction(skill, input);
          break;
        default:
          result = {
            success: false,
            output: '',
            error: `Unknown execution mode: ${mode as string}`,
            logs: [],
            durationMs: Date.now() - startTime,
          };
      }
    } catch (err) {
      result = {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        logs: [`Unexpected error: ${err instanceof Error ? err.message : String(err)}`],
        durationMs: Date.now() - startTime,
      };
    }

    // Ensure durationMs is set
    result.durationMs = Date.now() - startTime;

    // Log execution to skill_executions table
    this.logExecution(skill.id, mode, result, input, isTest);

    return result;
  }

  /** pure-instruction: return skill content as output string */
  private executePureInstruction(skill: SkillDefinition, input: ExecutionInput): ExecutionResult {
    const output = skill.content || '';
    return {
      success: true,
      output,
      logs: ['Mode: pure-instruction', `Content length: ${output.length}`],
      durationMs: 0,
    };
  }

  /** shell-script: spawn child_process.execFile with entrypoint */
  private executeShellScript(
    skill: SkillDefinition,
    input: ExecutionInput,
    timeout: number,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      if (!skill.entrypoint) {
        resolve({
          success: false,
          output: '',
          error: 'No entrypoint specified for shell-script mode',
          logs: ['Missing entrypoint'],
          durationMs: 0,
        });
        return;
      }

      const entrypoint = skill.entrypoint;
      const cwd = input.projectDir;

      // Validate entrypoint has no directory traversal
      if (entrypoint.includes('..')) {
        resolve({
          success: false,
          output: '',
          error: 'Entrypoint contains directory traversal sequences (..)',
          logs: ['Rejected: directory traversal in entrypoint'],
          durationMs: 0,
        });
        return;
      }

      const logs: string[] = [`Mode: shell-script`, `Entrypoint: ${entrypoint}`, `CWD: ${cwd}`];
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = execFile(
        entrypoint,
        [],
        { cwd, timeout: 0, env: { ...process.env, SKILL_PROMPT: input.prompt } },
        (error, stdoutBuf, stderrBuf) => {
          stdout = stdoutBuf || '';
          stderr = stderrBuf || '';

          if (stdout) logs.push(`stdout: ${stdout.substring(0, 500)}`);
          if (stderr) logs.push(`stderr: ${stderr.substring(0, 500)}`);

          if (killed) {
            resolve({
              success: false,
              output: stdout,
              error: `Execution timed out after ${timeout}ms`,
              logs: [...logs, `Timed out after ${timeout}ms`],
              durationMs: 0,
            });
            return;
          }

          if (error) {
            resolve({
              success: false,
              output: stdout,
              error: error.message,
              logs: [...logs, `Error: ${error.message}`],
              durationMs: 0,
            });
            return;
          }

          // Try to parse structured output from stdout
          let structured: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(stdout);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              structured = parsed as Record<string, unknown>;
            }
          } catch {
            // Not JSON, that's fine
          }

          resolve({
            success: true,
            output: stdout,
            structured,
            logs,
            durationMs: 0,
          });
        },
      );

      // Timeout handling: SIGTERM first, then SIGKILL after 1s
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }, SIGKILL_DELAY);
      }, timeout);

      child.on('close', () => {
        clearTimeout(timer);
      });
    });
  }

  /** node-script: spawn node (or tsx) with entrypoint file */
  private executeNodeScript(
    skill: SkillDefinition,
    input: ExecutionInput,
    timeout: number,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      if (!skill.entrypoint) {
        resolve({
          success: false,
          output: '',
          error: 'No entrypoint specified for node-script mode',
          logs: ['Missing entrypoint'],
          durationMs: 0,
        });
        return;
      }

      const entrypoint = skill.entrypoint;
      const cwd = input.projectDir;

      // Validate entrypoint has no directory traversal
      if (entrypoint.includes('..')) {
        resolve({
          success: false,
          output: '',
          error: 'Entrypoint contains directory traversal sequences (..)',
          logs: ['Rejected: directory traversal in entrypoint'],
          durationMs: 0,
        });
        return;
      }

      // Determine runner: tsx for .ts/.tsx files, node for .js/.mjs
      const runner = entrypoint.endsWith('.ts') || entrypoint.endsWith('.tsx') ? 'tsx' : 'node';

      const logs: string[] = [`Mode: node-script`, `Runner: ${runner}`, `Entrypoint: ${entrypoint}`, `CWD: ${cwd}`];
      let stdout = '';
      let stderr = '';
      let killed = false;

      const child = execFile(
        runner,
        [entrypoint],
        { cwd, timeout: 0, env: { ...process.env, SKILL_PROMPT: input.prompt } },
        (error, stdoutBuf, stderrBuf) => {
          stdout = stdoutBuf || '';
          stderr = stderrBuf || '';

          if (stdout) logs.push(`stdout: ${stdout.substring(0, 500)}`);
          if (stderr) logs.push(`stderr: ${stderr.substring(0, 500)}`);

          if (killed) {
            resolve({
              success: false,
              output: stdout,
              error: `Execution timed out after ${timeout}ms`,
              logs: [...logs, `Timed out after ${timeout}ms`],
              durationMs: 0,
            });
            return;
          }

          if (error) {
            resolve({
              success: false,
              output: stdout,
              error: error.message,
              logs: [...logs, `Error: ${error.message}`],
              durationMs: 0,
            });
            return;
          }

          // Try to parse structured output from stdout
          let structured: Record<string, unknown> | undefined;
          try {
            const parsed = JSON.parse(stdout);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              structured = parsed as Record<string, unknown>;
            }
          } catch {
            // Not JSON, that's fine
          }

          resolve({
            success: true,
            output: stdout,
            structured,
            logs,
            durationMs: 0,
          });
        },
      );

      // Timeout handling: SIGTERM first, then SIGKILL after 1s
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }, SIGKILL_DELAY);
      }, timeout);

      child.on('close', () => {
        clearTimeout(timer);
      });
    });
  }

  /** workspace-action: file-system operations scoped to projectDir */
  private executeWorkspaceAction(skill: SkillDefinition, input: ExecutionInput): ExecutionResult {
    const logs: string[] = [`Mode: workspace-action`, `ProjectDir: ${input.projectDir}`];

    try {
      const params = input.parameters ?? {};
      const action = (params.action as string) || 'create';
      const targetPath = params.targetPath as string | undefined;
      const content = params.content as string | undefined;

      if (!targetPath) {
        return {
          success: false,
          output: '',
          error: 'workspace-action requires parameters.targetPath',
          logs: [...logs, 'Missing targetPath parameter'],
          durationMs: 0,
        };
      }

      // Resolve and validate path is within projectDir
      const resolved = path.resolve(input.projectDir, targetPath);
      if (!resolved.startsWith(path.resolve(input.projectDir))) {
        return {
          success: false,
          output: '',
          error: 'Target path escapes project directory',
          logs: [...logs, `Rejected: path traversal attempt (${targetPath})`],
          durationMs: 0,
        };
      }

      logs.push(`Action: ${action}`, `Target: ${resolved}`);

      switch (action) {
        case 'create': {
          const dir = path.dirname(resolved);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          writeFileWithHeader(resolved, content ?? skill.content ?? '');
          logs.push(`Created file: ${resolved}`);
          return {
            success: true,
            output: `Created ${targetPath}`,
            logs,
            durationMs: 0,
          };
        }
        case 'copy': {
          const sourcePath = params.sourcePath as string | undefined;
          if (!sourcePath) {
            return {
              success: false,
              output: '',
              error: 'copy action requires parameters.sourcePath',
              logs: [...logs, 'Missing sourcePath parameter'],
              durationMs: 0,
            };
          }
          const resolvedSource = path.resolve(input.projectDir, sourcePath);
          if (!resolvedSource.startsWith(path.resolve(input.projectDir))) {
            return {
              success: false,
              output: '',
              error: 'Source path escapes project directory',
              logs: [...logs, `Rejected: source path traversal attempt (${sourcePath})`],
              durationMs: 0,
            };
          }
          const destDir = path.dirname(resolved);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }
          fs.copyFileSync(resolvedSource, resolved);
          logs.push(`Copied ${sourcePath} → ${targetPath}`);
          return {
            success: true,
            output: `Copied ${sourcePath} to ${targetPath}`,
            logs,
            durationMs: 0,
          };
        }
        case 'delete': {
          if (fs.existsSync(resolved)) {
            fs.unlinkSync(resolved);
            logs.push(`Deleted: ${resolved}`);
          }
          return {
            success: true,
            output: `Deleted ${targetPath}`,
            logs,
            durationMs: 0,
          };
        }
        default:
          return {
            success: false,
            output: '',
            error: `Unknown workspace action: ${action}`,
            logs: [...logs, `Unknown action: ${action}`],
            durationMs: 0,
          };
      }
    } catch (err) {
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        logs: [...logs, `Error: ${err instanceof Error ? err.message : String(err)}`],
        durationMs: 0,
      };
    }
  }

  /** Log execution to skill_executions table */
  private logExecution(
    skillId: string,
    mode: ExecutionMode,
    result: ExecutionResult,
    input: ExecutionInput,
    isTest: boolean,
  ): void {
    try {
      const id = crypto.randomUUID();
      this.db
        .prepare(
          `INSERT INTO skill_executions (id, skill_id, mode, duration_ms, success, input_summary, output_summary, error, test)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          skillId,
          mode,
          result.durationMs,
          result.success ? 1 : 0,
          input.prompt.substring(0, 500),
          result.output.substring(0, 500),
          result.error ?? null,
          isTest ? 1 : 0,
        );
    } catch (err) {
      console.warn('[ExecutionEngine] Failed to log execution:', err);
    }
  }
}
