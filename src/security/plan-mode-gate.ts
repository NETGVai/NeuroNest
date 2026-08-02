/**
 * Plan Mode Gate — Stage 0 of the Authorization Pipeline.
 *
 * When Plan Mode is active:
 *   - Read-only operations → pass (allow later stages to decide)
 *   - Mutations targeting the plan file → allow (auto-approve)
 *   - Mutations targeting any other path → deny (blocked before other stages)
 *
 * When Plan Mode is inactive → pass (no-op, let later stages decide).
 *
 * This gate fires BEFORE all other stages including mode-policy (which handles
 * auto-approve). This ensures that always-approve mode cannot bypass the
 * Plan Mode write restriction (Req 11.13).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.13
 */

import * as path from 'path';
import type { PlanModeGate } from './authorization-pipeline.js';
import type { ToolCall, ToolContext, RiskLevel } from '../shared/types.js';
import type { PlanModeState } from '../session/plan-mode-state.js';

/** Internal stage result type matching the authorization pipeline's contract */
type StageResult =
  | { verdict: 'deny'; reason: string }
  | { verdict: 'allow'; reason: string }
  | { verdict: 'ask'; reason: string }
  | { verdict: 'pass' };

/**
 * Tools that are inherently read-only and never mutate files.
 * These pass through Plan Mode gate regardless of arguments.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'file_read',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
  'semantic_search',
  'list_directory',
  'get_file_info',
]);

/**
 * Tools known to mutate files, along with how to extract the target path.
 * Each entry maps toolName → argument field name(s) that contain the target path.
 */
const MUTATING_TOOL_PATH_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
  ['file_write', ['path', 'filePath', 'file']],
  ['file_edit', ['path', 'filePath', 'file']],
  ['search_replace', ['path', 'filePath', 'file']],
  ['anchored_edit', ['path', 'filePath', 'file']],
  ['file_delete', ['path', 'filePath', 'file']],
  ['file_rename', ['path', 'oldPath', 'source']],
  ['file_move', ['path', 'source', 'sourcePath']],
  ['file_create', ['path', 'filePath', 'file']],
  ['fs_write', ['path', 'filePath']],
  ['str_replace', ['path', 'filePath']],
]);

/**
 * PlanModeGateImpl — concrete implementation of PlanModeGate.
 *
 * Receives a reference to the session's PlanModeState to query active status
 * and the plan file path at evaluation time.
 */
export class PlanModeGateImpl implements PlanModeGate {
  private readonly planModeState: PlanModeState;

  constructor(planModeState: PlanModeState) {
    this.planModeState = planModeState;
  }

  evaluate(call: ToolCall, ctx: ToolContext): StageResult {
    // When plan mode is not active, pass through (no-op)
    if (!this.planModeState.isActive()) {
      return { verdict: 'pass' };
    }

    // Plan mode is active — evaluate the tool call

    // Read-only tools always pass through to later stages
    if (this.isReadOnlyTool(call, ctx)) {
      return { verdict: 'pass' };
    }

    // For mutating tools, extract the target path
    const targetPath = this.extractTargetPath(call);

    // If we cannot determine the target path for a potentially mutating tool,
    // deny as a safety measure (fail closed)
    if (targetPath === null) {
      // For shell/bash commands we check differently
      if (this.isShellTool(call)) {
        // Shell commands during plan mode are denied as potentially mutating
        return {
          verdict: 'deny',
          reason: 'Plan Mode active: shell commands that may mutate files are blocked. Only the plan file may be edited.',
        };
      }

      // Unknown tool with unknown path — if it's not in the read-only set,
      // and we can't determine its target, deny for safety
      return {
        verdict: 'deny',
        reason: 'Plan Mode active: unable to determine target path for mutating tool. Only the plan file may be edited.',
      };
    }

    // Compare the target path to the plan file path
    const planFilePath = this.planModeState.getPlanFilePath();
    if (this.pathsMatch(targetPath, planFilePath)) {
      // Mutations targeting the plan file → auto-approve (Req 11.3)
      return {
        verdict: 'allow',
        reason: 'Plan Mode: edit targets the active plan file (auto-approved)',
      };
    }

    // Mutations targeting a different path → deny (Req 11.2)
    return {
      verdict: 'deny',
      reason: `Plan Mode active: mutation blocked. Target "${targetPath.replace(/\\/g, '/')}" is not the plan file "${planFilePath.replace(/\\/g, '/')}".`,
    };
  }

  /**
   * Determine if a tool call is read-only based on tool name and risk level context.
   */
  private isReadOnlyTool(call: ToolCall, _ctx: ToolContext): boolean {
    // Known read-only tools
    if (READ_ONLY_TOOL_NAMES.has(call.name)) {
      return true;
    }

    // Shell commands that are known to be read-only
    if (this.isShellTool(call) && this.isReadOnlyShellCommand(call)) {
      return true;
    }

    return false;
  }

  /**
   * Check if the tool is a shell/bash execution tool.
   */
  private isShellTool(call: ToolCall): boolean {
    return call.name === 'bash' || call.name === 'shell' || call.name === 'Bash';
  }

  /**
   * Read-only shell commands that are safe in plan mode.
   */
  private isReadOnlyShellCommand(call: ToolCall): boolean {
    const READONLY_COMMANDS = [
      'ls', 'cat', 'head', 'tail', 'wc', 'find', 'which', 'whoami',
      'pwd', 'echo', 'date', 'uname', 'env', 'printenv',
      'git status', 'git log', 'git diff', 'git branch',
      'git remote', 'git show', 'git rev-parse',
    ];

    try {
      const args = typeof call.arguments === 'string'
        ? JSON.parse(call.arguments)
        : call.arguments;
      const command = (args?.command ?? args?.cmd ?? '') as string;
      const trimmed = command.trim();

      return READONLY_COMMANDS.some(
        (safe) => trimmed === safe || trimmed.startsWith(safe + ' ')
      );
    } catch {
      return false;
    }
  }

  /**
   * Extract the target file path from a mutating tool call's arguments.
   * Returns null if path cannot be determined.
   */
  private extractTargetPath(call: ToolCall): string | null {
    const pathFields = MUTATING_TOOL_PATH_FIELDS.get(call.name);
    if (!pathFields) {
      return null;
    }

    try {
      const args = typeof call.arguments === 'string'
        ? JSON.parse(call.arguments)
        : call.arguments;

      if (!args || typeof args !== 'object') {
        return null;
      }

      for (const field of pathFields) {
        const value = (args as Record<string, unknown>)[field];
        if (typeof value === 'string' && value.trim() !== '') {
          return path.normalize(value);
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  /**
   * Compare two file paths for equality (normalized, case-sensitive on Unix).
   */
  private pathsMatch(targetPath: string, planFilePath: string): boolean {
    return path.normalize(targetPath) === path.normalize(planFilePath);
  }
}
