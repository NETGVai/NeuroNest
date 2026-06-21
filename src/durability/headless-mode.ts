/**
 * HeadlessMode — Non-interactive execution adapter for CI/pipeline environments.
 *
 * Provides structured JSON logging, permission policy enforcement for unattended
 * decisions, task definition loading from JSON file or CLI argument, and
 * appropriate exit code mapping.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentLoopConfig } from '../pipeline/agent-loop.js';

// ─── Exit Codes ─────────────────────────────────────────────────

/** Standard exit codes for headless execution */
export const EXIT_CODES = {
  SUCCESS: 0 as const,
  TASK_FAILURE: 1 as const,
  CONFIG_ERROR: 2 as const,
};

// ─── Interfaces ─────────────────────────────────────────────────

/** Permission policy levels for unattended decision-making */
export type PermissionPolicy = 'deny-all' | 'auto-approve-read' | 'auto-approve-all';

/**
 * A single permission rule within a policy file.
 * Matches actions by category and optionally by a target glob pattern.
 */
export interface PermissionRule {
  action: string;
  target?: string;
  decision: 'allow' | 'deny';
}

/**
 * Structure of a permission policy file loaded from disk.
 * Contains a default policy and optional fine-grained rules.
 */
export interface PermissionPolicyFile {
  defaultPolicy: PermissionPolicy;
  rules?: PermissionRule[];
}

/** Configuration for headless mode execution */
export interface HeadlessConfig {
  /** Task definition — path to a JSON file or an inline task object */
  taskDefinition: string | object;
  /** Base permission policy for unattended decisions */
  permissionPolicy: PermissionPolicy;
  /** Optional path to a permission policy file with fine-grained rules */
  permissionPolicyPath?: string;
  /** Output format for logs */
  outputFormat: 'json' | 'text';
  /** Optional execution timeout in milliseconds */
  timeout?: number;
}

/** Result of a headless execution run */
export interface HeadlessResult {
  exitCode: 0 | 1 | 2;
  output: unknown;
  costUsd?: number;
  durationMs: number;
}

/** Structured log entry emitted to stdout in JSON format */
export interface HeadlessLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  data?: unknown;
}

// ─── HeadlessMode Class ─────────────────────────────────────────

export class HeadlessMode {
  /**
   * Adapts an AgentLoopConfig for non-interactive (headless) execution.
   *
   * - Removes UI callbacks (onProgress, onPlanReady, ipcSend)
   * - Replaces onBudgetExceeded with a policy-based auto-decision
   * - Wires structured JSON logging via emitLog()
   *
   * Requirement 19.1: Operate without interactive prompts or Electron UI dependencies
   */
  static configureForHeadless(
    loopConfig: AgentLoopConfig,
    headlessConfig: HeadlessConfig,
  ): AgentLoopConfig {
    const policyFile = headlessConfig.permissionPolicyPath
      ? HeadlessMode.loadPolicyFile(headlessConfig.permissionPolicyPath)
      : null;

    const effectivePolicy = policyFile?.defaultPolicy ?? headlessConfig.permissionPolicy;

    // Strip interactive callbacks and wire headless-appropriate replacements
    // Use destructuring to omit ipcSend (not available in headless, Req 19.1)
    const { ipcSend: _ipcSend, ...baseConfig } = loopConfig;

    const adapted: AgentLoopConfig = {
      ...baseConfig,
      // Replace interactive progress with structured logging
      onProgress: (update) => {
        HeadlessMode.emitLog('progress', {
          iteration: update.iteration,
          maxIterations: update.maxIterations,
          status: update.status,
          lastToolCall: update.lastToolCall,
        });
      },
      // Auto-approve plans in headless mode (no user to prompt)
      onPlanReady: async (plan) => {
        const shouldApprove = effectivePolicy === 'auto-approve-all';
        HeadlessMode.emitLog('plan_decision', {
          approved: shouldApprove,
          stepsCount: plan.steps?.length ?? 0,
          policy: effectivePolicy,
        });
        return shouldApprove ? 'approved' : 'rejected';
      },
      // Budget exceeded — consult policy instead of prompting user
      onBudgetExceeded: async (info) => {
        const allow = effectivePolicy === 'auto-approve-all';
        HeadlessMode.emitLog('budget_exceeded', {
          ...info,
          decision: allow ? 'continue' : 'stop',
          policy: effectivePolicy,
        });
        return allow;
      },
    };

    return adapted;
  }

  /**
   * Emit a structured JSON log line to stdout.
   *
   * Each log line is a self-contained JSON object with timestamp, level, event name,
   * and optional data payload. This enables machine-parseable output for CI systems.
   *
   * Requirement 19.2: Output structured JSON logs to stdout
   */
  static emitLog(event: string, data?: unknown, level: 'info' | 'warn' | 'error' | 'debug' = 'info'): void {
    const entry: HeadlessLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(data !== undefined ? { data } : {}),
    };

    const line = JSON.stringify(entry);
    process.stdout.write(line + '\n');
  }

  /**
   * Load a task definition from either a JSON file path or inline object.
   *
   * When taskDefinition is a string, it is treated as a file path to a JSON file.
   * When it is an object, it is used directly as the task definition.
   *
   * Requirement 19.5: Accept task definitions via JSON input file or CLI argument
   */
  static loadTaskDefinition(taskDefinition: string | object): { task: object | null; error?: string } {
    if (typeof taskDefinition === 'object' && taskDefinition !== null) {
      return { task: taskDefinition };
    }

    if (typeof taskDefinition === 'string') {
      const resolvedPath = path.resolve(taskDefinition);

      if (!fs.existsSync(resolvedPath)) {
        return { task: null, error: `Task definition file not found: ${resolvedPath}` };
      }

      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return { task: null, error: `Task definition file must contain a JSON object: ${resolvedPath}` };
        }
        return { task: parsed };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { task: null, error: `Failed to parse task definition file: ${message}` };
      }
    }

    return { task: null, error: 'Invalid task definition: must be a file path string or an object' };
  }

  /**
   * Determine the appropriate exit code based on execution outcome.
   *
   * Requirement 19.3: Exit codes 0=success, 1=task failure, 2=config error
   */
  static resolveExitCode(result: { success: boolean; configError?: boolean }): 0 | 1 | 2 {
    if (result.configError) {
      return EXIT_CODES.CONFIG_ERROR;
    }
    return result.success ? EXIT_CODES.SUCCESS : EXIT_CODES.TASK_FAILURE;
  }

  /**
   * Evaluate a permission decision against the configured policy and optional policy file rules.
   *
   * Requirement 19.4: Consult pre-configured policy file rather than prompting the user
   */
  static evaluatePermission(
    action: string,
    target: string | undefined,
    policy: PermissionPolicy,
    policyFile?: PermissionPolicyFile | null,
  ): 'allow' | 'deny' {
    // Check fine-grained rules from policy file first (most specific wins)
    if (policyFile?.rules) {
      for (const rule of policyFile.rules) {
        if (rule.action === action || rule.action === '*') {
          if (!rule.target || !target || HeadlessMode.matchGlob(target, rule.target)) {
            return rule.decision;
          }
        }
      }
    }

    // Fall back to the base policy
    const effectivePolicy = policyFile?.defaultPolicy ?? policy;

    switch (effectivePolicy) {
      case 'auto-approve-all':
        return 'allow';
      case 'auto-approve-read':
        return HeadlessMode.isReadAction(action) ? 'allow' : 'deny';
      case 'deny-all':
      default:
        return 'deny';
    }
  }

  /**
   * Load and validate a permission policy file from disk.
   *
   * Returns null (with a warning log) if the file is missing, corrupted, or invalid.
   */
  static loadPolicyFile(filePath: string): PermissionPolicyFile | null {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      HeadlessMode.emitLog('policy_file_missing', { path: resolvedPath }, 'warn');
      return null;
    }

    try {
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const parsed = JSON.parse(content);

      if (typeof parsed !== 'object' || parsed === null) {
        HeadlessMode.emitLog('policy_file_invalid', { path: resolvedPath, reason: 'not an object' }, 'error');
        return null;
      }

      const validPolicies: PermissionPolicy[] = ['deny-all', 'auto-approve-read', 'auto-approve-all'];
      if (!validPolicies.includes(parsed.defaultPolicy)) {
        HeadlessMode.emitLog('policy_file_invalid', {
          path: resolvedPath,
          reason: `invalid defaultPolicy: ${parsed.defaultPolicy}`,
        }, 'error');
        return null;
      }

      // Validate rules array if present
      if (parsed.rules !== undefined) {
        if (!Array.isArray(parsed.rules)) {
          HeadlessMode.emitLog('policy_file_invalid', {
            path: resolvedPath,
            reason: 'rules must be an array',
          }, 'error');
          return null;
        }

        for (const rule of parsed.rules) {
          if (typeof rule.action !== 'string' || !['allow', 'deny'].includes(rule.decision)) {
            HeadlessMode.emitLog('policy_file_invalid', {
              path: resolvedPath,
              reason: `invalid rule: ${JSON.stringify(rule)}`,
            }, 'error');
            return null;
          }
        }
      }

      return parsed as PermissionPolicyFile;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      HeadlessMode.emitLog('policy_file_error', { path: resolvedPath, error: message }, 'error');
      return null;
    }
  }

  /**
   * Execute a headless run, orchestrating the full lifecycle:
   * load task → configure → run → return result with exit code.
   *
   * This is the primary entry point for CI/pipeline invocations.
   */
  static async run(
    headlessConfig: HeadlessConfig,
    loopConfig: AgentLoopConfig,
    executor: (config: AgentLoopConfig, task: object) => Promise<{ success: boolean; output: unknown; costUsd?: number }>,
  ): Promise<HeadlessResult> {
    const startTime = Date.now();

    HeadlessMode.emitLog('headless_start', {
      permissionPolicy: headlessConfig.permissionPolicy,
      outputFormat: headlessConfig.outputFormat,
      hasTimeout: headlessConfig.timeout !== undefined,
    });

    // Load task definition (Req 19.5)
    const { task, error } = HeadlessMode.loadTaskDefinition(headlessConfig.taskDefinition);
    if (!task) {
      HeadlessMode.emitLog('config_error', { error }, 'error');
      return {
        exitCode: EXIT_CODES.CONFIG_ERROR,
        output: { error },
        durationMs: Date.now() - startTime,
      };
    }

    HeadlessMode.emitLog('task_loaded', { task });

    // Configure agent loop for headless execution (Req 19.1)
    const adaptedConfig = HeadlessMode.configureForHeadless(loopConfig, headlessConfig);

    // Execute with optional timeout
    try {
      let result: { success: boolean; output: unknown; costUsd?: number };

      if (headlessConfig.timeout && headlessConfig.timeout > 0) {
        result = await HeadlessMode.withTimeout(
          executor(adaptedConfig, task),
          headlessConfig.timeout,
        );
      } else {
        result = await executor(adaptedConfig, task);
      }

      const exitCode = HeadlessMode.resolveExitCode(result);
      const durationMs = Date.now() - startTime;

      HeadlessMode.emitLog('headless_complete', {
        exitCode,
        success: result.success,
        costUsd: result.costUsd,
        durationMs,
      });

      const headlessResult: HeadlessResult = {
        exitCode,
        output: result.output,
        durationMs,
      };
      if (result.costUsd !== undefined) {
        headlessResult.costUsd = result.costUsd;
      }

      return headlessResult;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message === 'HEADLESS_TIMEOUT';

      HeadlessMode.emitLog('headless_error', {
        error: isTimeout ? 'Execution timed out' : message,
        isTimeout,
        durationMs,
      }, 'error');

      return {
        exitCode: EXIT_CODES.TASK_FAILURE,
        output: { error: isTimeout ? 'Execution timed out' : message },
        durationMs,
      };
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Wrap a promise with a timeout. Rejects with HEADLESS_TIMEOUT error if exceeded.
   */
  private static withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('HEADLESS_TIMEOUT'));
      }, timeoutMs);

      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Simple glob matching for permission rule targets.
   * Supports `*` (any sequence of non-path chars) and `**` (any path).
   */
  private static matchGlob(value: string, pattern: string): boolean {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{DOUBLE_STAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{DOUBLE_STAR\}\}/g, '.*');

    const regex = new RegExp(`^${escaped}$`);
    return regex.test(value);
  }

  /**
   * Determine if an action is a read-only operation.
   * Used by 'auto-approve-read' policy to allow reads and deny writes.
   */
  private static isReadAction(action: string): boolean {
    const readActions = [
      'file_read',
      'directory_list',
      'search',
      'grep',
      'diagnostics',
      'lsp_query',
      'git_status',
      'git_log',
      'git_diff',
    ];
    return readActions.includes(action) || action.startsWith('read_') || action.startsWith('list_');
  }
}
