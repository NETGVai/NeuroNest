/**
 * Turbo Edits — Routes between fast and flagship models based on task complexity.
 *
 * The router analyzes conversation context for file references and uses the count
 * of distinct file paths to determine which model tier to use:
 * - Single-file edits (≤ threshold) → fast model (cheaper, faster)
 * - Multi-file coordinated changes (> threshold) → flagship model (more capable)
 *
 * Users can override automatic routing via an explicit parameter.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

// ─── Interfaces ─────────────────────────────────────────────────

/** Configuration for the Turbo Edits router */
export interface TurboEditsConfig {
  fastModel: string;      // e.g., "gpt-4o-mini"
  flagshipModel: string;  // e.g., "claude-3.5-sonnet"
  threshold: number;      // Files count threshold (default: 1)
}

/** Result of routing decision with the selected model and reason */
export interface RoutingDecision {
  model: string;
  reason: 'single_file' | 'multi_file' | 'user_override';
}

// ─── File Path Extraction Patterns ──────────────────────────────

/**
 * Regex patterns used to identify file path references in conversation text.
 * These cover common formats:
 * - Unix-style relative paths (src/foo/bar.ts, ./utils/helper.js)
 * - Paths with file extensions (.ts, .js, .tsx, .jsx, .py, .json, .md, .css, .html, etc.)
 * - Paths containing directory separators with at least one slash and an extension
 */
const FILE_PATH_PATTERNS: RegExp[] = [
  // Paths starting with ./ or ../ (relative paths)
  /(?:^|\s|[`"'(])(\.\.\/.+?\.[a-zA-Z]{1,10})(?=[\s`"'),;:\]]|$)/gm,
  /(?:^|\s|[`"'(])(\.\/.+?\.[a-zA-Z]{1,10})(?=[\s`"'),;:\]]|$)/gm,
  // Paths with directory separators and file extensions (e.g., src/utils/helper.ts)
  /(?:^|\s|[`"'(])([a-zA-Z0-9_@][a-zA-Z0-9_\-@.]*\/[a-zA-Z0-9_\-@./]*\.[a-zA-Z]{1,10})(?=[\s`"'),;:\]]|$)/gm,
];

// ─── TurboEditsRouter Class ─────────────────────────────────────

/**
 * Routes LLM requests between fast and flagship models based on task complexity.
 *
 * Complexity is determined by counting distinct file paths referenced in the
 * conversation context. Single-file tasks use the fast model for speed and cost;
 * multi-file tasks use the flagship model for better coordination.
 */
export class TurboEditsRouter {
  private readonly config: TurboEditsConfig;

  constructor(config: TurboEditsConfig) {
    this.config = {
      fastModel: config.fastModel,
      flagshipModel: config.flagshipModel,
      threshold: config.threshold ?? 1,
    };
  }

  /**
   * Determine which model to route to based on conversation context.
   *
   * @param conversationContext - The full conversation text to analyze for file references
   * @param modelOverride - Optional explicit model to use (bypasses automatic routing)
   * @returns RoutingDecision with the selected model and the reason for selection
   */
  route(conversationContext: string, modelOverride?: string): RoutingDecision {
    // User override takes highest priority
    if (modelOverride) {
      return {
        model: modelOverride,
        reason: 'user_override',
      };
    }

    // Extract and count distinct file paths from the conversation
    const filePaths = this.extractFilePaths(conversationContext);
    const distinctCount = filePaths.length;

    // Route based on threshold comparison
    if (distinctCount <= this.config.threshold) {
      return {
        model: this.config.fastModel,
        reason: 'single_file',
      };
    }

    return {
      model: this.config.flagshipModel,
      reason: 'multi_file',
    };
  }

  /**
   * Extract distinct file path references from text.
   *
   * Scans the input text using multiple regex patterns designed to catch
   * common file path formats used in developer conversations.
   *
   * @param text - The text to scan for file path references
   * @returns Array of unique file path strings found in the text
   */
  extractFilePaths(text: string): string[] {
    const foundPaths = new Set<string>();

    for (const pattern of FILE_PATH_PATTERNS) {
      // Reset lastIndex for global regex patterns
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        const filePath = match[1].trim();
        // Basic sanity check: must have at least one character before the extension
        if (filePath.length > 2) {
          foundPaths.add(filePath);
        }
      }
    }

    return Array.from(foundPaths);
  }
}
