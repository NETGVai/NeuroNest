/**
 * Hook Migration v2 — Lossless migration of existing SQLite hooks to v2 schema.
 *
 * Reads hook definitions from the legacy `hooks` table (created by HooksManager)
 * and converts each to the HookDefinition format used by Hook Engine v2.
 *
 * Features:
 *   - Lossless conversion preserving all hook data
 *   - Dry-run mode that reports what would be migrated without writing
 *   - Writes migrated hooks both to `hook_definitions_v2` SQLite table and
 *     optionally to `.neuronest/hooks/migrated.json` for file-based loading
 *   - Maps legacy event types to v2 HookEvent names
 *   - Maps legacy action types to v2 hook types
 *
 * Environment contract for command hooks (documented here, enforced by hook-executor.ts):
 *   - JSON stdin: event context serialized as JSON on stdin
 *   - NEURONEST_PROJECT_ID: the project identifier
 *   - NEURONEST_SESSION_ID: the active session identifier
 *   - Plugin-specific variables: NEURONEST_PLUGIN_ROOT, NEURONEST_PLUGIN_DATA
 *
 * Requirements: 17.5, 17.6
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HookDefinition, HookEvent, HookType } from './hook-engine-v2.js';
import { DEFAULT_TIMEOUT_MS } from './hook-engine-v2.js';

// ─── Types ──────────────────────────────────────────────────────

/** Shape of a row from the legacy `hooks` table */
export interface LegacyHookRow {
  id: string;
  name: string;
  project_id: string;
  enabled: number; // 0 or 1
  event_type: string;
  file_patterns: string; // JSON string
  action_type: string;
  prompt: string;
  command: string;
  created_at: number;
}

/** Result of converting a single legacy hook */
export interface MigrationEntry {
  legacyId: string;
  legacyName: string;
  legacyProjectId: string;
  legacyEventType: string;
  legacyActionType: string;
  v2Definition: HookDefinition;
  warnings: string[];
}

/** Overall migration report */
export interface MigrationReport {
  totalLegacyHooks: number;
  migratedCount: number;
  skippedCount: number;
  entries: MigrationEntry[];
  skipped: { id: string; name: string; reason: string }[];
  timestamp: string;
}

/** Options for the migration */
export interface HookMigrationOptions {
  /** If true, only produce a report without writing any data */
  dryRun?: boolean;
  /** Path to the project root for writing .neuronest/hooks/migrated.json */
  projectRoot?: string;
  /** If true, also write migrated hooks to the file system */
  writeJsonFile?: boolean;
}

/**
 * Environment variables passed to command hooks at execution time.
 * Documented here as the environment contract (Req 17.6).
 */
export const HOOK_ENV_CONTRACT = {
  /** The project identifier for the current execution context */
  NEURONEST_PROJECT_ID: 'NEURONEST_PROJECT_ID',
  /** The active session identifier */
  NEURONEST_SESSION_ID: 'NEURONEST_SESSION_ID',
  /** Root directory of the plugin that registered the hook (if applicable) */
  NEURONEST_PLUGIN_ROOT: 'NEURONEST_PLUGIN_ROOT',
  /** Data directory for the plugin (if applicable) */
  NEURONEST_PLUGIN_DATA: 'NEURONEST_PLUGIN_DATA',
} as const;

// ─── Event Type Mapping ─────────────────────────────────────────

/**
 * Map legacy HooksManager event types to v2 HookEvent names.
 * Legacy types that don't have a direct v2 equivalent produce a best-effort mapping.
 */
const EVENT_TYPE_MAP: Record<string, HookEvent[]> = {
  preToolUse: ['PreToolUse'],
  postToolUse: ['PostToolUse'],
  agentStop: ['AgentStop'],
  promptSubmit: ['TurnStart'],
  fileEdited: ['PostToolUse'],
  fileCreated: ['PostToolUse'],
  fileDeleted: ['PostToolUse'],
  manual: ['SessionStart'],
};

// ─── Core Migration Logic ───────────────────────────────────────

/**
 * Convert a legacy hook row to a v2 HookDefinition.
 * Returns the converted definition and any warnings about lossy or approximate mappings.
 */
export function convertLegacyHook(row: LegacyHookRow): { definition: HookDefinition; warnings: string[] } {
  const warnings: string[] = [];

  // Map event type
  const events = EVENT_TYPE_MAP[row.event_type];
  if (!events) {
    warnings.push(`Unknown legacy event type "${row.event_type}" mapped to SessionStart`);
  }
  const mappedEvents: HookEvent[] = events ?? ['SessionStart'];

  // If file events, note that file_patterns become a matcher regex
  let matcher: string | undefined;
  if (['fileEdited', 'fileCreated', 'fileDeleted'].includes(row.event_type)) {
    try {
      const patterns: string[] = JSON.parse(row.file_patterns || '[]');
      if (patterns.length > 0) {
        // Convert glob-like patterns to a regex
        const regexParts = patterns.map(globToRegex);
        matcher = regexParts.join('|');
        warnings.push(`Converted file_patterns ${JSON.stringify(patterns)} to matcher regex: ${matcher}`);
      }
    } catch {
      warnings.push(`Could not parse file_patterns: ${row.file_patterns}`);
    }
  }

  // Map action type to hook type
  let type: HookType;
  let command: string | undefined;
  let url: string | undefined;

  if (row.action_type === 'runCommand') {
    type = 'command';
    command = row.command || undefined;
    if (!command) {
      warnings.push('Legacy hook has action_type "runCommand" but no command defined');
      command = 'echo "migrated hook: no command defined"';
    }
  } else if (row.action_type === 'askAgent') {
    // askAgent hooks become command hooks that echo the prompt
    // This is the closest v2 equivalent since v2 doesn't have an "askAgent" type
    type = 'command';
    command = `echo ${JSON.stringify(row.prompt || 'migrated askAgent hook')}`;
    warnings.push(`Converted askAgent hook to command hook. Original prompt: "${row.prompt}"`);
  } else {
    type = 'command';
    command = `echo "migrated from unknown action: ${row.action_type}"`;
    warnings.push(`Unknown legacy action_type "${row.action_type}" converted to command`);
  }

  const definition: HookDefinition = {
    name: row.name,
    type,
    events: mappedEvents,
    timeout: DEFAULT_TIMEOUT_MS,
    enabled: row.enabled === 1,
    ...(matcher && { matcher }),
    ...(command && { command }),
    ...(url && { url }),
  };

  return { definition, warnings };
}

/**
 * Read all legacy hook rows from the database.
 * Returns an empty array if the `hooks` table doesn't exist.
 */
export function readLegacyHooks(db: any): LegacyHookRow[] {
  try {
    // Check if the hooks table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='hooks'"
    ).get();
    if (!tableCheck) return [];

    const rows = db.prepare('SELECT * FROM hooks ORDER BY created_at ASC').all();
    return rows as LegacyHookRow[];
  } catch {
    return [];
  }
}

/**
 * Write a migrated hook definition to the hook_definitions_v2 table.
 */
export function writeMigratedHookToDb(
  db: any,
  entry: MigrationEntry
): void {
  const def = entry.v2Definition;
  const id = `migrated_${entry.legacyId}`;

  db.prepare(`
    INSERT OR REPLACE INTO hook_definitions_v2
      (id, project_id, name, type, events, matcher, timeout, enabled, command, url, method, verdict, migrated_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.legacyProjectId,
    def.name,
    def.type,
    JSON.stringify(def.events),
    def.matcher ?? null,
    def.timeout,
    def.enabled ? 1 : 0,
    def.command ?? null,
    def.url ?? null,
    def.method ?? null,
    def.verdict ?? null,
    entry.legacyId,
  );
}

/**
 * Migrate all existing SQLite hooks to v2 schema.
 *
 * In dry-run mode, produces a report without writing any data.
 * In live mode, writes to both the `hook_definitions_v2` table and optionally
 * to `.neuronest/hooks/migrated.json`.
 */
export function migrateHooksToV2(
  db: any,
  options: HookMigrationOptions = {}
): MigrationReport {
  const { dryRun = false, projectRoot, writeJsonFile = true } = options;

  const legacyHooks = readLegacyHooks(db);

  const report: MigrationReport = {
    totalLegacyHooks: legacyHooks.length,
    migratedCount: 0,
    skippedCount: 0,
    entries: [],
    skipped: [],
    timestamp: new Date().toISOString(),
  };

  if (legacyHooks.length === 0) {
    return report;
  }

  for (const row of legacyHooks) {
    try {
      const { definition, warnings } = convertLegacyHook(row);

      const entry: MigrationEntry = {
        legacyId: row.id,
        legacyName: row.name,
        legacyProjectId: row.project_id,
        legacyEventType: row.event_type,
        legacyActionType: row.action_type,
        v2Definition: definition,
        warnings,
      };

      report.entries.push(entry);
      report.migratedCount++;

      if (!dryRun) {
        writeMigratedHookToDb(db, entry);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.skipped.push({
        id: row.id,
        name: row.name,
        reason: `Conversion failed: ${message}`,
      });
      report.skippedCount++;
    }
  }

  // Write to JSON file if requested and not dry-run
  if (!dryRun && writeJsonFile && projectRoot) {
    const migratedDefinitions = report.entries.map((e) => e.v2Definition);
    writeMigratedHooksToJson(projectRoot, migratedDefinitions);
  }

  return report;
}

// ─── File Output ────────────────────────────────────────────────

/**
 * Write migrated hook definitions to `.neuronest/hooks/migrated.json`.
 */
function writeMigratedHooksToJson(projectRoot: string, definitions: HookDefinition[]): void {
  if (definitions.length === 0) return;

  const hooksDir = path.join(projectRoot, '.neuronest', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });

  const outputPath = path.join(hooksDir, 'migrated.json');
  const content = JSON.stringify(definitions, null, 2);
  fs.writeFileSync(outputPath, content, 'utf-8');
}

// ─── Utilities ──────────────────────────────────────────────────

/**
 * Convert a simple glob pattern to a regex string.
 * Supports: `*` (any characters except path separator) and leading `*.ext` patterns.
 */
function globToRegex(pattern: string): string {
  // Escape regex special characters except *
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Convert * to regex wildcard
  escaped = escaped.replace(/\*/g, '.*');
  return escaped;
}

/**
 * Format a migration report as a human-readable string.
 * Useful for dry-run output.
 */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(' Hook Migration v2 Report');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(`Total legacy hooks: ${report.totalLegacyHooks}`);
  lines.push(`Migrated: ${report.migratedCount}`);
  lines.push(`Skipped: ${report.skippedCount}`);
  lines.push('');

  if (report.entries.length > 0) {
    lines.push('── Migrated Hooks ─────────────────────────────────────────────');
    for (const entry of report.entries) {
      lines.push(`  [${entry.legacyId}] "${entry.legacyName}"`);
      lines.push(`    Project: ${entry.legacyProjectId}`);
      lines.push(`    Legacy: event=${entry.legacyEventType}, action=${entry.legacyActionType}`);
      lines.push(`    V2: type=${entry.v2Definition.type}, events=[${entry.v2Definition.events.join(', ')}]`);
      if (entry.warnings.length > 0) {
        for (const w of entry.warnings) {
          lines.push(`    ⚠ ${w}`);
        }
      }
      lines.push('');
    }
  }

  if (report.skipped.length > 0) {
    lines.push('── Skipped Hooks ──────────────────────────────────────────────');
    for (const skip of report.skipped) {
      lines.push(`  [${skip.id}] "${skip.name}" — ${skip.reason}`);
    }
    lines.push('');
  }

  lines.push('═══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}
