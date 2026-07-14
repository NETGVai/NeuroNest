/**
 * Fill-in-the-Middle (FIM) Prompt Provider
 *
 * Constructs FIM prompts from Monaco editor state for inline code completion.
 * Supports multiple provider formats (OpenAI, Anthropic, Ollama) and enforces
 * token budgets for prefix/suffix context.
 *
 * Requirements: 1.1, 1.5
 */

// ─── Types ──────────────────────────────────────────────────────

/** Cursor position in the editor */
export interface CursorPosition {
  lineNumber: number; // 1-indexed
  column: number;     // 1-indexed
}

/** Monaco editor state needed for FIM prompt construction */
export interface EditorState {
  /** Full content of the active file */
  content: string;
  /** Current cursor position */
  cursor: CursorPosition;
  /** File path (for language detection) */
  filePath: string;
  /** Language identifier (e.g., 'typescript', 'python') */
  language?: string;
}

/** Supported FIM provider format */
export type FIMProviderFormat = 'openai' | 'anthropic' | 'ollama';

/** Configuration for FIM prompt construction */
export interface FIMConfig {
  /** Maximum tokens allowed for prefix context */
  maxPrefixTokens: number;
  /** Maximum tokens allowed for suffix context */
  maxSuffixTokens: number;
  /** Provider format to use */
  providerFormat: FIMProviderFormat;
  /** Characters per token estimate (for budget limiting) */
  charsPerToken: number;
}

/** Extracted prefix and suffix from editor state */
export interface PrefixSuffix {
  /** Code before the cursor (trimmed to token budget) */
  prefix: string;
  /** Code after the cursor (trimmed to token budget) */
  suffix: string;
  /** Original (untrimmed) prefix length in characters */
  originalPrefixLength: number;
  /** Original (untrimmed) suffix length in characters */
  originalSuffixLength: number;
  /** Whether the prefix was truncated to fit budget */
  prefixTruncated: boolean;
  /** Whether the suffix was truncated to fit budget */
  suffixTruncated: boolean;
}

/** Constructed FIM prompt ready to send to provider */
export interface FIMPrompt {
  /** System message describing the completion task */
  system: string;
  /** The formatted prompt content */
  prompt: string;
  /** Stop sequences the provider should use */
  stopSequences: string[];
  /** Metadata about the prompt construction */
  metadata: {
    language: string;
    prefixTokens: number;
    suffixTokens: number;
    format: FIMProviderFormat;
  };
}

// ─── Constants ──────────────────────────────────────────────────

/** Default FIM configuration */
export const DEFAULT_FIM_CONFIG: FIMConfig = {
  maxPrefixTokens: 2048,
  maxSuffixTokens: 512,
  providerFormat: 'openai',
  charsPerToken: 4,
};

/** FIM special tokens by provider format */
const FIM_TOKENS: Record<FIMProviderFormat, { prefix: string; suffix: string; middle: string }> = {
  openai: {
    prefix: '<' + '|fim_prefix|' + '>',
    suffix: '<' + '|fim_suffix|' + '>',
    middle: '<' + '|fim_middle|' + '>',
  },
  anthropic: {
    prefix: '<fim_prefix>',
    suffix: '<fim_suffix>',
    middle: '<fim_middle>',
  },
  ollama: {
    prefix: '<' + '|fim_prefix|' + '>',
    suffix: '<' + '|fim_suffix|' + '>',
    middle: '<' + '|fim_middle|' + '>',
  },
};

/** Common stop sequences for FIM completions */
const STOP_SEQUENCES: Record<FIMProviderFormat, string[]> = {
  openai: [
    '<' + '|fim_prefix|' + '>',
    '<' + '|fim_suffix|' + '>',
    '<' + '|fim_middle|' + '>',
    '<' + '|endoftext|' + '>',
  ],
  anthropic: [
    '<fim_prefix>',
    '<fim_suffix>',
    '<fim_middle>',
    '\n\n\n',
  ],
  ollama: [
    '<' + '|fim_prefix|' + '>',
    '<' + '|fim_suffix|' + '>',
    '<' + '|fim_middle|' + '>',
    '< EOT>',
  ],
};

// ─── FIM Provider ───────────────────────────────────────────────

/**
 * FIMProvider — Constructs Fill-in-the-Middle prompts from editor state.
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 * Provider-agnostic: supports OpenAI, Anthropic, and Ollama FIM formats.
 */
export class FIMProvider {
  private static instance: FIMProvider | null = null;
  private config: FIMConfig;

  private constructor(config?: Partial<FIMConfig>) {
    this.config = { ...DEFAULT_FIM_CONFIG, ...config };
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<FIMConfig>): FIMProvider {
    if (!FIMProvider.instance) {
      FIMProvider.instance = new FIMProvider(config);
    }
    return FIMProvider.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    FIMProvider.instance = null;
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<FIMConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** Get current configuration */
  getConfig(): Readonly<FIMConfig> {
    return { ...this.config };
  }

  // ─── Core Methods ───────────────────────────────────────────

  /**
   * Extract prefix and suffix from Monaco editor state.
   *
   * Splits the file content at the cursor position into prefix (before cursor)
   * and suffix (after cursor), then trims each to fit within token budgets.
   *
   * The prefix is trimmed from the beginning (keeping the most recent context),
   * and the suffix is trimmed from the end (keeping the nearest following context).
   */
  extractPrefixSuffix(editorState: EditorState): PrefixSuffix {
    const { content, cursor } = editorState;

    // Convert cursor position to character offset
    const offset = this.cursorToOffset(content, cursor);

    // Split at cursor position
    const fullPrefix = content.slice(0, offset);
    const fullSuffix = content.slice(offset);

    // Calculate character budgets from token budgets
    const maxPrefixChars = this.config.maxPrefixTokens * this.config.charsPerToken;
    const maxSuffixChars = this.config.maxSuffixTokens * this.config.charsPerToken;

    // Trim prefix from the start (keep most recent context near cursor)
    const prefixTruncated = fullPrefix.length > maxPrefixChars;
    const prefix = prefixTruncated
      ? fullPrefix.slice(-maxPrefixChars)
      : fullPrefix;

    // Trim suffix from the end (keep nearest context after cursor)
    const suffixTruncated = fullSuffix.length > maxSuffixChars;
    const suffix = suffixTruncated
      ? fullSuffix.slice(0, maxSuffixChars)
      : fullSuffix;

    return {
      prefix,
      suffix,
      originalPrefixLength: fullPrefix.length,
      originalSuffixLength: fullSuffix.length,
      prefixTruncated,
      suffixTruncated,
    };
  }

  /**
   * Build a FIM prompt from editor state, formatted for the configured provider.
   *
   * Constructs the complete prompt including special FIM tokens, system message,
   * and stop sequences specific to the target provider format.
   */
  buildPrompt(editorState: EditorState, formatOverride?: FIMProviderFormat): FIMPrompt {
    const format = formatOverride ?? this.config.providerFormat;
    const { prefix, suffix } = this.extractPrefixSuffix(editorState);
    const language = editorState.language ?? this.detectLanguage(editorState.filePath);
    const tokens = FIM_TOKENS[format];

    // Build the FIM prompt string
    const prompt = this.formatFIMPrompt(prefix, suffix, format, tokens);

    // System message for context
    const system = this.buildSystemMessage(language);

    return {
      system,
      prompt,
      stopSequences: [...STOP_SEQUENCES[format]],
      metadata: {
        language,
        prefixTokens: this.estimateTokens(prefix),
        suffixTokens: this.estimateTokens(suffix),
        format,
      },
    };
  }

  /**
   * Estimate the token count of a text string.
   *
   * Uses a simple character-to-token ratio. For more accurate counting,
   * consumers should use a proper tokenizer (e.g., tiktoken).
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.config.charsPerToken);
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Convert a 1-indexed line/column cursor position to a 0-indexed character offset.
   */
  private cursorToOffset(content: string, cursor: CursorPosition): number {
    const lines = content.split('\n');
    let offset = 0;

    // Sum all lines before the cursor line
    const targetLine = Math.min(cursor.lineNumber - 1, lines.length);
    for (let i = 0; i < targetLine; i++) {
      const line = lines[i];
      if (line !== undefined) {
        offset += line.length + 1; // +1 for newline character
      }
    }

    // Add column offset within the cursor line
    const currentLine = lines[targetLine];
    if (targetLine < lines.length && currentLine !== undefined) {
      offset += Math.min(cursor.column - 1, currentLine.length);
    }

    return Math.min(offset, content.length);
  }

  /**
   * Format the FIM prompt according to the provider's expected format.
   */
  private formatFIMPrompt(
    prefix: string,
    suffix: string,
    format: FIMProviderFormat,
    tokens: { prefix: string; suffix: string; middle: string },
  ): string {
    switch (format) {
      case 'openai':
        // OpenAI FIM format: <|fim_prefix|>PREFIX<|fim_suffix|>SUFFIX<|fim_middle|>
        return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;

      case 'anthropic':
        // Anthropic uses a message-based approach with FIM markers
        return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;

      case 'ollama':
        // Ollama uses the same token format as OpenAI (CodeLlama/DeepSeek compatible)
        return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;

      default:
        return `${tokens.prefix}${prefix}${tokens.suffix}${suffix}${tokens.middle}`;
    }
  }

  /**
   * Build the system message for FIM completion.
   */
  private buildSystemMessage(language: string): string {
    return (
      `You are an expert code completion engine. ` +
      `Given the surrounding code context (prefix and suffix), generate the code that should appear at the cursor position. ` +
      `Output ONLY the completion code — no explanations, no markdown fences, no surrounding context. ` +
      `Keep completions concise and natural (typically 1-5 lines). ` +
      `Language: ${language}`
    );
  }

  /**
   * Detect the programming language from a file path.
   */
  private detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const languageMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      rs: 'rust',
      go: 'go',
      java: 'java',
      c: 'c',
      cpp: 'cpp',
      h: 'c',
      hpp: 'cpp',
      cs: 'csharp',
      rb: 'ruby',
      php: 'php',
      swift: 'swift',
      kt: 'kotlin',
      scala: 'scala',
      html: 'html',
      css: 'css',
      scss: 'scss',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      md: 'markdown',
      sh: 'shellscript',
      bash: 'shellscript',
      sql: 'sql',
      vue: 'vue',
      svelte: 'svelte',
    };
    return languageMap[ext] ?? 'plaintext';
  }
}
