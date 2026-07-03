/**
 * HookSystem — Event-driven automation triggered by IDE events.
 *
 * Loads hook definitions from `.neuronest/hooks/` as JSON files,
 * evaluates glob-based file pattern matching on trigger events,
 * and executes hook actions (askAgent prompts or shell commands)
 * in the background without interrupting the user workflow.
 *
 * Records execution history in the `hook_executions` SQLite table.
 *
 * Feature-gated via `production_ux_hooks` — all methods are no-ops
 * when the flag is disabled (zero overhead).
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { matchGlob } from '../infrastructure/workspace-layer-manager.js';

// ─── Types ──────────────────────────────────────────────────────

export type HookTrigger = 'fileEdited' | 'fileCreated' | 'fileDeleted' | 'userTriggered' | 'promptSubmit';

export type HookAction =
  | { type: 'askAgent'; prompt: string }
  | { type: 'runCommand'; command: string; timeout?: number };

export interface HookDefinition {
  id: string;
  name: string;
  trigger: HookTrigger;
  action: HookAction;
  enabled: boolean;
  filePatterns?: string[];
}

export interface HookEventContext {
  filePath?: string;
  sessionId: string;
  projectDir: string;
}

export interface HookResult {
  hookId: string;
  success: boolean;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface HookExecution {
  id: string;
  hookId: string;
  triggerEvent: string;
  status: 'running' | 'success' | 'failure';
  output: string | null;
  error: string | null;
  durationMs: number | null;
  triggeredAt: string;
}

// ─── Internal Types ─────────────────────────────────────────────

interface HookExecutionRow {
  id: string;
  hook_id: string;
  trigger_event: string;
  status: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  triggered_at: string;
}

// ─── Constants ──────────────────────────────────────────────────

const HOOKS_DIR = '.neuronest/hooks';
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const VALID_TRIGGERS: HookTrigger[] = ['fileEdited', 'fileCreated', 'fileDeleted', 'userTriggered', 'promptSubmit'];

// ─── HookSystem Implementation ──────────────────────────────────

export class HookSystem {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly projectDir: string;
  private hooks: HookDefinition[] = [];

  // Prepared statements (lazily cached)
  private readonly stmtInsertExecution: Database.Statement;
  private readonly stmtUpdateExecution: Database.Statement;
  private readonly stmtGetHistory: Database.Statement;

  constructor(projectDir: string, db: Database.Database, featureGate: FeatureGateSystem) {
    this.projectDir = projectDir;
    this.db = db;
    this.featureGate = featureGate;

    // Prepare statements for efficient reuse
    this.stmtInsertExecution = this.db.prepare(`
      INSERT INTO hook_executions (id, hook_id, trigger_event, status, output, error, duration_ms)
      VALUES (@id, @hookId, @triggerEvent, @status, @output, @error, @durationMs)
    `);

    this.stmtUpdateExecution = this.db.prepare(`
      UPDATE hook_executions
      SET status = @status, output = @output, error = @error, duration_ms = @durationMs
      WHERE id = @id
    `);

    this.stmtGetHistory = this.db.prepare(`
      SELECT id, hook_id, trigger_event, status, output, error, duration_ms, triggered_at
      FROM hook_executions
      WHERE hook_id = ?
      ORDER BY triggered_at DESC
      LIMIT ?
    `);
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Load hook definitions from `.neuronest/hooks/` directory.
   *
   * Reads all `.json` files in the hooks directory, validates their structure,
   * and caches the definitions in memory.
   *
   * Returns an empty array when the feature gate is disabled or the
   * hooks directory does not exist.
   *
   * Requirement 17.1: Support hook definitions stored in `.neuronest/hooks/` as JSON.
   */
  loadHooks(): HookDefinition[] {
    if (!this.isEnabled()) return [];

    const hooksDir = path.join(this.projectDir, HOOKS_DIR);

    if (!fs.existsSync(hooksDir)) {
      this.hooks = [];
      return [];
    }

    const files = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.json'));
    const loaded: HookDefinition[] = [];

    for (const file of files) {
      try {
        const filePath = path.join(hooksDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const raw = JSON.parse(content);
        const hook = this.validateHookDefinition(raw, file);
        if (hook) {
          loaded.push(hook);
        }
      } catch {
        // Skip malformed hook files — don't break the entire system
      }
    }

    this.hooks = loaded;
    return [...loaded];
  }

  /**
   * Evaluate and fire hooks matching a trigger event.
   *
   * For file-based triggers (fileEdited, fileCreated, fileDeleted), hooks
   * only fire if the event file path matches at least one of the hook's
   * glob patterns. Non-matching paths never trigger the hook.
   *
   * Executes matching hooks in the background without blocking the caller.
   * Records execution history in the `hook_executions` table.
   *
   * Requirements: 17.2, 17.3, 17.4
   */
  async fireEvent(trigger: HookTrigger, context: HookEventContext): Promise<HookResult[]> {
    if (!this.isEnabled()) return [];

    const matchingHooks = this.hooks.filter((hook) => {
      if (!hook.enabled) return false;
      if (hook.trigger !== trigger) return false;
      return this.matchesFilePatterns(hook, context.filePath);
    });

    // Execute all matching hooks concurrently in background
    const results = await Promise.all(
      matchingHooks.map((hook) => this.executeHook(hook, trigger, context)),
    );

    return results;
  }

  /**
   * Create a new hook definition and persist to disk.
   *
   * Writes the hook definition as a JSON file in `.neuronest/hooks/`
   * and adds it to the in-memory cache.
   *
   * Requirement 17.1
   */
  createHook(definition: Omit<HookDefinition, 'id'>): HookDefinition {
    const hook: HookDefinition = {
      id: randomUUID(),
      ...definition,
    };

    // Ensure hooks directory exists
    const hooksDir = path.join(this.projectDir, HOOKS_DIR);
    fs.mkdirSync(hooksDir, { recursive: true });

    // Write hook definition to disk
    const fileName = `${hook.id}.json`;
    const filePath = path.join(hooksDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(hook, null, 2), 'utf-8');

    // Add to in-memory cache
    this.hooks.push(hook);

    return hook;
  }

  /**
   * Get execution history for a specific hook.
   *
   * Returns recent executions ordered by triggered_at descending.
   * Default limit is 20.
   *
   * Requirement 17.5: Display hook execution status.
   */
  getHistory(hookId: string, limit: number = 20): HookExecution[] {
    if (!this.isEnabled()) return [];

    const rows = this.stmtGetHistory.all(hookId, limit) as HookExecutionRow[];

    return rows.map((row) => ({
      id: row.id,
      hookId: row.hook_id,
      triggerEvent: row.trigger_event,
      status: row.status as HookExecution['status'],
      output: row.output,
      error: row.error,
      durationMs: row.duration_ms,
      triggeredAt: row.triggered_at,
    }));
  }

  /**
   * Get all loaded hook definitions.
   */
  getHooks(): HookDefinition[] {
    return [...this.hooks];
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check if the feature gate is enabled.
   */
  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_hooks');
  }

  /**
   * Validate a raw JSON object as a valid HookDefinition.
   *
   * Returns the validated hook or null if invalid.
   */
  private validateHookDefinition(raw: unknown, fileName: string): HookDefinition | null {
    if (!raw || typeof raw !== 'object') return null;

    const obj = raw as Record<string, unknown>;

    // Required fields
    if (typeof obj.name !== 'string' || obj.name.trim().length === 0) return null;
    if (!VALID_TRIGGERS.includes(obj.trigger as HookTrigger)) return null;
    if (!obj.action || typeof obj.action !== 'object') return null;

    const action = obj.action as Record<string, unknown>;
    if (action.type !== 'askAgent' && action.type !== 'runCommand') return null;

    if (action.type === 'askAgent') {
      if (typeof action.prompt !== 'string' || action.prompt.trim().length === 0) return null;
    }

    if (action.type === 'runCommand') {
      if (typeof action.command !== 'string' || action.command.trim().length === 0) return null;
      if (action.timeout !== undefined && typeof action.timeout !== 'number') return null;
    }

    // Optional fields
    const filePatterns = Array.isArray(obj.filePatterns)
      ? obj.filePatterns.filter((p): p is string => typeof p === 'string')
      : undefined;

    const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true;
    const id = typeof obj.id === 'string' && obj.id.length > 0
      ? obj.id
      : randomUUID();

    const hookAction: HookAction = action.type === 'askAgent'
      ? { type: 'askAgent', prompt: action.prompt as string }
      : { type: 'runCommand', command: action.command as string, timeout: action.timeout as number | undefined };

    return {
      id,
      name: obj.name as string,
      trigger: obj.trigger as HookTrigger,
      action: hookAction,
      enabled,
      filePatterns,
    };
  }

  /**
   * Check if a hook's file patterns match the given file path.
   *
   * For hooks without file patterns, always returns true (match all).
   * For hooks with file patterns, returns true only if the file path
   * matches at least one pattern.
   *
   * Requirement 17.2: File pattern matching using globs.
   */
  private matchesFilePatterns(hook: HookDefinition, filePath?: string): boolean {
    // Hooks without file patterns match all events
    if (!hook.filePatterns || hook.filePatterns.length === 0) {
      return true;
    }

    // File-based triggers require a file path in the context
    if (!filePath) return false;

    // Normalize the file path to be relative to the project dir for matching
    const relativePath = path.isAbsolute(filePath)
      ? path.relative(this.projectDir, filePath)
      : filePath;

    return hook.filePatterns.some((pattern) => matchGlob(pattern, relativePath));
  }

  /**
   * Execute a single hook action and record the result.
   *
   * For `askAgent` actions: returns the prompt (actual agent invocation
   * is handled by the caller/agent loop integration).
   *
   * For `runCommand` actions: executes the shell command with a timeout,
   * captures stdout/stderr, and records execution history.
   *
   * Requirements: 17.2, 17.4
   */
  private async executeHook(
    hook: HookDefinition,
    trigger: HookTrigger,
    context: HookEventContext,
  ): Promise<HookResult> {
    const executionId = randomUUID();
    const startTime = Date.now();

    // Record execution start
    this.stmtInsertExecution.run({
      id: executionId,
      hookId: hook.id,
      triggerEvent: trigger,
      status: 'running',
      output: null,
      error: null,
      durationMs: null,
    });

    try {
      let output: string | undefined;

      if (hook.action.type === 'askAgent') {
        // For askAgent, the output is the resolved prompt
        output = this.resolvePromptTemplate(hook.action.prompt, context);
      } else {
        // For runCommand, execute the shell command
        output = await this.runCommand(
          hook.action.command,
          context.projectDir,
          hook.action.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
        );
      }

      const durationMs = Date.now() - startTime;

      // Record success
      this.stmtUpdateExecution.run({
        id: executionId,
        status: 'success',
        output: output ?? null,
        error: null,
        durationMs,
      });

      return {
        hookId: hook.id,
        success: true,
        output,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Record failure
      this.stmtUpdateExecution.run({
        id: executionId,
        status: 'failure',
        output: null,
        error: errorMessage,
        durationMs,
      });

      return {
        hookId: hook.id,
        success: false,
        error: errorMessage,
        durationMs,
      };
    }
  }

  /**
   * Execute a shell command with timeout.
   *
   * Returns the command's stdout on success.
   * Throws on non-zero exit code, timeout, or execution error.
   */
  private runCommand(command: string, cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = exec(
        command,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024, // 1MB output buffer
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          if (error) {
            // Include stderr in the error message for context
            const msg = stderr
              ? `${error.message}\n${stderr}`
              : error.message;
            reject(new Error(msg));
          } else {
            resolve(stdout.trim());
          }
        },
      );

      // Safety: ensure the child process is cleaned up if parent is interrupted
      child.unref?.();
    });
  }

  /**
   * Resolve template variables in a hook prompt.
   *
   * Supports: {{filePath}}, {{projectDir}}, {{sessionId}}
   */
  private resolvePromptTemplate(prompt: string, context: HookEventContext): string {
    return prompt
      .replace(/\{\{filePath\}\}/g, context.filePath ?? '')
      .replace(/\{\{projectDir\}\}/g, context.projectDir)
      .replace(/\{\{sessionId\}\}/g, context.sessionId);
  }
}
