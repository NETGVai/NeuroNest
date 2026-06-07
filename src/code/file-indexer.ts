/**
 * FileIndexer — Project file indexing with .gitignore filtering.
 *
 * Stub implementation with in-memory state. Indexes project files
 * respecting .gitignore rules, supports incremental re-indexing.
 *
 * Requirements: 12.1, 12.6, 12.7, 22.5
 */

// ─── Types ──────────────────────────────────────────────────────

export interface IndexedFile {
  path: string;
  relativePath: string;
  size: number;
  lastModified: Date;
  language?: string;
}

export interface GitignoreRule {
  pattern: string;
  negated: boolean;
}

// ─── Gitignore pattern matching ─────────────────────────────────

/**
 * Parse a .gitignore file content into rules.
 */
export function parseGitignore(content: string): GitignoreRule[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((pattern) => {
      const negated = pattern.startsWith('!');
      return { pattern: negated ? pattern.slice(1) : pattern, negated };
    });
}

/**
 * Check if a file path matches a gitignore pattern.
 * Supports: *, **, /, directory patterns.
 */
export function matchesGitignorePattern(filePath: string, pattern: string): boolean {
  // Normalize path separators
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Remove leading slash from pattern (anchored to root)
  const cleanPattern = normalizedPattern.startsWith('/')
    ? normalizedPattern.slice(1)
    : normalizedPattern;

  // Directory pattern (ends with /)
  const isDirPattern = cleanPattern.endsWith('/');
  const matchPattern = isDirPattern ? cleanPattern.slice(0, -1) : cleanPattern;

  // Convert gitignore glob to regex
  const regexStr = matchPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  // Match against full path or any path segment
  const regex = new RegExp(`(^|/)${regexStr}($|/)`, 'i');
  return regex.test(normalizedPath);
}

/**
 * Check if a file should be ignored based on gitignore rules.
 */
export function isIgnored(filePath: string, rules: GitignoreRule[]): boolean {
  let ignored = false;

  for (const rule of rules) {
    if (matchesGitignorePattern(filePath, rule.pattern)) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

// ─── FileIndexer ────────────────────────────────────────────────

export class FileIndexer {
  private index = new Map<string, IndexedFile>();
  private gitignoreRules: GitignoreRule[] = [];
  private projectDir: string = '';

  /**
   * Set the project directory and gitignore rules.
   */
  configure(projectDir: string, gitignoreContent?: string): void {
    this.projectDir = projectDir;
    if (gitignoreContent) {
      this.gitignoreRules = parseGitignore(gitignoreContent);
    }
  }

  /**
   * Index a list of file paths, filtering out ignored files.
   * Requirements: 12.1, 12.6
   */
  indexFiles(files: Array<{ path: string; size: number; lastModified: Date }>): IndexedFile[] {
    const indexed: IndexedFile[] = [];

    for (const file of files) {
      const relativePath = file.path.startsWith(this.projectDir)
        ? file.path.slice(this.projectDir.length).replace(/^\//, '')
        : file.path;

      if (isIgnored(relativePath, this.gitignoreRules)) {
        continue;
      }

      const entry: IndexedFile = {
        path: file.path,
        relativePath,
        size: file.size,
        lastModified: file.lastModified,
        language: detectLanguage(relativePath),
      };

      this.index.set(relativePath, entry);
      indexed.push(entry);
    }

    return indexed;
  }

  /**
   * Incremental re-index: update only changed files.
   * Requirements: 22.5
   */
  reindexChanged(changedFiles: Array<{ path: string; size: number; lastModified: Date }>): IndexedFile[] {
    return this.indexFiles(changedFiles);
  }

  /**
   * Get all indexed files.
   */
  getIndexedFiles(): IndexedFile[] {
    return Array.from(this.index.values());
  }

  /**
   * Search indexed files by path pattern.
   */
  search(query: string): IndexedFile[] {
    const lower = query.toLowerCase();
    return this.getIndexedFiles().filter(
      (f) => f.relativePath.toLowerCase().includes(lower),
    );
  }

  /**
   * Get the gitignore rules.
   */
  getGitignoreRules(): GitignoreRule[] {
    return [...this.gitignoreRules];
  }

  /**
   * Clear the index.
   */
  clear(): void {
    this.index.clear();
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function detectLanguage(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go',
    swift: 'swift', java: 'java', c: 'c',
    cpp: 'cpp', h: 'c', hpp: 'cpp',
    md: 'markdown', json: 'json', yaml: 'yaml',
    yml: 'yaml', html: 'html', css: 'css',
  };
  return ext ? langMap[ext] : undefined;
}
