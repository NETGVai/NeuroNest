/**
 * HookEngine — Deterministic pre/post tool-use and stop hooks.
 *
 * User-definable hooks enforce deterministic policies so that every edit
 * exits in a known state and loops operate on a reliable policy floor.
 *
 * Event types:
 *   - PreToolUse: evaluated before a tool call; nonzero exit blocks the call.
 *   - PostToolUse: executed after a tool call; logs warning on failure.
 *   - Stop: executed at turn-end; output appended to iteration log.
 *
 * All hooks run within Permission_Pattern_Engine constraints. Before executing
 * any hook command, the engine checks if "Bash(command)" is allowed by the
 * permission engine. Hooks are the first line of policy enforcement, evaluated
 * before the Permission_Pattern_Engine and Action_Security_Analyzer (REQ-22.7).
 *
 * Gated behind the `harness_hooks` feature flag (REQ-22.6).
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { getLogger } from '../../utils/structured-logger';

const execAsync = promisify(exec);
const LOG_SOURCE = 'HookEngine';

// ─── Types ──────────────────────────────────────────────────────

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'Stop';

export interface HookDefinition {
  /** Which event triggers this hook */
  event: HookEvent;
  /** Pattern to match against "ToolName(args)". If omitted, matches all. */
  matcher?: string;
  /** Shell command to execute */
  command: string;
  /** Timeout in milliseconds (default 30000) */
  timeout?: number;
}

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Minimal interface for the Permission Pattern Engine dependency.
 * Allows testing with stubs without importing the full implementation.
 */
export interface PermissionPatternEngineLike {
  evaluate(toolName: string, args: string): 'allow' | 'deny' | 'no-match';
}

// ─── Default timeout ────────────────────────────────────────────

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

// ─── HookEngine ─────────────────────────────────────────────────

export class HookEngine {
  private readonly hooks: HookDefinition[];
  private readonly permissionEngine: PermissionPatternEngineLike;

  constructor(
    hooks: HookDefinition[],
    permissionEngine: PermissionPatternEngineLike,
  ) {
    this.hooks = hooks;
    this.permissionEngine = permissionEngine;
  }

  /**
   * Evaluate PreToolUse hooks matching the given tool invocation.
   *
   * Returns the block reason (hook's stderr) if any hook exits nonzero,
   * or null if all hooks pass (or no hooks match).
   *
   * REQ-22.2: If the command exits with a nonzero code, the tool call
   * is blocked and the hook's stderr output is surfaced as the block reason.
   * REQ-22.7: PreToolUse hooks are evaluated first, before permission engine
   * and action security analyzer.
   */
  async evaluatePreToolUse(toolName: string, args: string): Promise<string | null> {
    const matchingHooks = this.getMatchingHooks('PreToolUse', toolName, args);

    for (const hook of matchingHooks) {
      // Check permission before executing (REQ-22.5)
      if (!this.isCommandPermitted(hook.command)) {
        continue;
      }

      const result = await this.executeCommand(hook.command, hook.timeout);

      if (result.exitCode !== 0) {
        // Nonzero exit → block the tool call with stderr as reason
        const reason = result.stderr.trim() || `Hook command exited with code ${result.exitCode}`;
        return reason;
      }
    }

    return null;
  }

  /**
   * Execute PostToolUse hooks matching the given tool invocation.
   *
   * Runs matching hooks silently on success. On failure (nonzero exit),
   * logs a warning. Does not block execution.
   *
   * REQ-22.3: PostToolUse hook executes silently on success; on nonzero
   * exit, logs a warning and publishes a hook:failure event.
   */
  async executePostToolUse(toolName: string, args: string): Promise<HookResult[]> {
    const matchingHooks = this.getMatchingHooks('PostToolUse', toolName, args);
    const results: HookResult[] = [];

    for (const hook of matchingHooks) {
      // Check permission before executing (REQ-22.5)
      if (!this.isCommandPermitted(hook.command)) {
        continue;
      }

      const result = await this.executeCommand(hook.command, hook.timeout);
      results.push(result);

      if (result.exitCode !== 0) {
        // Log warning on failure (REQ-22.3)
        getLogger().warn(LOG_SOURCE, `PostToolUse hook failed: command="${hook.command}" exitCode=${result.exitCode}`, {
          stderr: result.stderr.trim(),
        });
      }
    }

    return results;
  }

  /**
   * Execute Stop hooks at turn-end.
   *
   * Runs all Stop hooks and returns their results. Output is appended
   * to the iteration log for the current pass.
   *
   * REQ-22.4: Stop hook executes at the end of each loop pass; its output
   * is appended to the iteration log.
   */
  async executeStopHooks(): Promise<HookResult[]> {
    const stopHooks = this.hooks.filter((h) => h.event === 'Stop');
    const results: HookResult[] = [];

    for (const hook of stopHooks) {
      // Check permission before executing (REQ-22.5)
      if (!this.isCommandPermitted(hook.command)) {
        continue;
      }

      const result = await this.executeCommand(hook.command, hook.timeout);
      results.push(result);
    }

    return results;
  }

  // ─── Private helpers ────────────────────────────────────────────

  /**
   * Get hooks matching the given event and tool invocation pattern.
   *
   * If a hook's matcher is defined, it is tested against "ToolName(args)".
   * If matcher is undefined, the hook matches all tool invocations for that event.
   */
  private getMatchingHooks(event: HookEvent, toolName: string, args: string): HookDefinition[] {
    const invocationString = `${toolName}(${args})`;

    return this.hooks.filter((hook) => {
      if (hook.event !== event) return false;

      // No matcher → matches all tool invocations for this event
      if (!hook.matcher) return true;

      // Match against "ToolName(args)" pattern
      return this.matchesPattern(invocationString, hook.matcher);
    });
  }

  /**
   * Test whether an invocation string matches a hook's matcher pattern.
   *
   * The matcher supports glob-like patterns:
   *   * → matches any sequence of characters
   *   ? → matches a single character
   *   All other characters are literal.
   */
  private matchesPattern(invocation: string, matcher: string): boolean {
    // Convert the matcher pattern to a regex
    let regexStr = '';
    for (let i = 0; i < matcher.length; i++) {
      const ch = matcher.charAt(i);
      if (ch === '*') {
        regexStr += '.*';
      } else if (ch === '?') {
        regexStr += '.';
      } else if ('.+^${}()|[]\\'.includes(ch)) {
        regexStr += '\\' + ch;
      } else {
        regexStr += ch;
      }
    }

    try {
      const regex = new RegExp(`^${regexStr}$`);
      return regex.test(invocation);
    } catch {
      // Invalid pattern → no match
      return false;
    }
  }

  /**
   * Check if a command is permitted by the Permission_Pattern_Engine.
   *
   * REQ-22.5: All hooks run with Permission_Pattern_Engine constraints applied,
   * preventing hooks from executing operations that violate deny patterns.
   * Constraints are applied statically even when the engine itself is inactive.
   */
  private isCommandPermitted(command: string): boolean {
    const decision = this.permissionEngine.evaluate('Bash', command);
    // Only block on explicit deny. 'allow' and 'no-match' both permit execution.
    return decision !== 'deny';
  }

  /**
   * Execute a shell command with a timeout.
   * Returns a HookResult with exit code, stdout, stderr, and duration.
   */
  private async executeCommand(command: string, timeout?: number): Promise<HookResult> {
    const timeoutMs = timeout ?? DEFAULT_HOOK_TIMEOUT_MS;
    const start = Date.now();

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB max output
      });

      return {
        exitCode: 0,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - start;

      // exec rejects on nonzero exit or timeout
      if (error && typeof error === 'object' && 'code' in error) {
        const execError = error as {
          code: number | string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };

        // Timeout case: killed process
        if (execError.killed) {
          return {
            exitCode: 124, // conventional timeout exit code
            stdout: execError.stdout ?? '',
            stderr: execError.stderr ?? 'Hook timed out',
            durationMs,
          };
        }

        return {
          exitCode: typeof execError.code === 'number' ? execError.code : 1,
          stdout: execError.stdout ?? '',
          stderr: execError.stderr ?? '',
          durationMs,
        };
      }

      // Unknown error
      return {
        exitCode: 1,
        stdout: '',
        stderr: error instanceof Error ? error.message : 'Unknown hook execution error',
        durationMs,
      };
    }
  }
}
