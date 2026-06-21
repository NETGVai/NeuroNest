/**
 * MemoryStore — Cross-session memory persistence using git-tracked markdown files.
 *
 * Stores agent memories (architectural decisions, coding conventions, past mistakes,
 * learned patterns) as plain markdown files in a configurable directory. Each entry
 * is a markdown section with timestamp header and tags for retrieval.
 *
 * Key behaviors:
 * - Memory files stored as markdown in `{directory}/{category}.md`
 * - loadRelevant() matches tags against file paths and task description keywords
 * - compactIfNeeded() triggers when file exceeds maxFileSizeKb, uses LLM to summarize
 * - enforceBudget() prunes least-recently-referenced entries when total exceeds totalBudgetMb
 * - LLMClient is optional (summarization skipped when not available)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// ─── Interfaces ─────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  category: 'decisions' | 'conventions' | 'mistakes' | 'patterns';
  content: string;
  tags: string[];
  createdAt: string;
  lastReferencedAt: string;
}

export interface MemoryConfig {
  /** Directory where memory markdown files are stored. Default: .neuronest/memory/ */
  directory: string;
  /** Maximum size of a single category file in KB before compaction. Default: 50 */
  maxFileSizeKb: number;
  /** Total disk budget across all memory files in MB. Default: 10 */
  totalBudgetMb: number;
}

/**
 * Minimal LLM interface for summarization — kept loose to avoid
 * coupling to a specific client implementation.
 */
export interface LLMClient {
  chat(
    messages: Array<{ role: string; content: string }>,
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<{ content: string }>;
}

// ─── Constants ──────────────────────────────────────────────────

const VALID_CATEGORIES = ['decisions', 'conventions', 'mistakes', 'patterns'] as const;
type MemoryCategory = (typeof VALID_CATEGORIES)[number];

const ENTRY_HEADER_REGEX = /^## \[(.+?)\] (.+)$/;
const TAGS_REGEX = /^> Tags: (.+)$/;
const REFERENCED_REGEX = /^> Last referenced: (.+)$/;

// ─── MemoryStore Class ──────────────────────────────────────────

export class MemoryStore {
  constructor(
    private config: MemoryConfig,
    private llmClient?: LLMClient,
  ) {}

  /**
   * Load relevant memories by matching tags against file paths and task description.
   * Extracts keywords from file paths (directory names, file stems) and task description
   * words, then matches them against entry tags.
   *
   * Requirements: 5.2
   */
  async loadRelevant(filePaths: string[], taskDescription: string): Promise<MemoryEntry[]> {
    const keywords = this.extractKeywords(filePaths, taskDescription);
    if (keywords.size === 0) return [];

    const allEntries: MemoryEntry[] = [];

    for (const category of VALID_CATEGORIES) {
      const entries = await this.readCategoryFile(category);
      allEntries.push(...entries);
    }

    // Score entries by tag overlap with keywords
    const scored = allEntries
      .map((entry) => {
        const score = entry.tags.reduce((acc, tag) => {
          const normalizedTag = tag.toLowerCase();
          return keywords.has(normalizedTag) ? acc + 1 : acc;
        }, 0);
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    // Update lastReferencedAt for matched entries
    const matched = scored.map(({ entry }) => ({
      ...entry,
      lastReferencedAt: new Date().toISOString(),
    }));

    // Persist updated reference timestamps
    if (matched.length > 0) {
      await this.updateReferenceTimes(matched);
    }

    return matched;
  }

  /**
   * Append a new memory entry to the appropriate category file.
   * Creates the directory and file if they don't exist.
   * After appending, checks if compaction or budget enforcement is needed.
   *
   * Requirements: 5.3, 5.4
   */
  async append(
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'lastReferencedAt'>,
  ): Promise<void> {
    const now = new Date().toISOString();
    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: now,
      lastReferencedAt: now,
    };

    // Ensure directory exists
    fs.mkdirSync(this.config.directory, { recursive: true });

    const filePath = this.getCategoryFilePath(fullEntry.category);
    const markdown = this.entryToMarkdown(fullEntry);

    // Append to file (create if doesn't exist)
    fs.appendFileSync(filePath, markdown, 'utf-8');

    // Check if compaction needed after append
    await this.compactIfNeeded(fullEntry.category);

    // Check total budget
    await this.enforceBudget();
  }

  /**
   * Summarize and archive older entries when a category file exceeds the
   * configured size threshold (maxFileSizeKb). Uses LLM for summarization
   * when available; otherwise skips compaction.
   *
   * Requirements: 5.5
   */
  private async compactIfNeeded(category: string): Promise<void> {
    const filePath = this.getCategoryFilePath(category as MemoryCategory);

    if (!fs.existsSync(filePath)) return;

    const stats = fs.statSync(filePath);
    const fileSizeKb = stats.size / 1024;

    if (fileSizeKb <= this.config.maxFileSizeKb) return;

    // Skip compaction if no LLM client available
    if (!this.llmClient) return;

    const entries = await this.readCategoryFile(category as MemoryCategory);
    if (entries.length <= 1) return;

    // Sort by creation date, keep newest entries, summarize older ones
    const sorted = [...entries].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    // Keep the newest half, summarize the older half
    const splitIdx = Math.ceil(sorted.length / 2);
    const toSummarize = sorted.slice(0, splitIdx);
    const toKeep = sorted.slice(splitIdx);

    // Archive originals to a dated file
    const archiveFileName = `${category}-archive-${new Date().toISOString().split('T')[0]}.md`;
    const archivePath = path.join(this.config.directory, archiveFileName);
    const archiveContent = toSummarize.map((e) => this.entryToMarkdown(e)).join('');
    fs.writeFileSync(archivePath, archiveContent, 'utf-8');

    // Summarize using LLM
    const summaryContent = toSummarize.map((e) => e.content).join('\n\n');
    const allTags = [...new Set(toSummarize.flatMap((e) => e.tags))];

    try {
      const response = await this.llmClient.chat([
        {
          role: 'system',
          content:
            'You are a concise technical summarizer. Summarize the following memory entries into a single consolidated entry preserving key decisions and patterns. Keep it brief.',
        },
        { role: 'user', content: summaryContent },
      ], { temperature: 0.3, maxTokens: 500 });

      const summaryEntry: MemoryEntry = {
        id: randomUUID(),
        category: category as MemoryCategory,
        content: response.content,
        tags: allTags,
        createdAt: new Date().toISOString(),
        lastReferencedAt: new Date().toISOString(),
      };

      // Rewrite file with summary + kept entries
      const newContent = [summaryEntry, ...toKeep]
        .map((e) => this.entryToMarkdown(e))
        .join('');
      fs.writeFileSync(filePath, newContent, 'utf-8');
    } catch {
      // If LLM summarization fails, leave file as-is
    }
  }

  /**
   * Prune least-recently-referenced entries when total disk usage across
   * all memory files exceeds the configured totalBudgetMb.
   *
   * Requirements: 5.6
   */
  private async enforceBudget(): Promise<void> {
    const totalBudgetBytes = this.config.totalBudgetMb * 1024 * 1024;
    let totalSize = this.getTotalDirectorySize();

    if (totalSize <= totalBudgetBytes) return;

    // Collect all entries across all categories with their file info
    const allEntries: Array<{ entry: MemoryEntry; category: MemoryCategory }> = [];

    for (const category of VALID_CATEGORIES) {
      const entries = await this.readCategoryFile(category);
      for (const entry of entries) {
        allEntries.push({ entry, category });
      }
    }

    // Sort by lastReferencedAt ascending (oldest reference first = prune first)
    allEntries.sort(
      (a, b) =>
        new Date(a.entry.lastReferencedAt).getTime() -
        new Date(b.entry.lastReferencedAt).getTime(),
    );

    // Remove entries one by one until under budget
    const toRemove = new Set<string>();
    for (const { entry } of allEntries) {
      if (totalSize <= totalBudgetBytes) break;
      toRemove.add(entry.id);
      // Estimate entry size as its markdown representation
      const entrySize = Buffer.byteLength(this.entryToMarkdown(entry), 'utf-8');
      totalSize -= entrySize;
    }

    if (toRemove.size === 0) return;

    // Rewrite category files without pruned entries
    for (const category of VALID_CATEGORIES) {
      const entries = await this.readCategoryFile(category);
      const kept = entries.filter((e) => !toRemove.has(e.id));
      if (kept.length !== entries.length) {
        const filePath = this.getCategoryFilePath(category);
        const content = kept.map((e) => this.entryToMarkdown(e)).join('');
        fs.writeFileSync(filePath, content, 'utf-8');
      }
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Extract keywords from file paths and task description for matching.
   */
  private extractKeywords(filePaths: string[], taskDescription: string): Set<string> {
    const keywords = new Set<string>();

    // Extract from file paths: directory names, file stems (without extension)
    for (const fp of filePaths) {
      const parts = fp.replace(/\\/g, '/').split('/');
      for (const part of parts) {
        if (!part || part === '.' || part === '..') continue;
        // Strip extension for file names
        const stem = part.replace(/\.[^.]+$/, '');
        if (stem.length >= 2) {
          keywords.add(stem.toLowerCase());
        }
      }
    }

    // Extract from task description: split on non-alphanumeric, filter short words
    const words = taskDescription
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    for (const word of words) {
      keywords.add(word);
    }

    return keywords;
  }

  /**
   * Read and parse a category markdown file into MemoryEntry objects.
   */
  private async readCategoryFile(category: MemoryCategory): Promise<MemoryEntry[]> {
    const filePath = this.getCategoryFilePath(category);

    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf-8');
    return this.parseMarkdown(content, category);
  }

  /**
   * Parse markdown content into MemoryEntry objects.
   * Format:
   * ## [id] createdAt
   * > Tags: tag1, tag2
   * > Last referenced: timestamp
   *
   * Content here...
   */
  private parseMarkdown(content: string, category: MemoryCategory): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const lines = content.split('\n');

    let current: Partial<MemoryEntry> | null = null;
    let contentLines: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(ENTRY_HEADER_REGEX);
      if (headerMatch) {
        // Save previous entry
        if (current && current.id) {
          current.content = contentLines.join('\n').trim();
          entries.push(current as MemoryEntry);
        }
        // Start new entry
        current = {
          id: headerMatch[1],
          category,
          createdAt: headerMatch[2],
          tags: [],
          lastReferencedAt: headerMatch[2],
        };
        contentLines = [];
        continue;
      }

      if (current) {
        const tagsMatch = line.match(TAGS_REGEX);
        if (tagsMatch) {
          current.tags = tagsMatch[1].split(',').map((t) => t.trim());
          continue;
        }

        const refMatch = line.match(REFERENCED_REGEX);
        if (refMatch) {
          current.lastReferencedAt = refMatch[1];
          continue;
        }

        contentLines.push(line);
      }
    }

    // Don't forget last entry
    if (current && current.id) {
      current.content = contentLines.join('\n').trim();
      entries.push(current as MemoryEntry);
    }

    return entries;
  }

  /**
   * Convert a MemoryEntry to its markdown representation.
   */
  private entryToMarkdown(entry: MemoryEntry): string {
    return [
      `## [${entry.id}] ${entry.createdAt}`,
      `> Tags: ${entry.tags.join(', ')}`,
      `> Last referenced: ${entry.lastReferencedAt}`,
      '',
      entry.content,
      '',
      '',
    ].join('\n');
  }

  /**
   * Get the file path for a given category.
   */
  private getCategoryFilePath(category: MemoryCategory | string): string {
    return path.join(this.config.directory, `${category}.md`);
  }

  /**
   * Get total size in bytes of all files in the memory directory.
   */
  private getTotalDirectorySize(): number {
    if (!fs.existsSync(this.config.directory)) return 0;

    const files = fs.readdirSync(this.config.directory);
    let total = 0;
    for (const file of files) {
      const filePath = path.join(this.config.directory, file);
      const stats = fs.statSync(filePath);
      if (stats.isFile()) {
        total += stats.size;
      }
    }
    return total;
  }

  /**
   * Update the lastReferencedAt timestamp for matched entries in their category files.
   */
  private async updateReferenceTimes(updatedEntries: MemoryEntry[]): Promise<void> {
    // Group updates by category
    const byCategory = new Map<MemoryCategory, Map<string, string>>();
    for (const entry of updatedEntries) {
      if (!byCategory.has(entry.category)) {
        byCategory.set(entry.category, new Map());
      }
      byCategory.get(entry.category)!.set(entry.id, entry.lastReferencedAt);
    }

    // Rewrite each affected category file with updated timestamps
    for (const [category, updates] of byCategory) {
      const entries = await this.readCategoryFile(category);
      let changed = false;
      for (const entry of entries) {
        const newRef = updates.get(entry.id);
        if (newRef) {
          entry.lastReferencedAt = newRef;
          changed = true;
        }
      }
      if (changed) {
        const filePath = this.getCategoryFilePath(category);
        const content = entries.map((e) => this.entryToMarkdown(e)).join('');
        fs.writeFileSync(filePath, content, 'utf-8');
      }
    }
  }
}
