/**
 * TriggerGatedKnowledge — Conditional knowledge injection for prompt assembly.
 *
 * Manages project-memory entries, skill snippets, and `.neuronest/microagents/*.md`
 * files with trigger-based inclusion logic. At prompt-assembly time, entries are
 * included only if a trigger keyword matches the current task or turn text, or
 * the entry is marked as `alwaysInclude`.
 *
 * When the `trigger_gated_knowledge` feature flag is disabled, ALL entries are
 * included unconditionally (preserving pre-feature behavior).
 *
 * Existing project-memory entries and skill snippets default to `alwaysInclude: true`
 * during migration, ensuring no data loss.
 *
 * Supports `.neuronest/microagents/*.md` files with YAML frontmatter containing
 * `triggers` array and markdown body content.
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface TriggerableEntry {
  id: string;
  content: string;
  triggers: string[];  // keywords; empty = 'always'
  source: 'memory' | 'skill' | 'microagent';
  alwaysInclude: boolean;
}

export interface TriggerGatedKnowledgeConfig {
  /** Path to the workspace root where `.neuronest/microagents/` lives. */
  workspaceRoot: string;
  /** Feature gate system for checking the `trigger_gated_knowledge` flag. */
  featureGate: FeatureGateSystem;
}

// ─── Microagent Frontmatter Parsing ─────────────────────────────────────────

/**
 * Parses a `.neuronest/microagents/*.md` file with YAML-like frontmatter.
 *
 * Expected format:
 * ```
 * ---
 * triggers: [keyword1, keyword2]
 * alwaysInclude: false
 * ---
 * # Markdown body content
 * ```
 */
export function parseMicroagentFile(filePath: string, content: string): TriggerableEntry | null {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    // No frontmatter — treat as always-include with file content as body
    const id = path.basename(filePath, '.md');
    return {
      id: `microagent:${id}`,
      content: content.trim(),
      triggers: [],
      source: 'microagent',
      alwaysInclude: true,
    };
  }

  const [, frontmatter, body] = frontmatterMatch;
  const id = path.basename(filePath, '.md');

  // Parse triggers from frontmatter
  const triggers = parseTriggers(frontmatter);
  const alwaysInclude = parseAlwaysInclude(frontmatter, triggers);

  return {
    id: `microagent:${id}`,
    content: body.trim(),
    triggers,
    source: 'microagent',
    alwaysInclude,
  };
}

/**
 * Extracts the `triggers` array from frontmatter text.
 * Supports both inline array `triggers: [a, b, c]` and multiline YAML list.
 */
function parseTriggers(frontmatter: string): string[] {
  // Try inline array: triggers: [keyword1, keyword2]
  const inlineMatch = frontmatter.match(/^triggers:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }

  // Try multiline YAML list:
  // triggers:
  //   - keyword1
  //   - keyword2
  const multilineMatch = frontmatter.match(/^triggers:\s*\n((?:\s+-\s+.+\n?)*)/m);
  if (multilineMatch) {
    return multilineMatch[1]
      .split('\n')
      .map((line) => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''))
      .filter((s) => s.length > 0);
  }

  return [];
}

/**
 * Extracts the `alwaysInclude` flag from frontmatter.
 * Defaults to `true` if triggers array is empty, `false` otherwise.
 */
function parseAlwaysInclude(frontmatter: string, triggers: string[]): boolean {
  const match = frontmatter.match(/^alwaysInclude:\s*(true|false)/m);
  if (match) {
    return match[1] === 'true';
  }
  // Default: always include if no triggers specified
  return triggers.length === 0;
}

// ─── Trigger Matching ───────────────────────────────────────────────────────

/**
 * Checks if any trigger keyword matches the given text.
 * Case-insensitive word-boundary matching.
 */
export function matchesTrigger(triggers: string[], text: string): boolean {
  if (triggers.length === 0) return false;
  const lowerText = text.toLowerCase();
  return triggers.some((trigger) => {
    const lowerTrigger = trigger.toLowerCase();
    return lowerText.includes(lowerTrigger);
  });
}

// ─── TriggerGatedKnowledge Implementation ───────────────────────────────────

export class TriggerGatedKnowledgeImpl {
  private entries: Map<string, TriggerableEntry> = new Map();
  private readonly config: TriggerGatedKnowledgeConfig;

  constructor(config: TriggerGatedKnowledgeConfig) {
    this.config = config;
  }

  /**
   * Resolve which entries should be included in the current prompt assembly.
   *
   * When the feature flag is disabled, returns ALL registered entries
   * (same behavior as before the feature).
   *
   * When enabled:
   * - Entries with `alwaysInclude: true` are always included
   * - Entries with a non-empty `triggers` array are included only if at least
   *   one trigger keyword matches the task text or turn text
   * - Entries with empty triggers and `alwaysInclude: false` are excluded
   */
  resolve(taskText: string, turnText: string): TriggerableEntry[] {
    const isGated = this.config.featureGate.isEnabled('trigger_gated_knowledge');

    const allEntries = Array.from(this.entries.values());

    // When feature is disabled, include everything (backward compat)
    if (!isGated) {
      return allEntries;
    }

    const combinedText = `${taskText} ${turnText}`;
    const result: TriggerableEntry[] = [];

    for (const entry of allEntries) {
      if (entry.alwaysInclude) {
        result.push(entry);
        continue;
      }

      if (entry.triggers.length > 0 && matchesTrigger(entry.triggers, combinedText)) {
        result.push(entry);
      }
    }

    return result;
  }

  /**
   * Register a triggerable entry.
   * Overwrites any existing entry with the same ID.
   */
  register(entry: TriggerableEntry): void {
    this.entries.set(entry.id, entry);
  }

  /**
   * Update the `alwaysInclude` flag for a given entry.
   * No-op if the entry doesn't exist.
   */
  setAlwaysInclude(id: string, always: boolean): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.alwaysInclude = always;
    }
  }

  /**
   * Get a registered entry by ID. Returns undefined if not found.
   */
  getEntry(id: string): TriggerableEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Get the total number of registered entries.
   */
  getEntryCount(): number {
    return this.entries.size;
  }

  /**
   * Remove an entry by ID.
   */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * Load microagent files from `.neuronest/microagents/` directory.
   * Each `.md` file is parsed and registered as a triggerable entry.
   * Silently skips files that fail to parse.
   */
  loadMicroagents(): TriggerableEntry[] {
    const microagentDir = path.join(this.config.workspaceRoot, '.neuronest', 'microagents');
    const loaded: TriggerableEntry[] = [];

    if (!fs.existsSync(microagentDir)) {
      return loaded;
    }

    let files: string[];
    try {
      files = fs.readdirSync(microagentDir).filter((f) => f.endsWith('.md'));
    } catch {
      return loaded;
    }

    for (const file of files) {
      try {
        const filePath = path.join(microagentDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const entry = parseMicroagentFile(filePath, content);
        if (entry) {
          this.register(entry);
          loaded.push(entry);
        }
      } catch {
        // Silently skip unparseable files
      }
    }

    return loaded;
  }

  /**
   * Migrate existing project-memory entries and skill snippets to
   * triggerable entries with `alwaysInclude: true` (no data loss).
   * This preserves current behavior for existing content.
   */
  migrateExistingEntries(
    memoryEntries: Array<{ id: string; content: string }>,
    skillSnippets: Array<{ id: string; content: string }>,
  ): TriggerableEntry[] {
    const migrated: TriggerableEntry[] = [];

    for (const mem of memoryEntries) {
      const entry: TriggerableEntry = {
        id: `memory:${mem.id}`,
        content: mem.content,
        triggers: [],
        source: 'memory',
        alwaysInclude: true, // default to always during migration
      };
      this.register(entry);
      migrated.push(entry);
    }

    for (const skill of skillSnippets) {
      const entry: TriggerableEntry = {
        id: `skill:${skill.id}`,
        content: skill.content,
        triggers: [],
        source: 'skill',
        alwaysInclude: true, // default to always during migration
      };
      this.register(entry);
      migrated.push(entry);
    }

    return migrated;
  }
}
