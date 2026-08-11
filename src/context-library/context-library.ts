/**
 * Context Library — Curated organizational knowledge injection into agent prompts.
 *
 * Stores context entries scoped to workspace, project, or session. Resolves
 * relevant entries at prompt time with priority-based trimming and token budget
 * enforcement. Integrates with PromptEnrichmentPipeline for automatic injection.
 *
 * Key behaviors:
 *   - Token budget: default 2000 tokens maximum
 *   - Priority-based trimming: highest priority entries retained first
 *   - Scope precedence: session > project > workspace (session overrides project)
 *   - Token counting uses estimateTokens() (chars/4 approximation)
 *   - Entries stored in `context_entries` SQLite table
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import type Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';
import { estimateTokens } from '../infrastructure/token-estimator.js';
import { createSubsystemError } from '../types/subsystem-error.js';
import type {
  ContextEntry,
  ContextLibrary as IContextLibrary,
  ContextLibraryConfig,
  SessionResolveParams,
  ResolvedContext,
  CapturedConvention,
} from '../types/cloudflare-os.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default maximum token budget for injected context. */
const DEFAULT_MAX_TOKEN_BUDGET = 2000;

/** Default scope precedence: session overrides project overrides workspace. */
const DEFAULT_SCOPE_PRECEDENCE: ('session' | 'project' | 'workspace')[] = [
  'session',
  'project',
  'workspace',
];

// ─── Database Row Type ──────────────────────────────────────────

interface ContextEntryRow {
  id: string;
  name: string;
  scope: string;
  scope_id: string;
  content: string;
  tags: string | null;
  priority: number;
  token_count: number;
  created_at: string;
  updated_at: string;
}

// ─── Context Library Implementation ─────────────────────────────

export class ContextLibraryImpl implements IContextLibrary {
  private readonly db: Database.Database;
  private readonly config: ContextLibraryConfig;

  // Prepared statements
  private readonly stmtInsert: Database.Statement;
  private readonly stmtUpdate: Database.Statement;
  private readonly stmtDelete: Database.Statement;
  private readonly stmtGetByScope: Database.Statement;
  private readonly stmtGetById: Database.Statement;
  private readonly stmtGetByMultipleScopes: Database.Statement;

  constructor(db: Database.Database, config?: Partial<ContextLibraryConfig>) {
    this.db = db;
    this.config = {
      maxTokenBudget: config?.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET,
      scopePrecedence: config?.scopePrecedence ?? DEFAULT_SCOPE_PRECEDENCE,
    };

    // Prepare SQL statements
    this.stmtInsert = this.db.prepare(`
      INSERT INTO context_entries (id, name, scope, scope_id, content, tags, priority, token_count, created_at, updated_at)
      VALUES (@id, @name, @scope, @scope_id, @content, @tags, @priority, @token_count, @created_at, @updated_at)
    `);

    this.stmtUpdate = this.db.prepare(`
      UPDATE context_entries
      SET name = COALESCE(@name, name),
          scope = COALESCE(@scope, scope),
          scope_id = COALESCE(@scope_id, scope_id),
          content = COALESCE(@content, content),
          tags = COALESCE(@tags, tags),
          priority = COALESCE(@priority, priority),
          token_count = COALESCE(@token_count, token_count),
          updated_at = @updated_at
      WHERE id = @id
    `);

    this.stmtDelete = this.db.prepare(`
      DELETE FROM context_entries WHERE id = ?
    `);

    this.stmtGetByScope = this.db.prepare(`
      SELECT * FROM context_entries WHERE scope = ? AND scope_id = ? ORDER BY priority DESC
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT * FROM context_entries WHERE id = ?
    `);

    // For resolveContext: fetch entries for multiple scope/scopeId pairs
    // We'll compose this dynamically since SQLite doesn't support tuple IN easily
    this.stmtGetByMultipleScopes = this.db.prepare(`
      SELECT * FROM context_entries
      WHERE (scope = ? AND scope_id = ?)
         OR (scope = ? AND scope_id = ?)
         OR (scope = ? AND scope_id = ?)
      ORDER BY priority DESC
    `);
  }

  /**
   * Add a new context entry. Computes token count automatically.
   */
  addEntry(
    entry: Omit<ContextEntry, 'id' | 'createdAt' | 'updatedAt' | 'tokenCount'>
  ): ContextEntry {
    const id = uuidv7();
    const now = new Date().toISOString();
    const tokenCount = estimateTokens(entry.content);

    const fullEntry: ContextEntry = {
      ...entry,
      id,
      tokenCount,
      createdAt: now,
      updatedAt: now,
    };

    this.stmtInsert.run({
      id: fullEntry.id,
      name: fullEntry.name,
      scope: fullEntry.scope,
      scope_id: fullEntry.scopeId,
      content: fullEntry.content,
      tags: JSON.stringify(fullEntry.tags),
      priority: fullEntry.priority,
      token_count: fullEntry.tokenCount,
      created_at: fullEntry.createdAt,
      updated_at: fullEntry.updatedAt,
    });

    return fullEntry;
  }

  /**
   * Update an existing context entry. Recomputes token count if content changes.
   */
  updateEntry(id: string, patch: Partial<ContextEntry>): ContextEntry {
    const existing = this.stmtGetById.get(id) as ContextEntryRow | undefined;
    if (!existing) {
      throw createSubsystemError(
        'context_library',
        'CONTEXT_ENTRY_NOT_FOUND',
        `Context entry with id '${id}' not found`,
        { details: { id }, recoverable: true, suggestedAction: 'verify_entry_id' }
      );
    }

    const now = new Date().toISOString();

    // If content is changing, recompute token count
    const newContent = patch.content ?? existing.content;
    const newTokenCount = patch.content !== undefined
      ? estimateTokens(patch.content)
      : existing.token_count;

    this.stmtUpdate.run({
      id,
      name: patch.name ?? null,
      scope: patch.scope ?? null,
      scope_id: patch.scopeId ?? null,
      content: patch.content ?? null,
      tags: patch.tags !== undefined ? JSON.stringify(patch.tags) : null,
      priority: patch.priority ?? null,
      token_count: patch.content !== undefined ? newTokenCount : null,
      updated_at: now,
    });

    // Return the updated entry
    const updated = this.stmtGetById.get(id) as ContextEntryRow;
    return this.rowToEntry(updated);
  }

  /**
   * Remove a context entry by ID.
   */
  removeEntry(id: string): void {
    const result = this.stmtDelete.run(id);
    if (result.changes === 0) {
      throw createSubsystemError(
        'context_library',
        'CONTEXT_ENTRY_NOT_FOUND',
        `Context entry with id '${id}' not found`,
        { details: { id }, recoverable: true, suggestedAction: 'verify_entry_id' }
      );
    }
  }

  /**
   * Get all entries for a given scope and scopeId, ordered by priority descending.
   */
  getEntries(scope: string, scopeId: string): ContextEntry[] {
    const rows = this.stmtGetByScope.all(scope, scopeId) as ContextEntryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Resolve context for a session. Collects entries from all matching scopes,
   * applies scope override precedence, trims by priority within the token budget.
   *
   * Scope override: If entries share the same name, session overrides project,
   * project overrides workspace.
   *
   * Priority trimming: When total tokens exceed the budget, retain highest
   * priority entries first.
   */
  resolveContext(sessionContext: SessionResolveParams): ResolvedContext {
    // Fetch entries from all three scopes
    const rows = this.stmtGetByMultipleScopes.all(
      'workspace', sessionContext.workspacePath,
      'project', sessionContext.projectId,
      'session', sessionContext.sessionId,
    ) as ContextEntryRow[];

    const allEntries = rows.map((row) => this.rowToEntry(row));

    // Apply scope override precedence: session > project > workspace
    const deduplicatedEntries = this.applyScopeOverrides(allEntries);

    // Apply priority-based trimming within token budget
    const { entries: trimmedEntries, totalTokens, truncated } =
      this.applyTokenBudget(deduplicatedEntries, this.config.maxTokenBudget);

    // Build injected text
    const injectedText = this.buildInjectedText(trimmedEntries);

    return {
      entries: trimmedEntries,
      totalTokens,
      truncated,
      injectedText,
    };
  }

  /**
   * Suggest capturing a convention from agent output.
   * Compares agent output against known conventions; if a novel useful pattern
   * is detected, returns a CapturedConvention suggestion.
   */
  suggestCapture(agentOutput: string, conventions: string[]): CapturedConvention | null {
    // Simple heuristic: look for patterns in agent output that mention conventions
    // or coding standards not already captured
    if (!agentOutput || conventions.length === 0) {
      return null;
    }

    // Look for common convention indicators in the output
    const conventionIndicators = [
      'always use',
      'convention:',
      'best practice:',
      'standard:',
      'pattern:',
      'rule:',
      'prefer',
      'should always',
      'naming convention',
    ];

    const lowerOutput = agentOutput.toLowerCase();
    const matchedIndicator = conventionIndicators.find((indicator) =>
      lowerOutput.includes(indicator)
    );

    if (!matchedIndicator) {
      return null;
    }

    // Extract the sentence containing the convention indicator
    const sentences = agentOutput.split(/[.!?\n]+/);
    const relevantSentence = sentences.find((s) =>
      s.toLowerCase().includes(matchedIndicator)
    );

    if (!relevantSentence) {
      return null;
    }

    const trimmedContent = relevantSentence.trim();

    // Check if this convention is already known
    const isAlreadyCaptured = conventions.some((conv) =>
      conv.toLowerCase().includes(trimmedContent.toLowerCase()) ||
      trimmedContent.toLowerCase().includes(conv.toLowerCase())
    );

    if (isAlreadyCaptured) {
      return null;
    }

    return {
      name: `Convention: ${trimmedContent.slice(0, 50)}`,
      content: trimmedContent,
      scope: 'project',
      tags: ['convention', 'auto-captured'],
    };
  }

  /**
   * Preview what the injected context text would look like for a session
   * without actually modifying any state.
   */
  previewInjection(sessionContext: SessionResolveParams): string {
    const resolved = this.resolveContext(sessionContext);
    return resolved.injectedText;
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  /**
   * Apply scope override precedence. When entries share the same name,
   * the entry from the higher-precedence scope wins.
   * Precedence: session > project > workspace.
   */
  private applyScopeOverrides(entries: ContextEntry[]): ContextEntry[] {
    const scopeRank: Record<string, number> = {
      session: 3,
      project: 2,
      workspace: 1,
    };

    // Group by name, keep the highest-precedence entry for each name
    const byName = new Map<string, ContextEntry>();

    for (const entry of entries) {
      const existing = byName.get(entry.name);
      if (!existing) {
        byName.set(entry.name, entry);
      } else {
        const existingRank = scopeRank[existing.scope] ?? 0;
        const newRank = scopeRank[entry.scope] ?? 0;
        if (newRank > existingRank) {
          byName.set(entry.name, entry);
        }
      }
    }

    return [...byName.values()];
  }

  /**
   * Apply token budget enforcement. Retains entries with highest priority first.
   * Returns the subset of entries that fit within the budget.
   */
  private applyTokenBudget(
    entries: ContextEntry[],
    maxTokens: number
  ): { entries: ContextEntry[]; totalTokens: number; truncated: boolean } {
    // Sort by priority descending (highest priority first)
    const sorted = [...entries].sort((a, b) => b.priority - a.priority);

    const retained: ContextEntry[] = [];
    let totalTokens = 0;
    let truncated = false;

    for (const entry of sorted) {
      if (totalTokens + entry.tokenCount <= maxTokens) {
        retained.push(entry);
        totalTokens += entry.tokenCount;
      } else {
        truncated = true;
      }
    }

    return { entries: retained, totalTokens, truncated };
  }

  /**
   * Build the injected text from resolved entries.
   * Formats entries as labeled sections ready for prompt injection.
   */
  private buildInjectedText(entries: ContextEntry[]): string {
    if (entries.length === 0) {
      return '';
    }

    const parts: string[] = [];
    parts.push('--- Context Library ---');

    for (const entry of entries) {
      parts.push(`[${entry.scope}/${entry.name}]`);
      parts.push(entry.content);
      parts.push('');
    }

    parts.push('--- End Context Library ---');
    return parts.join('\n');
  }

  /**
   * Convert a database row to a ContextEntry.
   */
  private rowToEntry(row: ContextEntryRow): ContextEntry {
    return {
      id: row.id,
      name: row.name,
      scope: row.scope as 'workspace' | 'project' | 'session',
      scopeId: row.scope_id,
      content: row.content,
      tags: row.tags ? JSON.parse(row.tags) : [],
      priority: row.priority,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
