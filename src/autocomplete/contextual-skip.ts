/**
 * Contextual Skip — Intelligent Suggestion Suppression
 *
 * Determines whether to suppress autocomplete suggestions based on cursor
 * context. Language-aware, configurable, and follows NeuroNest's lazy-initialized
 * singleton pattern.
 *
 * Rules (from Requirements 1.4):
 * - SUPPRESS inside string literals UNLESS the user has typed a partial path
 * - SUPPRESS inside import statements UNLESS the user has typed a partial path
 * - ALLOW completions inside comments (even without a partial path)
 * - SUPPRESS inside decorators (language-specific)
 * - Language-specific rules: Python docstrings (allowed), JSX attributes (suppressed)
 *
 * Requirements: 1.4
 */

// ─── Types ──────────────────────────────────────────────────────

/** Supported language identifiers */
export type SupportedLanguage =
  | 'typescript'
  | 'typescriptreact'
  | 'javascript'
  | 'javascriptreact'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'plaintext';

/** Cursor context classification */
export type CursorContext =
  | 'code'
  | 'comment'
  | 'single_line_comment'
  | 'multi_line_comment'
  | 'string_literal'
  | 'template_literal'
  | 'import_path'
  | 'decorator'
  | 'docstring'
  | 'jsx_attribute';

/** Result of skip analysis */
export interface SkipDecision {
  /** Whether to suppress the suggestion */
  shouldSkip: boolean;
  /** The detected cursor context */
  context: CursorContext;
  /** Reason for the decision */
  reason: string;
  /** Whether a partial path was detected (relevant for import/string contexts) */
  hasPartialPath: boolean;
}

/** A configurable skip pattern rule */
export interface SkipPattern {
  /** Unique identifier for this rule */
  id: string;
  /** Human-readable description */
  description: string;
  /** The cursor context this rule applies to */
  context: CursorContext;
  /** Languages this rule applies to ('*' for all) */
  languages: SupportedLanguage[] | '*';
  /** Whether this context should suppress suggestions */
  shouldSkip: boolean;
  /** Whether the presence of a partial path overrides the skip */
  partialPathOverrides: boolean;
}

/** Configuration for the contextual skip module */
export interface ContextualSkipConfig {
  /** Whether contextual skip is enabled */
  enabled: boolean;
  /** Custom skip patterns (merged with defaults) */
  customPatterns: SkipPattern[];
  /** Minimum characters after a path separator to count as a partial path */
  minPartialPathChars: number;
  /** Characters considered as path separators */
  pathSeparators: string[];
}

/** Editor line context passed for analysis */
export interface LineContext {
  /** The full text of the current line */
  lineText: string;
  /** Column position of the cursor (1-indexed) */
  column: number;
  /** Language identifier */
  language: SupportedLanguage;
  /** Lines above the cursor (for multi-line context detection) */
  precedingLines?: string[];
}

// ─── Constants ──────────────────────────────────────────────────

/** Default configuration */
export const DEFAULT_CONTEXTUAL_SKIP_CONFIG: ContextualSkipConfig = {
  enabled: true,
  customPatterns: [],
  minPartialPathChars: 1,
  pathSeparators: ['/', '.', '\\', '@'],
};

/** Default skip patterns that define the core behavior */
export const DEFAULT_SKIP_PATTERNS: SkipPattern[] = [
  {
    id: 'string-literal',
    description: 'Suppress inside string literals unless partial path typed',
    context: 'string_literal',
    languages: '*',
    shouldSkip: true,
    partialPathOverrides: true,
  },
  {
    id: 'template-literal',
    description: 'Suppress inside template literals unless partial path typed',
    context: 'template_literal',
    languages: '*',
    shouldSkip: true,
    partialPathOverrides: true,
  },
  {
    id: 'import-path',
    description: 'Suppress inside import paths unless partial path typed',
    context: 'import_path',
    languages: '*',
    shouldSkip: true,
    partialPathOverrides: true,
  },
  {
    id: 'comment-allowed',
    description: 'Allow completions inside comments',
    context: 'comment',
    languages: '*',
    shouldSkip: false,
    partialPathOverrides: false,
  },
  {
    id: 'single-line-comment-allowed',
    description: 'Allow completions inside single-line comments',
    context: 'single_line_comment',
    languages: '*',
    shouldSkip: false,
    partialPathOverrides: false,
  },
  {
    id: 'multi-line-comment-allowed',
    description: 'Allow completions inside multi-line comments',
    context: 'multi_line_comment',
    languages: '*',
    shouldSkip: false,
    partialPathOverrides: false,
  },
  {
    id: 'decorator',
    description: 'Suppress inside decorators',
    context: 'decorator',
    languages: ['typescript', 'typescriptreact', 'python', 'java'],
    shouldSkip: true,
    partialPathOverrides: false,
  },
  {
    id: 'docstring-allowed',
    description: 'Allow completions inside Python docstrings',
    context: 'docstring',
    languages: ['python'],
    shouldSkip: false,
    partialPathOverrides: false,
  },
  {
    id: 'jsx-attribute',
    description: 'Suppress inside JSX attribute values',
    context: 'jsx_attribute',
    languages: ['typescriptreact', 'javascriptreact'],
    shouldSkip: true,
    partialPathOverrides: true,
  },
];

// ─── Language-specific comment patterns ─────────────────────────

interface CommentPattern {
  singleLine: string[];
  multiLineStart: string[];
  multiLineEnd: string[];
}

const COMMENT_PATTERNS: Partial<Record<SupportedLanguage, CommentPattern>> = {
  typescript: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  typescriptreact: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  javascript: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  javascriptreact: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  python: { singleLine: ['#'], multiLineStart: ['"""', "'''"], multiLineEnd: ['"""', "'''"] },
  go: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  rust: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  java: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  csharp: { singleLine: ['//'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
  ruby: { singleLine: ['#'], multiLineStart: ['=begin'], multiLineEnd: ['=end'] },
  php: { singleLine: ['//', '#'], multiLineStart: ['/*'], multiLineEnd: ['*/'] },
};

/** String delimiter characters by language */
const STRING_DELIMITERS: Partial<Record<SupportedLanguage, string[]>> = {
  typescript: ['"', "'", '`'],
  typescriptreact: ['"', "'", '`'],
  javascript: ['"', "'", '`'],
  javascriptreact: ['"', "'", '`'],
  python: ['"', "'"],
  go: ['"', "'", '`'],
  rust: ['"'],
  java: ['"', "'"],
  csharp: ['"', "'"],
  ruby: ['"', "'"],
  php: ['"', "'"],
};

/** Import statement patterns by language */
const IMPORT_PATTERNS: Partial<Record<SupportedLanguage, RegExp[]>> = {
  typescript: [/^\s*import\s/, /^\s*from\s/, /\brequire\s*\(/],
  typescriptreact: [/^\s*import\s/, /^\s*from\s/, /\brequire\s*\(/],
  javascript: [/^\s*import\s/, /^\s*from\s/, /\brequire\s*\(/],
  javascriptreact: [/^\s*import\s/, /^\s*from\s/, /\brequire\s*\(/],
  python: [/^\s*import\s/, /^\s*from\s/],
  go: [/^\s*import\s/],
  rust: [/^\s*use\s/, /^\s*extern\s+crate\s/],
  java: [/^\s*import\s/],
  csharp: [/^\s*using\s/],
  ruby: [/\brequire\s/, /\brequire_relative\s/],
  php: [/^\s*use\s/, /\brequire\s/, /\binclude\s/],
};

// ─── ContextualSkip Service ─────────────────────────────────────

/**
 * ContextualSkip — Determines whether to suppress autocomplete suggestions
 * based on the cursor's syntactic context.
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 */
export class ContextualSkip {
  private static instance: ContextualSkip | null = null;
  private config: ContextualSkipConfig;
  private patterns: SkipPattern[];

  private constructor(config?: Partial<ContextualSkipConfig>) {
    this.config = { ...DEFAULT_CONTEXTUAL_SKIP_CONFIG, ...config };
    this.patterns = this.mergePatterns(DEFAULT_SKIP_PATTERNS, this.config.customPatterns);
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<ContextualSkipConfig>): ContextualSkip {
    if (!ContextualSkip.instance) {
      ContextualSkip.instance = new ContextualSkip(config);
    }
    return ContextualSkip.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    ContextualSkip.instance = null;
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<ContextualSkipConfig>): void {
    this.config = { ...this.config, ...config };
    this.patterns = this.mergePatterns(DEFAULT_SKIP_PATTERNS, this.config.customPatterns);
  }

  /** Get current configuration */
  getConfig(): Readonly<ContextualSkipConfig> {
    return { ...this.config };
  }

  /** Get the active skip patterns (defaults + custom) */
  getPatterns(): Readonly<SkipPattern[]> {
    return [...this.patterns];
  }

  // ─── Core Analysis ──────────────────────────────────────────

  /**
   * Analyze the cursor context and determine whether to skip autocomplete.
   *
   * @param lineContext - The current line, cursor position, and language info
   * @returns SkipDecision with the determination and reasoning
   */
  shouldSkip(lineContext: LineContext): SkipDecision {
    if (!this.config.enabled) {
      return {
        shouldSkip: false,
        context: 'code',
        reason: 'Contextual skip is disabled',
        hasPartialPath: false,
      };
    }

    // Detect the cursor context
    const context = this.detectContext(lineContext);

    // Find applicable pattern for this context + language
    const pattern = this.findApplicablePattern(context, lineContext.language);

    // If no pattern matches, allow completion (default: code context)
    if (!pattern) {
      return {
        shouldSkip: false,
        context,
        reason: 'No skip rule applies to this context',
        hasPartialPath: false,
      };
    }

    // Check for partial path override
    const hasPartialPath = pattern.partialPathOverrides
      ? this.detectPartialPath(lineContext)
      : false;

    // If the pattern says skip but there's a partial path that overrides, don't skip
    if (pattern.shouldSkip && pattern.partialPathOverrides && hasPartialPath) {
      return {
        shouldSkip: false,
        context,
        reason: `Partial path detected in ${context} — allowing completion`,
        hasPartialPath: true,
      };
    }

    return {
      shouldSkip: pattern.shouldSkip,
      context,
      reason: pattern.description,
      hasPartialPath,
    };
  }

  // ─── Context Detection ────────────────────────────────────────

  /**
   * Detect the syntactic context at the cursor position.
   *
   * Priority order:
   * 1. Multi-line comment / docstring (check preceding lines)
   * 2. Single-line comment
   * 3. Decorator
   * 4. Import path (string within an import statement)
   * 5. JSX attribute
   * 6. String literal / template literal
   * 7. Code (default)
   */
  detectContext(lineContext: LineContext): CursorContext {
    const { lineText, column, language, precedingLines } = lineContext;
    const textBeforeCursor = lineText.slice(0, column - 1);

    // 1. Check multi-line comment / docstring
    const multiLineResult = this.isInMultiLineComment(textBeforeCursor, language, precedingLines);
    if (multiLineResult) {
      if (language === 'python' && multiLineResult === 'docstring') {
        return 'docstring';
      }
      return 'multi_line_comment';
    }

    // 2. Check single-line comment
    if (this.isInSingleLineComment(textBeforeCursor, language)) {
      return 'single_line_comment';
    }

    // 3. Check decorator
    if (this.isInDecorator(textBeforeCursor, language)) {
      return 'decorator';
    }

    // 4. Check import path (string inside import statement)
    if (this.isInImportPath(lineText, textBeforeCursor, language)) {
      return 'import_path';
    }

    // 5. Check JSX attribute
    if (this.isInJSXAttribute(textBeforeCursor, language)) {
      return 'jsx_attribute';
    }

    // 6. Check string literal or template literal
    const stringResult = this.isInStringLiteral(textBeforeCursor, language);
    if (stringResult === 'template') {
      return 'template_literal';
    }
    if (stringResult === 'string') {
      return 'string_literal';
    }

    // 7. Default: code
    return 'code';
  }

  // ─── Private Detection Helpers ────────────────────────────────

  /**
   * Check if the cursor is inside a single-line comment.
   */
  private isInSingleLineComment(textBeforeCursor: string, language: SupportedLanguage): boolean {
    const patterns = COMMENT_PATTERNS[language];
    if (!patterns) return false;

    for (const prefix of patterns.singleLine) {
      // Check if there's an unquoted comment marker before the cursor
      if (this.hasUnquotedMarker(textBeforeCursor, prefix, language)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if the cursor is inside a multi-line comment or docstring.
   * Returns 'docstring' for Python triple-quoted strings used as docstrings,
   * 'comment' for regular multi-line comments, or null if not in one.
   */
  private isInMultiLineComment(
    textBeforeCursor: string,
    language: SupportedLanguage,
    precedingLines?: string[],
  ): 'comment' | 'docstring' | null {
    const patterns = COMMENT_PATTERNS[language];
    if (!patterns) return null;

    // Build full context from preceding lines + current line
    const fullContext = precedingLines
      ? [...precedingLines, textBeforeCursor].join('\n')
      : textBeforeCursor;

    for (let i = 0; i < patterns.multiLineStart.length; i++) {
      const start = patterns.multiLineStart[i]!;
      const end = patterns.multiLineEnd[i]!;

      let isInside: boolean;

      if (start === end) {
        // For symmetric delimiters (e.g., Python """/'''), odd count means we're inside
        const count = this.countOccurrences(fullContext, start);
        isInside = count % 2 !== 0;
      } else {
        // For asymmetric delimiters (e.g., /* */), more starts than ends means inside
        const startCount = this.countOccurrences(fullContext, start);
        const endCount = this.countOccurrences(fullContext, end);
        isInside = startCount > endCount;
      }

      if (isInside) {
        if (language === 'python' && (start === '"""' || start === "'''")) {
          return this.isPythonDocstring(fullContext, start) ? 'docstring' : 'comment';
        }
        return 'comment';
      }
    }

    return null;
  }

  /**
   * Check if a Python triple-quoted string is likely a docstring.
   * A docstring appears immediately after a function/class/module definition.
   */
  private isPythonDocstring(context: string, delimiter: string): boolean {
    // Find the last opening triple-quote
    const lastOpen = context.lastIndexOf(delimiter);
    if (lastOpen < 0) return false;

    // Look at the content before the opening triple-quote
    const beforeQuote = context.slice(0, lastOpen).trimEnd();
    const lastLine = beforeQuote.split('\n').pop() ?? '';

    // Docstring patterns: after def, class, or at module start
    return /^\s*(def|class|async\s+def)\s/.test(lastLine) || beforeQuote === '';
  }

  /**
   * Check if the cursor is inside a decorator expression.
   */
  private isInDecorator(textBeforeCursor: string, language: SupportedLanguage): boolean {
    const trimmed = textBeforeCursor.trimStart();

    switch (language) {
      case 'typescript':
      case 'typescriptreact':
      case 'java':
        // @DecoratorName or @Decorator(...)
        return /^@\w/.test(trimmed) && !trimmed.includes(')');

      case 'python':
        // @decorator or @decorator(...)
        return /^@\w/.test(trimmed) && !trimmed.includes(')');

      default:
        return false;
    }
  }

  /**
   * Check if the cursor is inside an import statement's path portion.
   */
  private isInImportPath(
    fullLine: string,
    textBeforeCursor: string,
    language: SupportedLanguage,
  ): boolean {
    const importPatterns = IMPORT_PATTERNS[language];
    if (!importPatterns) return false;

    // Check if this line matches any import pattern
    const isImportLine = importPatterns.some((pattern) => pattern.test(fullLine));
    if (!isImportLine) return false;

    // Now check if the cursor is inside a string on this import line
    return this.isInStringLiteral(textBeforeCursor, language) !== null;
  }

  /**
   * Check if the cursor is inside a JSX attribute value.
   * E.g., <Component prop="cursor_here" />
   */
  private isInJSXAttribute(textBeforeCursor: string, language: SupportedLanguage): boolean {
    if (language !== 'typescriptreact' && language !== 'javascriptreact') {
      return false;
    }

    // Look for pattern: attribute_name="...  or attribute_name={'...
    // Simplified check: inside quotes that are preceded by = and a word char
    const jsxAttrPattern = /\w+=["'{](?:[^"'}]*)$/;
    return jsxAttrPattern.test(textBeforeCursor);
  }

  /**
   * Check if the cursor is inside a string literal.
   * Returns 'string' for regular strings, 'template' for template literals, or null.
   */
  private isInStringLiteral(
    textBeforeCursor: string,
    language: SupportedLanguage,
  ): 'string' | 'template' | null {
    const delimiters = STRING_DELIMITERS[language] ?? ['"', "'"];

    // Count unescaped delimiter occurrences
    for (const delim of delimiters) {
      const count = this.countUnescapedDelimiters(textBeforeCursor, delim);
      if (count % 2 !== 0) {
        // Odd count means we're inside a string
        return delim === '`' ? 'template' : 'string';
      }
    }

    return null;
  }

  /**
   * Detect whether the user has typed a partial path at the cursor position.
   *
   * A "partial path" is defined as text containing at least one path separator
   * followed by at least `minPartialPathChars` non-separator characters.
   */
  detectPartialPath(lineContext: LineContext): boolean {
    const { lineText, column } = lineContext;
    const textBeforeCursor = lineText.slice(0, column - 1);

    // Extract the text inside the current string (from the last unmatched quote)
    const stringContent = this.extractCurrentStringContent(textBeforeCursor, lineContext.language);
    if (!stringContent) return false;

    // Find the last path separator position in the string content
    let lastSepIdx = -1;
    for (const sep of this.config.pathSeparators) {
      const idx = stringContent.lastIndexOf(sep);
      if (idx > lastSepIdx) {
        lastSepIdx = idx;
      }
    }

    if (lastSepIdx < 0) return false;

    // The text after the last separator must be at least minPartialPathChars
    // and must not itself be another separator
    const afterSep = stringContent.slice(lastSepIdx + 1);
    return afterSep.length >= this.config.minPartialPathChars;
  }

  // ─── Utility Methods ──────────────────────────────────────────

  /**
   * Count occurrences of a substring in a string.
   */
  private countOccurrences(text: string, sub: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = text.indexOf(sub, pos)) !== -1) {
      count++;
      pos += sub.length;
    }
    return count;
  }

  /**
   * Count unescaped delimiter characters in text.
   * A delimiter preceded by an odd number of backslashes is considered escaped.
   */
  private countUnescapedDelimiters(text: string, delimiter: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === delimiter) {
        // Count preceding backslashes
        let backslashes = 0;
        let j = i - 1;
        while (j >= 0 && text[j] === '\\') {
          backslashes++;
          j--;
        }
        // If even number of backslashes, the delimiter is not escaped
        if (backslashes % 2 === 0) {
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Check if a marker (e.g., //) exists in text without being inside a string.
   * Simplified heuristic: checks that the marker appears before any string delimiters
   * or that string delimiters after it are paired.
   */
  private hasUnquotedMarker(text: string, marker: string, language: SupportedLanguage): boolean {
    const markerIdx = text.indexOf(marker);
    if (markerIdx < 0) return false;

    // Check that the marker isn't inside a string
    const beforeMarker = text.slice(0, markerIdx);
    const delimiters = STRING_DELIMITERS[language] ?? ['"', "'"];

    for (const delim of delimiters) {
      const count = this.countUnescapedDelimiters(beforeMarker, delim);
      if (count % 2 !== 0) {
        // The marker is inside a string
        return false;
      }
    }

    return true;
  }

  /**
   * Extract the content of the string the cursor is currently inside.
   * Returns the text between the opening quote and the cursor position.
   */
  private extractCurrentStringContent(
    textBeforeCursor: string,
    language: SupportedLanguage,
  ): string | null {
    const delimiters = STRING_DELIMITERS[language] ?? ['"', "'"];

    for (const delim of delimiters) {
      const count = this.countUnescapedDelimiters(textBeforeCursor, delim);
      if (count % 2 !== 0) {
        // We're inside a string — find the last unmatched opening delimiter
        const lastDelimIdx = textBeforeCursor.lastIndexOf(delim);
        if (lastDelimIdx >= 0) {
          return textBeforeCursor.slice(lastDelimIdx + 1);
        }
      }
    }

    return null;
  }

  /**
   * Find the skip pattern that applies to the given context and language.
   * Custom patterns override defaults (matched by id).
   */
  private findApplicablePattern(
    context: CursorContext,
    language: SupportedLanguage,
  ): SkipPattern | null {
    // 'comment' context can match both 'comment' and the more specific variants
    const matchContexts: CursorContext[] = [context];
    if (context === 'single_line_comment' || context === 'multi_line_comment') {
      matchContexts.push('comment');
    }

    for (const ctx of matchContexts) {
      const pattern = this.patterns.find((p) => {
        if (p.context !== ctx) return false;
        if (p.languages === '*') return true;
        return p.languages.includes(language);
      });
      if (pattern) return pattern;
    }

    return null;
  }

  /**
   * Merge default patterns with custom patterns.
   * Custom patterns with the same id override defaults.
   */
  private mergePatterns(defaults: SkipPattern[], customs: SkipPattern[]): SkipPattern[] {
    const merged = new Map<string, SkipPattern>();

    for (const pattern of defaults) {
      merged.set(pattern.id, pattern);
    }

    for (const pattern of customs) {
      merged.set(pattern.id, pattern);
    }

    return Array.from(merged.values());
  }
}
