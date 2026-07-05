// ─── Standing Context (NEURONEST.md Loader) ────────────────────
// Loads the workspace-level NEURONEST.md file as standing context
// every session and every loop pass. Enforces a hard budget of
// 300 lines and emits a warning at 250 lines.
// Requirements: 20.1, 20.2, 20.3, 20.4, 20.6

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface LoadResult {
  content: string;
  lineCount: number;
  warning?: string;
}

export interface ValidateResult {
  valid: boolean;
  lineCount: number;
  message?: string;
}

export class StandingContext {
  /** Hard budget: file content is truncated at this line count (REQ-20.3) */
  private static readonly MAX_LINES = 300;
  /** Warning threshold: emit a warning when line count exceeds this (REQ-20.4) */
  private static readonly WARN_LINES = 250;

  private readonly filePath: string;
  private content: string = '';
  private lineCount: number = 0;

  constructor(private readonly workspacePath: string) {
    this.filePath = join(this.workspacePath, 'NEURONEST.md');
  }

  /**
   * Load NEURONEST.md content with budget enforcement (REQ-20.1, 20.3, 20.4).
   *
   * - If file does not exist, returns empty content with lineCount 0.
   * - If lineCount > MAX_LINES (300), truncates to 300 lines.
   * - If lineCount > WARN_LINES (250), includes a warning message.
   */
  async load(): Promise<LoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch {
      // File does not exist or is unreadable — return empty
      this.content = '';
      this.lineCount = 0;
      return { content: '', lineCount: 0 };
    }

    const lines = raw.split('\n');
    this.lineCount = lines.length;

    let warning: string | undefined;

    if (lines.length > StandingContext.MAX_LINES) {
      // Truncate to hard budget (REQ-20.3)
      this.content = lines.slice(0, StandingContext.MAX_LINES).join('\n');
      this.lineCount = StandingContext.MAX_LINES;
      warning = `NEURONEST.md exceeds the hard budget of ${StandingContext.MAX_LINES} lines (found ${lines.length}). Content has been truncated. Please prune the file.`;
    } else if (lines.length > StandingContext.WARN_LINES) {
      // Approaching budget (REQ-20.4)
      this.content = raw;
      warning = `NEURONEST.md is approaching its budget limit: ${lines.length}/${StandingContext.MAX_LINES} lines. Consider pruning soon.`;
    } else {
      this.content = raw;
    }

    const result: LoadResult = { content: this.content, lineCount: this.lineCount };
    if (warning) {
      result.warning = warning;
    }
    return result;
  }

  /**
   * Validate line count against budget constraints (REQ-20.3, 20.4).
   *
   * Returns valid=true if lineCount <= MAX_LINES, false otherwise.
   * Includes a message when approaching or exceeding the budget.
   */
  validate(): ValidateResult {
    const valid = this.lineCount <= StandingContext.MAX_LINES;
    let message: string | undefined;

    if (!valid) {
      message = `NEURONEST.md exceeds the hard budget of ${StandingContext.MAX_LINES} lines (current: ${this.lineCount}). File must be pruned.`;
    } else if (this.lineCount > StandingContext.WARN_LINES) {
      message = `NEURONEST.md is approaching its budget limit: ${this.lineCount}/${StandingContext.MAX_LINES} lines.`;
    }

    const result: ValidateResult = { valid, lineCount: this.lineCount };
    if (message) {
      result.message = message;
    }
    return result;
  }

  /**
   * Extract Never-touch declarations and compile them into deny patterns (REQ-20.6).
   *
   * Searches for a "## Never-touch" (or similar heading) section in the loaded
   * NEURONEST.md content. Each list item under that section is compiled into a
   * deny pattern string in "Write(path)" format for use by the Permission Pattern
   * Engine and EditLock constraints.
   *
   * These deny patterns are absolute and cannot be overridden by allow patterns,
   * hooks, or loop scope configurations (REQ-20.6).
   */
  extractNeverTouch(): string[] {
    if (!this.content) {
      return [];
    }

    const lines = this.content.split('\n');
    const patterns: string[] = [];
    let inNeverTouchSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect section header: ## Never-touch, ## Never-Touch, ## Never Touch, etc.
      if (/^#{1,3}\s+never[- ]?touch/i.test(trimmed)) {
        inNeverTouchSection = true;
        continue;
      }

      // Exit section on next heading of same or higher level
      if (inNeverTouchSection && /^#{1,3}\s+/.test(trimmed) && !/^#{1,3}\s+never[- ]?touch/i.test(trimmed)) {
        break;
      }

      // Collect list items within the Never-touch section
      if (inNeverTouchSection) {
        const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
        if (listMatch && listMatch[1]) {
          const entry = listMatch[1].trim();
          // Compile into Write(path) deny pattern format
          patterns.push(`Write(${entry})`);
        }
      }
    }

    return patterns;
  }
}
