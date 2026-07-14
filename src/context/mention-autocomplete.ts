/**
 * MentionAutocomplete — Suggestion provider for @-mention input.
 *
 * Provides type-ahead suggestions when the user types `@` in the chat input.
 * Sources suggestions from:
 *   - Available mention types (file, folder, url, git-diff, problems, terminal, selection)
 *   - Project file tree (for @file: and @folder: completions)
 *   - Open editors (prioritized in suggestions)
 *   - Recent URLs (for @url: completions)
 *
 * Returns filtered, scored suggestions as the user types characters after `@`.
 *
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 *
 * Requirements: 14.2
 */

import type { MentionType } from './mention-resolver.js';

// ─── Constants ──────────────────────────────────────────────────

/** Maximum number of suggestions to return */
export const MAX_SUGGESTIONS = 15;

/** Score boost for open editors */
export const OPEN_EDITOR_BOOST = 50;

/** Score boost for exact prefix match */
export const EXACT_PREFIX_BOOST = 30;

/** Base score for mention type keywords */
export const MENTION_TYPE_BASE_SCORE = 100;

/** Base score for file/folder suggestions */
export const FILE_BASE_SCORE = 60;

/** Base score for recent URL suggestions */
export const URL_BASE_SCORE = 40;

// ─── Types ──────────────────────────────────────────────────────

/** Category of a suggestion (used for sorting/grouping) */
export type SuggestionCategory = 'mention-type' | 'file' | 'folder' | 'url';

/** A single autocomplete suggestion */
export interface MentionSuggestion {
  /** Display label shown in the dropdown */
  label: string;
  /** The text to insert when this suggestion is accepted */
  insertText: string;
  /** The mention type this suggestion corresponds to */
  type: MentionType;
  /** Category for grouping */
  category: SuggestionCategory;
  /** Relevance score (higher = more relevant), used for sorting */
  score: number;
  /** Optional description shown alongside the label */
  description?: string;
  /** Whether this item is currently open in an editor */
  isOpenEditor?: boolean;
}

/** Describes an available mention type for keyword suggestions */
export interface MentionTypeDescriptor {
  type: MentionType;
  label: string;
  description: string;
  /** Whether this type takes an argument (path, url) */
  takesArgument: boolean;
}

/** Interface for providing open editor paths */
export interface OpenEditorsProvider {
  /** Get the list of currently open file paths (relative to project root) */
  getOpenEditorPaths(): string[];
}

/** Interface for providing the project file tree */
export interface FileTreeProvider {
  /** Get file paths matching a prefix (relative to project root) */
  getFilePaths(prefix: string): string[];
  /** Get folder paths matching a prefix (relative to project root) */
  getFolderPaths(prefix: string): string[];
}

/** Interface for providing recent URLs */
export interface RecentUrlsProvider {
  /** Get the list of recently used URLs */
  getRecentUrls(): string[];
}

// ─── Mention Type Descriptors ───────────────────────────────────

/** All supported mention types with metadata */
export const MENTION_TYPE_DESCRIPTORS: MentionTypeDescriptor[] = [
  {
    type: 'file',
    label: '@file',
    description: 'Reference a file by path',
    takesArgument: true,
  },
  {
    type: 'folder',
    label: '@folder',
    description: 'Reference a folder by path',
    takesArgument: true,
  },
  {
    type: 'url',
    label: '@url',
    description: 'Reference a URL',
    takesArgument: true,
  },
  {
    type: 'git-diff',
    label: '@git-diff',
    description: 'Current git diff',
    takesArgument: false,
  },
  {
    type: 'problems',
    label: '@problems',
    description: 'Workspace diagnostics',
    takesArgument: false,
  },
  {
    type: 'terminal',
    label: '@terminal',
    description: 'Terminal buffer output',
    takesArgument: false,
  },
  {
    type: 'selection',
    label: '@selection',
    description: 'Current editor selection',
    takesArgument: false,
  },
];

// ─── Scoring Utilities ──────────────────────────────────────────

/**
 * Compute a fuzzy match score between a query and a candidate string.
 *
 * Returns 0 if the query is not a subsequence of the candidate.
 * Higher scores indicate better matches (closer to prefix match).
 *
 * @param query - The user's filter text (lowercase)
 * @param candidate - The candidate string to match against (lowercase)
 * @returns A score from 0 (no match) to 100 (perfect prefix match)
 */
export function fuzzyMatchScore(query: string, candidate: string): number {
  if (!query) return 1; // Empty query matches everything with minimal score

  const lowerQuery = query.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();

  // Exact prefix match gets highest score
  if (lowerCandidate.startsWith(lowerQuery)) {
    return 100;
  }

  // Check if candidate contains the query as a substring
  const substringIndex = lowerCandidate.indexOf(lowerQuery);
  if (substringIndex >= 0) {
    // Score inversely proportional to position (earlier = better)
    return Math.max(10, 80 - substringIndex * 5);
  }

  // Fuzzy subsequence match
  let queryIdx = 0;
  let consecutiveMatches = 0;
  let maxConsecutive = 0;
  let matchCount = 0;

  for (let i = 0; i < lowerCandidate.length && queryIdx < lowerQuery.length; i++) {
    if (lowerCandidate[i] === lowerQuery[queryIdx]) {
      queryIdx++;
      matchCount++;
      consecutiveMatches++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveMatches);
    } else {
      consecutiveMatches = 0;
    }
  }

  // All query characters must be matched (subsequence requirement)
  if (queryIdx < lowerQuery.length) {
    return 0;
  }

  // Score based on: consecutive matches + ratio of matched chars to total
  const consecutiveScore = (maxConsecutive / lowerQuery.length) * 40;
  const ratioScore = (matchCount / lowerCandidate.length) * 20;

  return Math.round(Math.max(1, consecutiveScore + ratioScore));
}

// ─── MentionAutocomplete ────────────────────────────────────────

/**
 * MentionAutocomplete — Provides filtered, scored suggestions for @-mention input.
 *
 * Lazy-initialized singleton that sources suggestions from:
 * - Available mention type keywords
 * - Project file tree
 * - Open editors (boosted score)
 * - Recent URLs
 *
 * Requirement: 14.2
 */
export class MentionAutocomplete {
  private static instance: MentionAutocomplete | null = null;

  private openEditorsProvider: OpenEditorsProvider | null = null;
  private fileTreeProvider: FileTreeProvider | null = null;
  private recentUrlsProvider: RecentUrlsProvider | null = null;

  private constructor() {}

  /** Get or create the singleton instance */
  static getInstance(): MentionAutocomplete {
    if (!MentionAutocomplete.instance) {
      MentionAutocomplete.instance = new MentionAutocomplete();
    }
    return MentionAutocomplete.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    MentionAutocomplete.instance = null;
  }

  // ─── Dependency Injection ─────────────────────────────────────

  /** Inject the open editors provider */
  setOpenEditorsProvider(provider: OpenEditorsProvider): void {
    this.openEditorsProvider = provider;
  }

  /** Inject the file tree provider */
  setFileTreeProvider(provider: FileTreeProvider): void {
    this.fileTreeProvider = provider;
  }

  /** Inject the recent URLs provider */
  setRecentUrlsProvider(provider: RecentUrlsProvider): void {
    this.recentUrlsProvider = provider;
  }

  // ─── Core Suggestion Logic ────────────────────────────────────

  /**
   * Get autocomplete suggestions for the current @-mention input.
   *
   * The query represents what the user has typed after `@`. For example:
   * - `""` → show all mention types
   * - `"fi"` → filter to @file and related suggestions
   * - `"file:"` → show file path completions
   * - `"file:src/u"` → filter file paths by prefix
   *
   * @param query - Text typed after `@` (e.g., "file:src/m")
   * @returns Sorted array of suggestions, limited to MAX_SUGGESTIONS
   */
  getSuggestions(query: string): MentionSuggestion[] {
    const suggestions: MentionSuggestion[] = [];

    // Determine what kind of suggestions to provide
    const colonIndex = query.indexOf(':');

    if (colonIndex === -1) {
      // No colon yet — suggest mention types + keyword mentions that match
      suggestions.push(...this.getMentionTypeSuggestions(query));

      // Also include some file/folder suggestions from open editors if query is short
      if (query.length <= 3) {
        suggestions.push(...this.getOpenEditorSuggestions(query));
      }
    } else {
      // Colon present — user is typing an argument for a specific type
      const mentionType = query.slice(0, colonIndex);
      const argument = query.slice(colonIndex + 1);

      switch (mentionType) {
        case 'file':
          suggestions.push(...this.getFileSuggestions(argument));
          break;
        case 'folder':
          suggestions.push(...this.getFolderSuggestions(argument));
          break;
        case 'url':
          suggestions.push(...this.getUrlSuggestions(argument));
          break;
        default:
          // Unknown type prefix, show matching mention types
          suggestions.push(...this.getMentionTypeSuggestions(query));
      }
    }

    // Sort by score (descending) and limit results
    return suggestions
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS);
  }

  // ─── Suggestion Generators ────────────────────────────────────

  /**
   * Generate mention type keyword suggestions filtered by query.
   *
   * @param query - Filter text (e.g., "fi" matches "file", "git" matches "git-diff")
   */
  private getMentionTypeSuggestions(query: string): MentionSuggestion[] {
    const suggestions: MentionSuggestion[] = [];

    for (const descriptor of MENTION_TYPE_DESCRIPTORS) {
      // Match against the type name (without @) and the label
      const matchScore = fuzzyMatchScore(query, descriptor.type);

      if (matchScore > 0) {
        const insertText = descriptor.takesArgument
          ? `${descriptor.type}:`
          : descriptor.type;

        suggestions.push({
          label: descriptor.label,
          insertText,
          type: descriptor.type,
          category: 'mention-type',
          score: MENTION_TYPE_BASE_SCORE + matchScore,
          description: descriptor.description,
        });
      }
    }

    return suggestions;
  }

  /**
   * Generate file path suggestions for @file: completions.
   *
   * Boosts open editor files in the results.
   *
   * @param pathPrefix - The path prefix typed after "@file:" (e.g., "src/u")
   */
  private getFileSuggestions(pathPrefix: string): MentionSuggestion[] {
    const suggestions: MentionSuggestion[] = [];
    const openPaths = new Set(this.openEditorsProvider?.getOpenEditorPaths() ?? []);

    // Get matching files from file tree
    const filePaths = this.fileTreeProvider?.getFilePaths(pathPrefix) ?? [];

    for (const filePath of filePaths) {
      const matchScore = pathPrefix
        ? fuzzyMatchScore(pathPrefix, filePath)
        : 1;

      if (matchScore > 0) {
        const isOpen = openPaths.has(filePath);
        const score = FILE_BASE_SCORE + matchScore + (isOpen ? OPEN_EDITOR_BOOST : 0);

        suggestions.push({
          label: filePath,
          insertText: `file:${filePath}`,
          type: 'file',
          category: 'file',
          score,
          description: isOpen ? 'Open in editor' : undefined,
          isOpenEditor: isOpen,
        });
      }
    }

    // Also add open editor files not already found in file tree results
    for (const openPath of openPaths) {
      if (!filePaths.includes(openPath)) {
        const matchScore = pathPrefix
          ? fuzzyMatchScore(pathPrefix, openPath)
          : 1;

        if (matchScore > 0) {
          suggestions.push({
            label: openPath,
            insertText: `file:${openPath}`,
            type: 'file',
            category: 'file',
            score: FILE_BASE_SCORE + matchScore + OPEN_EDITOR_BOOST,
            description: 'Open in editor',
            isOpenEditor: true,
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Generate folder path suggestions for @folder: completions.
   *
   * @param pathPrefix - The path prefix typed after "@folder:" (e.g., "src/")
   */
  private getFolderSuggestions(pathPrefix: string): MentionSuggestion[] {
    const suggestions: MentionSuggestion[] = [];
    const folderPaths = this.fileTreeProvider?.getFolderPaths(pathPrefix) ?? [];

    for (const folderPath of folderPaths) {
      const matchScore = pathPrefix
        ? fuzzyMatchScore(pathPrefix, folderPath)
        : 1;

      if (matchScore > 0) {
        suggestions.push({
          label: folderPath,
          insertText: `folder:${folderPath}`,
          type: 'folder',
          category: 'folder',
          score: FILE_BASE_SCORE + matchScore,
        });
      }
    }

    return suggestions;
  }

  /**
   * Generate URL suggestions for @url: completions from recent URLs.
   *
   * @param urlPrefix - The URL prefix typed after "@url:" (e.g., "https://")
   */
  private getUrlSuggestions(urlPrefix: string): MentionSuggestion[] {
    const suggestions: MentionSuggestion[] = [];
    const recentUrls = this.recentUrlsProvider?.getRecentUrls() ?? [];

    for (const url of recentUrls) {
      const matchScore = urlPrefix
        ? fuzzyMatchScore(urlPrefix, url)
        : 1;

      if (matchScore > 0) {
        suggestions.push({
          label: url,
          insertText: `url:${url}`,
          type: 'url',
          category: 'url',
          score: URL_BASE_SCORE + matchScore,
          description: 'Recent URL',
        });
      }
    }

    return suggestions;
  }

  /**
   * Generate suggestions from open editors (shown when query is empty or short).
   *
   * These appear as quick-access file suggestions without the user needing
   * to type "file:" first.
   *
   * @param query - The current filter text
   */
  private getOpenEditorSuggestions(query: string): MentionSuggestion[] {
    const suggestions: MentionSuggestion[] = [];
    const openPaths = this.openEditorsProvider?.getOpenEditorPaths() ?? [];

    for (const filePath of openPaths) {
      // Match against filename (last segment) for short queries
      const fileName = filePath.split('/').pop() ?? filePath;
      const matchScore = query
        ? fuzzyMatchScore(query, fileName)
        : 1;

      if (matchScore > 0) {
        suggestions.push({
          label: filePath,
          insertText: `file:${filePath}`,
          type: 'file',
          category: 'file',
          score: FILE_BASE_SCORE + matchScore + OPEN_EDITOR_BOOST,
          description: 'Open in editor',
          isOpenEditor: true,
        });
      }
    }

    return suggestions;
  }
}
