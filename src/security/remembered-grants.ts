/**
 * Remembered Grants Service — persisted per-project authorization decisions.
 *
 * Implements the `RememberedGrantsLookup` interface from the AuthorizationPipeline.
 * Grants are keyed by (projectId, toolId, normalizedArgPrefix) and persisted in SQLite.
 *
 * Dangerous commands (recursive deletion, force push, credential writes, package publishing)
 * ALWAYS require approval regardless of any stored grant (Req 10.7).
 *
 * Requirements: 10.6, 10.7
 */

import type Database from 'better-sqlite3';
import type { ToolCall, ToolContext } from '../shared/types.js';
import type { RememberedGrantsLookup } from './authorization-pipeline.js';

// ─── Public Types ───────────────────────────────────────────────

export type GrantDecision = 'allow' | 'deny';

export interface RememberedGrant {
  projectId: string;
  toolId: string;
  argPrefix: string;
  decision: GrantDecision;
  createdAt: string;
}

/** Internal stage result matching the authorization pipeline contract */
type StageResult =
  | { verdict: 'deny'; reason: string }
  | { verdict: 'allow'; reason: string }
  | { verdict: 'ask'; reason: string }
  | { verdict: 'pass' };

// ─── Dangerous Command Patterns ─────────────────────────────────

/**
 * Built-in patterns for commands that ALWAYS require approval regardless of grants.
 * These are checked in-memory for fast evaluation. The SQLite table serves as
 * the persistent, user-extensible store.
 */
const BUILTIN_DANGEROUS_PATTERNS: ReadonlyArray<{
  pattern: string;
  category: string;
}> = [
  // Recursive deletion
  { pattern: 'rm -rf', category: 'recursive-deletion' },
  { pattern: 'rm -r', category: 'recursive-deletion' },
  { pattern: 'rimraf', category: 'recursive-deletion' },
  // Force push
  { pattern: 'git push --force', category: 'force-push' },
  { pattern: 'git push -f', category: 'force-push' },
  { pattern: 'git push --force-with-lease', category: 'force-push' },
  // Package publishing
  { pattern: 'npm publish', category: 'package-publishing' },
  { pattern: 'yarn publish', category: 'package-publishing' },
  { pattern: 'pnpm publish', category: 'package-publishing' },
  // Credential writes
  { pattern: '.env', category: 'credential-write' },
  { pattern: '.pem', category: 'credential-write' },
  { pattern: '.key', category: 'credential-write' },
  { pattern: 'credentials', category: 'credential-write' },
  { pattern: '.ssh/', category: 'credential-write' },
];

// ─── Argument Normalization ─────────────────────────────────────

/**
 * Normalize tool arguments into a canonical prefix string for grant matching.
 *
 * For shell/bash tools, extracts the command string.
 * For file tools, extracts the path.
 * For other tools, returns a JSON-serialized sorted-key representation.
 */
export function normalizeArgPrefix(toolName: string, args: unknown): string {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;

    // Shell tools: use the command
    if (toolName === 'bash' || toolName === 'shell' || toolName === 'Bash') {
      const command = (parsed?.command ?? parsed?.cmd ?? '') as string;
      return command.trim();
    }

    // File tools: use the path
    if (
      toolName === 'file_write' ||
      toolName === 'file_read' ||
      toolName === 'file_edit' ||
      toolName === 'anchored_edit'
    ) {
      const filePath = (parsed?.path ?? parsed?.file ?? '') as string;
      return filePath.trim();
    }

    // Generic: stable JSON of top-level keys
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed).sort();
      const normalized: Record<string, unknown> = {};
      for (const key of keys) {
        normalized[key] = parsed[key];
      }
      return JSON.stringify(normalized);
    }

    return String(args ?? '');
  } catch {
    return typeof args === 'string' ? args : '';
  }
}

// ─── Remembered Grants Service ──────────────────────────────────

export class RememberedGrantsService implements RememberedGrantsLookup {
  private readonly db: Database.Database | null;
  private readonly dangerousPatterns: Array<{ pattern: string; category: string }>;

  constructor(db?: Database.Database) {
    this.db = db ?? null;
    this.dangerousPatterns = [...BUILTIN_DANGEROUS_PATTERNS];

    // Load additional dangerous patterns from DB if available
    if (this.db) {
      try {
        const rows = this.db
          .prepare('SELECT pattern, category FROM dangerous_commands')
          .all() as Array<{ pattern: string; category: string }>;

        // Merge with builtins (dedup by pattern)
        const existingPatterns = new Set(this.dangerousPatterns.map((p) => p.pattern));
        for (const row of rows) {
          if (!existingPatterns.has(row.pattern)) {
            this.dangerousPatterns.push(row);
            existingPatterns.add(row.pattern);
          }
        }
      } catch {
        // Table might not exist yet; continue with builtins only
      }
    }
  }

  // ─── RememberedGrantsLookup Interface ───────────────────────

  /**
   * Evaluate a tool call against stored grants.
   * Returns 'allow' or 'deny' if a matching grant exists and the command is NOT dangerous.
   * Returns 'pass' if no grant matches or the command is dangerous (forces later stages to decide).
   */
  evaluate(call: ToolCall, ctx: ToolContext): StageResult {
    const projectId = ctx.projectDir ?? '';
    if (!projectId) {
      return { verdict: 'pass' };
    }

    const argPrefix = normalizeArgPrefix(call.name, call.arguments);

    // Check if the command is dangerous — always pass through to force a prompt (Req 10.7)
    if (this.isDangerous(call.name, call.arguments)) {
      return { verdict: 'pass' };
    }

    // Look up stored grant
    const grant = this.lookup(projectId, call.name, argPrefix);
    if (!grant) {
      return { verdict: 'pass' };
    }

    if (grant.decision === 'allow') {
      return { verdict: 'allow', reason: `Remembered grant: allowed for ${call.name}` };
    }

    if (grant.decision === 'deny') {
      return { verdict: 'deny', reason: `Remembered grant: denied for ${call.name}` };
    }

    return { verdict: 'pass' };
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Store a grant decision for a project+tool+argPrefix combination.
   */
  remember(projectId: string, toolId: string, argPrefix: string, decision: GrantDecision): void {
    if (!this.db) return;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO remembered_grants (project_id, tool_id, arg_prefix, decision, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run(projectId, toolId, argPrefix, decision);
  }

  /**
   * Look up a stored grant matching the given project, tool, and argument prefix.
   * Uses prefix matching: a stored grant for 'rm' matches a call with prefix 'rm file.txt'.
   */
  lookup(projectId: string, toolId: string, argPrefix: string): RememberedGrant | null {
    if (!this.db) return null;

    // Try exact match first
    const exact = this.db
      .prepare(
        `SELECT project_id, tool_id, arg_prefix, decision, created_at
         FROM remembered_grants
         WHERE project_id = ? AND tool_id = ? AND arg_prefix = ?`,
      )
      .get(projectId, toolId, argPrefix) as RememberedGrant | undefined;

    if (exact) {
      return {
        projectId: exact.projectId ?? (exact as any).project_id,
        toolId: exact.toolId ?? (exact as any).tool_id,
        argPrefix: exact.argPrefix ?? (exact as any).arg_prefix,
        decision: exact.decision as GrantDecision,
        createdAt: exact.createdAt ?? (exact as any).created_at,
      };
    }

    // Try prefix match: find grants where the stored arg_prefix is a prefix of the requested one
    const prefixMatches = this.db
      .prepare(
        `SELECT project_id, tool_id, arg_prefix, decision, created_at
         FROM remembered_grants
         WHERE project_id = ? AND tool_id = ? AND arg_prefix != ''
           AND ? LIKE (arg_prefix || '%')
         ORDER BY LENGTH(arg_prefix) DESC
         LIMIT 1`,
      )
      .get(projectId, toolId, argPrefix) as any | undefined;

    if (prefixMatches) {
      return {
        projectId: prefixMatches.project_id,
        toolId: prefixMatches.tool_id,
        argPrefix: prefixMatches.arg_prefix,
        decision: prefixMatches.decision as GrantDecision,
        createdAt: prefixMatches.created_at,
      };
    }

    // Try matching on tool-only grant (empty arg_prefix means "any args for this tool")
    const toolOnlyGrant = this.db
      .prepare(
        `SELECT project_id, tool_id, arg_prefix, decision, created_at
         FROM remembered_grants
         WHERE project_id = ? AND tool_id = ? AND arg_prefix = ''`,
      )
      .get(projectId, toolId) as any | undefined;

    if (toolOnlyGrant) {
      return {
        projectId: toolOnlyGrant.project_id,
        toolId: toolOnlyGrant.tool_id,
        argPrefix: toolOnlyGrant.arg_prefix,
        decision: toolOnlyGrant.decision as GrantDecision,
        createdAt: toolOnlyGrant.created_at,
      };
    }

    return null;
  }

  /**
   * Revoke grants for a project. Optionally filter by toolId and/or argPrefix.
   */
  revoke(projectId: string, toolId?: string, argPrefix?: string): number {
    if (!this.db) return 0;

    if (toolId && argPrefix !== undefined) {
      const result = this.db
        .prepare(
          'DELETE FROM remembered_grants WHERE project_id = ? AND tool_id = ? AND arg_prefix = ?',
        )
        .run(projectId, toolId, argPrefix);
      return result.changes;
    }

    if (toolId) {
      const result = this.db
        .prepare('DELETE FROM remembered_grants WHERE project_id = ? AND tool_id = ?')
        .run(projectId, toolId);
      return result.changes;
    }

    const result = this.db
      .prepare('DELETE FROM remembered_grants WHERE project_id = ?')
      .run(projectId);
    return result.changes;
  }

  /**
   * Check if a tool call targets a dangerous command that must always prompt.
   *
   * Dangerous commands include:
   * - Recursive deletion (rm -rf, rm -r, rimraf)
   * - Force push (git push --force, git push -f)
   * - Package publishing (npm publish, yarn publish)
   * - Credential writes (.env, .pem, .key, credentials, .ssh/)
   */
  isDangerous(toolId: string, args: unknown): boolean {
    const argPrefix = normalizeArgPrefix(toolId, args);
    const lowerPrefix = argPrefix.toLowerCase();

    for (const { pattern } of this.dangerousPatterns) {
      const lowerPattern = pattern.toLowerCase();

      // Check if the argument prefix contains the dangerous pattern
      if (lowerPrefix.includes(lowerPattern)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get all grants for a project.
   */
  listGrants(projectId: string): RememberedGrant[] {
    if (!this.db) return [];

    const rows = this.db
      .prepare(
        'SELECT project_id, tool_id, arg_prefix, decision, created_at FROM remembered_grants WHERE project_id = ?',
      )
      .all(projectId) as any[];

    return rows.map((row) => ({
      projectId: row.project_id,
      toolId: row.tool_id,
      argPrefix: row.arg_prefix,
      decision: row.decision as GrantDecision,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get all dangerous command patterns.
   */
  getDangerousPatterns(): Array<{ pattern: string; category: string }> {
    return [...this.dangerousPatterns];
  }

  /**
   * Add a custom dangerous command pattern (persists to DB if available).
   */
  addDangerousPattern(pattern: string, category: string): void {
    // Add to in-memory list
    const existing = this.dangerousPatterns.find((p) => p.pattern === pattern);
    if (!existing) {
      this.dangerousPatterns.push({ pattern, category });
    }

    // Persist to DB
    if (this.db) {
      this.db
        .prepare('INSERT OR IGNORE INTO dangerous_commands (pattern, category) VALUES (?, ?)')
        .run(pattern, category);
    }
  }
}
