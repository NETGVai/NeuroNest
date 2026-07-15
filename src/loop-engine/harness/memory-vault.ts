// ─── Memory Vault (On-Disk Memory Layer) ───────────────────────
// Manages MEMORY.md index + topic-specific vault files under
// <workspace>/.neuronest/memory/. The Project Learning Memory DB
// is the write source of truth; on-disk files serve as the
// canonical read surface injected into loop pass contexts.
// Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  topic: string;
  content: string;
  loadBearing: boolean; // requires confirmation before deletion
  createdAt: string;
  source: string;
}

export interface ReadResult {
  content: string;
  tokenCount: number;
}

export interface CompactResult {
  removed: number;
  summarized: number;
  tokens: number;
}

export interface CompactionLog {
  timestamp: string;
  removed: number;
  summarized: number;
  resultingTokens: number;
}

// ─── Constants ──────────────────────────────────────────────────

const MEMORY_DIR = '.neuronest/memory';
const INDEX_FILE = 'MEMORY.md';
const LOAD_BEARING_MARKER = '[load-bearing]';

// ─── Token Estimation ───────────────────────────────────────────

/**
 * Estimate token count using chars/4 approximation (REQ-21.4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── MemoryVault Class ──────────────────────────────────────────

export class MemoryVault {
  private readonly memoryDir: string;
  private readonly indexPath: string;
  private compactionLogs: CompactionLog[] = [];

  /**
   * @param workspacePath - Root workspace path
   * @param tokenBudget - Maximum tokens for memory content injected into context (default 2048 per REQ-21.4)
   */
  constructor(
    private readonly workspacePath: string,
    private readonly tokenBudget: number = 2048,
  ) {
    this.memoryDir = join(this.workspacePath, MEMORY_DIR);
    this.indexPath = join(this.memoryDir, INDEX_FILE);
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Read MEMORY.md index + relevant topic files within the configured
   * token budget (REQ-21.1, 21.4).
   *
   * - Reads the MEMORY.md index first.
   * - Then reads each linked topic file, accumulating content until
   *   the token budget is reached.
   * - Returns empty content if no memory files exist.
   */
  async readWithinBudget(): Promise<ReadResult> {
    const indexContent = await this.readFileGracefully(this.indexPath);

    if (!indexContent) {
      return { content: '', tokenCount: 0 };
    }

    let accumulated = indexContent;
    let currentTokens = estimateTokens(accumulated);

    // If the index alone exceeds budget, truncate it
    if (currentTokens > this.tokenBudget) {
      const truncated = this.truncateToBudget(accumulated, this.tokenBudget);
      return { content: truncated, tokenCount: this.tokenBudget };
    }

    // Parse topic links from the index and read each topic file
    const topicFiles = this.parseTopicLinks(indexContent);

    for (const topicFile of topicFiles) {
      const topicPath = join(this.memoryDir, topicFile);
      const topicContent = await this.readFileGracefully(topicPath);

      if (!topicContent) {
        continue;
      }

      const topicTokens = estimateTokens(topicContent);

      if (currentTokens + topicTokens > this.tokenBudget) {
        // Partial read: include as much as fits within budget
        const remainingBudget = this.tokenBudget - currentTokens;
        if (remainingBudget > 0) {
          const partial = this.truncateToBudget(topicContent, remainingBudget);
          accumulated += '\n\n' + partial;
          currentTokens = this.tokenBudget;
        }
        break;
      }

      accumulated += '\n\n' + topicContent;
      currentTokens += topicTokens;
    }

    return { content: accumulated, tokenCount: currentTokens };
  }

  /**
   * Compact memory entries: reorganize, summarize, and prune (REQ-21.3, 21.5, 21.6).
   *
   * Compaction MAY run at any time during active sessions (not only at session end).
   * It may reorganize and summarize without necessarily deleting content.
   * Load-bearing entries are protected and skipped during removal (REQ-21.5).
   *
   * All compaction operations are logged for auditability (REQ-21.6).
   */
  async compact(): Promise<CompactResult> {
    await this.ensureMemoryDir();

    const topicFiles = await this.getTopicFiles();
    let removed = 0;
    let summarized = 0;

    for (const topicFile of topicFiles) {
      const topicPath = join(this.memoryDir, topicFile);
      const content = await this.readFileGracefully(topicPath);

      if (!content) {
        continue;
      }

      const { compacted, removedCount, summarizedCount } = this.compactContent(content);

      if (removedCount > 0 || summarizedCount > 0) {
        await writeFile(topicPath, compacted, 'utf-8');
        removed += removedCount;
        summarized += summarizedCount;
      }
    }

    // Calculate resulting token count
    const { tokenCount: tokens } = await this.readWithinBudget();

    // Log compaction for auditability (REQ-21.6)
    const log: CompactionLog = {
      timestamp: new Date().toISOString(),
      removed,
      summarized,
      resultingTokens: tokens,
    };
    this.compactionLogs.push(log);

    return { removed, summarized, tokens };
  }

  /**
   * Sync from Project Learning Memory DB to on-disk files (REQ-21.2).
   * Placeholder — the DB remains the write source of truth;
   * this method syncs entries to the on-disk read surface.
   */
  async syncFromDb(): Promise<void> {
    await this.ensureMemoryDir();
    // Placeholder: In a full implementation, this would:
    // 1. Query the Project Learning Memory DB for all entries
    // 2. Group entries by topic
    // 3. Write each topic group to its respective .md file
    // 4. Regenerate the MEMORY.md index with links to topic files
  }

  /**
   * Get compaction logs for auditability (REQ-21.6).
   */
  getCompactionLogs(): CompactionLog[] {
    return [...this.compactionLogs];
  }

  /**
   * Write entries to disk (used by syncFromDb and tests).
   * Creates MEMORY.md index and topic files.
   */
  async writeEntries(entries: MemoryEntry[]): Promise<void> {
    await this.ensureMemoryDir();

    // Group entries by topic
    const byTopic = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const existing = byTopic.get(entry.topic) ?? [];
      existing.push(entry);
      byTopic.set(entry.topic, existing);
    }

    // Write topic files
    const topicLinks: string[] = [];
    for (const [topic, topicEntries] of byTopic) {
      const fileName = this.topicToFileName(topic);
      const filePath = join(this.memoryDir, fileName);
      const content = this.formatTopicFile(topic, topicEntries);
      await writeFile(filePath, content, 'utf-8');
      topicLinks.push(`- [${topic}](./${fileName})`);
    }

    // Write MEMORY.md index
    const indexContent = `# Memory Index\n\n${topicLinks.join('\n')}\n`;
    await writeFile(this.indexPath, indexContent, 'utf-8');
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Read a file gracefully, returning empty string if it doesn't exist.
   */
  private async readFileGracefully(filePath: string): Promise<string> {
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Ensure the memory directory exists.
   */
  private async ensureMemoryDir(): Promise<void> {
    if (!existsSync(this.memoryDir)) {
      await mkdir(this.memoryDir, { recursive: true });
    }
  }

  /**
   * Parse topic file links from MEMORY.md index content.
   * Expects markdown links in format: `- [Topic Name](./filename.md)`
   */
  private parseTopicLinks(indexContent: string): string[] {
    const links: string[] = [];
    const lines = indexContent.split('\n');

    for (const line of lines) {
      const match = line.match(/\[.*?\]\(\.\/(.+?\.md)\)/);
      if (match && match[1]) {
        links.push(match[1]);
      }
    }

    return links;
  }

  /**
   * Get all topic .md files from the memory directory (excluding MEMORY.md).
   */
  private async getTopicFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.memoryDir);
      return files.filter(f => f.endsWith('.md') && f !== INDEX_FILE);
    } catch {
      return [];
    }
  }

  /**
   * Compact the content of a single topic file.
   * - Removes superseded entries (older duplicates of the same information)
   * - Summarizes verbose entries
   * - Protects load-bearing entries (REQ-21.5)
   */
  private compactContent(content: string): {
    compacted: string;
    removedCount: number;
    summarizedCount: number;
  } {
    const entries = this.parseEntries(content);
    const result: string[] = [];
    let removedCount = 0;
    let summarizedCount = 0;

    // Extract the header (everything before the first entry marker)
    const headerMatch = content.match(/^([\s\S]*?)(?=^### )/m);
    const header = headerMatch ? headerMatch[1] : '';

    // Track seen content hashes to detect superseded entries
    const seenContentSignatures = new Set<string>();

    for (const entry of entries) {
      // Load-bearing entries are always preserved (REQ-21.5)
      if (entry.includes(LOAD_BEARING_MARKER)) {
        result.push(entry);
        continue;
      }

      // Generate a content signature to detect duplicates/superseded entries
      const signature = this.contentSignature(entry);

      if (seenContentSignatures.has(signature)) {
        // Superseded — remove
        removedCount++;
        continue;
      }

      seenContentSignatures.add(signature);

      // Summarize verbose entries (> 500 chars that aren't load-bearing)
      if (entry.length > 500) {
        const summarized = this.summarizeEntry(entry);
        result.push(summarized);
        summarizedCount++;
      } else {
        result.push(entry);
      }
    }

    const compacted = header + result.join('\n\n');
    return { compacted, removedCount, summarizedCount };
  }

  /**
   * Parse individual entries from a topic file.
   * Entries are delimited by `### ` headings.
   */
  private parseEntries(content: string): string[] {
    const sections = content.split(/(?=^### )/m);
    // Filter out the header section (no ### prefix)
    return sections.filter(s => s.trimStart().startsWith('### '));
  }

  /**
   * Generate a simple content signature for deduplication.
   * Extracts the core meaning by normalizing whitespace and lowercasing.
   */
  private contentSignature(entry: string): string {
    // Use the first heading line as the primary key
    const firstLine = entry.split('\n')[0] ?? '';
    return firstLine.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /**
   * Summarize a verbose entry by keeping the heading and first 2 content lines.
   */
  private summarizeEntry(entry: string): string {
    const lines = entry.split('\n');
    const heading = lines[0] ?? '';
    const contentLines = lines.slice(1).filter(l => l.trim().length > 0);
    const summary = contentLines.slice(0, 2).join('\n');
    return `${heading}\n${summary}\n_(summarized)_`;
  }

  /**
   * Truncate text to fit within a token budget.
   */
  private truncateToBudget(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars);
  }

  /**
   * Convert a topic name to a safe filename.
   */
  private topicToFileName(topic: string): string {
    return topic.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '.md';
  }

  /**
   * Format entries into a topic file with markdown structure.
   */
  private formatTopicFile(topic: string, entries: MemoryEntry[]): string {
    const lines: string[] = [`# ${topic}\n`];

    for (const entry of entries) {
      const marker = entry.loadBearing ? ` ${LOAD_BEARING_MARKER}` : '';
      lines.push(`### ${entry.id}${marker}`);
      lines.push(entry.content);
      lines.push(`_Source: ${entry.source} | Created: ${entry.createdAt}_`);
      lines.push('');
    }

    return lines.join('\n');
  }
}
