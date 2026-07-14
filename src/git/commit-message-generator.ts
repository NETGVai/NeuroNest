/**
 * CommitMessageGenerator — LLM-based git commit message generation from staged changes.
 *
 * Analyzes the git diff of staged changes and produces a conventional commit message
 * (type(scope): description) with appropriate type detection, scope inference, and
 * multi-line body generation for larger commits.
 *
 * Integration:
 * - Uses Provider Registry 'fast' tier for cost efficiency (Req 7.6)
 * - Respects `.neuronest/commit-conventions.md` for project-specific rules (Req 7.7)
 * - Feature-gated behind `commit_message_gen` flag
 * - Follows NeuroNest's lazy-initialized TypeScript singleton pattern
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

/** Conventional commit types (Req 7.2) */
export type CommitType = 'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore' | 'style' | 'perf';

/** Parsed diff information for a single file */
export interface FileDiffInfo {
  /** File path relative to repo root */
  filePath: string;
  /** Type of file change */
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
}

/** Result of analyzing a git diff */
export interface DiffAnalysis {
  /** Individual file diffs */
  files: FileDiffInfo[];
  /** Total files changed */
  totalFiles: number;
  /** Total lines added */
  totalAdditions: number;
  /** Total lines deleted */
  totalDeletions: number;
  /** Raw diff text (truncated if needed) */
  rawDiff: string;
}

/** Generated commit message structure */
export interface CommitMessage {
  /** Full commit message (subject + optional body) */
  full: string;
  /** Subject line: type(scope): description */
  subject: string;
  /** Detected commit type */
  type: CommitType;
  /** Inferred scope */
  scope: string;
  /** Description text */
  description: string;
  /** Optional multi-line body (for 6+ files) */
  body?: string;
}

/** Configuration for the CommitMessageGenerator */
export interface CommitMessageGeneratorConfig {
  /** Working directory (project root) */
  cwd: string;
  /** Maximum diff size in characters to send to LLM */
  maxDiffSize: number;
  /** Whether to generate multi-line body for large commits (>5 files) */
  generateBody: boolean;
}

/** LLM client interface for generating commit messages (Req 7.6 — fast tier) */
export interface CommitLLMClient {
  chat(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { temperature?: number; maxTokens?: number }
  ): Promise<{ content: string }>;
}

/** Interface for git operations (thin wrapper for testability) */
export interface GitClient {
  /** Get the diff of staged changes */
  getStagedDiff(cwd: string): string;
  /** Get the stat summary of staged changes */
  getStagedDiffStat(cwd: string): string;
  /** Get list of staged files with their status */
  getStagedFiles(cwd: string): Array<{ status: string; path: string }>;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default configuration */
export const DEFAULT_CONFIG: CommitMessageGeneratorConfig = {
  cwd: process.cwd(),
  maxDiffSize: 8000,
  generateBody: true,
};

/** Threshold for generating multi-line body (Req 7.4: more than 5 files = 6+) */
export const MULTI_LINE_BODY_THRESHOLD = 5;

/** Path for project-specific conventions file (Req 7.7) */
export const CONVENTIONS_FILE = '.neuronest/commit-conventions.md';

/** Maximum diff characters to send to LLM */
const MAX_DIFF_CHARS = 8000;

// ─── Heuristic Patterns for Commit Type Detection ───────────────

/**
 * Patterns used to detect commit type from diff content (Req 7.2).
 * Ordered by specificity — first match wins.
 */
const TYPE_DETECTION_PATTERNS: Array<{ type: CommitType; patterns: RegExp[] }> = [
  {
    type: 'test',
    patterns: [
      /\.(test|spec|e2e)\.(ts|js|tsx|jsx|py|go|rs)$/m,
      /\b(describe|it|test|expect|assert|mock|jest|vitest|pytest|testing)\b/,
      /__tests__\//,
      /\btests?\//,
    ],
  },
  {
    type: 'docs',
    patterns: [
      /\.(md|mdx|txt|rst|adoc)$/m,
      /\bdocs?\//,
      /README/i,
      /CHANGELOG/i,
      /\bJSDoc\b|\b@param\b|\b@returns\b/,
    ],
  },
  {
    type: 'style',
    patterns: [
      /\.(css|scss|sass|less|styl)$/m,
      /\.(prettierrc|eslintrc|stylelint)/,
      /formatting|whitespace|indent/i,
    ],
  },
  {
    type: 'perf',
    patterns: [
      /\b(performance|optimize|cache|memoize|lazy|debounce|throttle|batch)\b/i,
      /\bbench(mark)?\b/i,
      /\b(O\(n\)|O\(1\)|O\(log\)|complexity)\b/,
    ],
  },
  {
    type: 'fix',
    patterns: [
      /\bfix(es|ed)?\b/i,
      /\bbug\b/i,
      /\berror\b.*\b(handle|catch|throw)\b/i,
      /\b(patch|hotfix|resolve)\b/i,
      /\bnull\s*check\b/i,
      /\bundefined\b.*\bcheck\b/i,
    ],
  },
  {
    type: 'refactor',
    patterns: [
      /\brefactor\b/i,
      /\b(rename|move|extract|inline|reorganize)\b/i,
      /\b(restructure|simplify|cleanup|clean-up)\b/i,
    ],
  },
  {
    type: 'chore',
    patterns: [
      /\b(package\.json|yarn\.lock|package-lock|pnpm-lock)\b/,
      /\.(gitignore|npmignore|dockerignore|editorconfig)\b/,
      /\b(Dockerfile|docker-compose|Makefile|Jenkinsfile)\b/,
      /\bCI\b|\b(github\/workflows|\.circleci|\.travis)\b/,
      /\b(deps|dependencies|devDependencies)\b/,
    ],
  },
];

// ─── Default Git Client ─────────────────────────────────────────

/**
 * Default git client using child_process execSync.
 * Provides a thin wrapper around git commands for testability.
 */
export class DefaultGitClient implements GitClient {
  getStagedDiff(cwd: string): string {
    try {
      return execSync('git diff --cached', { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch {
      return '';
    }
  }

  getStagedDiffStat(cwd: string): string {
    try {
      return execSync('git diff --cached --stat', { cwd, encoding: 'utf-8' });
    } catch {
      return '';
    }
  }

  getStagedFiles(cwd: string): Array<{ status: string; path: string }> {
    try {
      const output = execSync('git diff --cached --name-status', { cwd, encoding: 'utf-8' });
      return output
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [status = '', ...pathParts] = line.split('\t');
          return { status: status.trim(), path: pathParts.join('\t').trim() };
        });
    } catch {
      return [];
    }
  }
}

// ─── System Prompt ──────────────────────────────────────────────

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are a git commit message generator. Given a diff of staged changes, produce a conventional commit message.

Format: type(scope): description

Rules:
1. Type MUST be one of: feat, fix, refactor, docs, test, chore, style, perf
2. Scope should be the most-affected module or directory (without path separators)
3. Description should be a concise imperative statement (lowercase, no period)
4. Keep the subject line under 72 characters total
5. Output ONLY the commit message — no explanation, no markdown fences`;

const COMMIT_MESSAGE_BODY_PROMPT = `You are a git commit message generator. Given a diff of staged changes affecting many files, produce a conventional commit message WITH a multi-line body.

Format:
type(scope): description

- Summary point 1
- Summary point 2
- Summary point 3

Rules:
1. Type MUST be one of: feat, fix, refactor, docs, test, chore, style, perf
2. Scope should be the most-affected module or directory (without path separators)
3. Description should be a concise imperative statement (lowercase, no period)
4. Keep the subject line under 72 characters total
5. The body should have 2-5 bullet points summarizing the key changes
6. Leave a blank line between the subject and body
7. Output ONLY the commit message — no explanation, no markdown fences`;

// ─── CommitMessageGenerator Class ───────────────────────────────

/**
 * CommitMessageGenerator — Analyzes staged git changes and generates
 * conventional commit messages using LLM inference.
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7
 */
export class CommitMessageGenerator {
  private static instance: CommitMessageGenerator | null = null;

  private config: CommitMessageGeneratorConfig;
  private llmClient: CommitLLMClient | null = null;
  private gitClient: GitClient;

  private constructor(config?: Partial<CommitMessageGeneratorConfig>, gitClient?: GitClient) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.gitClient = gitClient ?? new DefaultGitClient();
  }

  /** Get or create the singleton instance */
  static getInstance(
    config?: Partial<CommitMessageGeneratorConfig>,
    gitClient?: GitClient
  ): CommitMessageGenerator {
    if (!CommitMessageGenerator.instance) {
      CommitMessageGenerator.instance = new CommitMessageGenerator(config, gitClient);
    }
    return CommitMessageGenerator.instance;
  }

  /** Reset the singleton (used in testing) */
  static resetInstance(): void {
    CommitMessageGenerator.instance = null;
  }

  /** Set the LLM client (injected at runtime from fast tier) */
  setLLMClient(client: CommitLLMClient | null): void {
    this.llmClient = client;
  }

  /** Set the git client (for testing) */
  setGitClient(client: GitClient): void {
    this.gitClient = client;
  }

  /** Update configuration */
  updateConfig(config: Partial<CommitMessageGeneratorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Generate a commit message from the currently staged changes.
   *
   * Flow:
   * 1. Extract staged diff via git
   * 2. Analyze diff to detect type, scope, and file count
   * 3. Load project conventions if present (Req 7.7)
   * 4. Generate message via LLM with appropriate prompt
   * 5. Parse and validate the result
   *
   * @returns Generated commit message, or null if no staged changes
   * @throws Error if LLM client is not configured
   *
   * Requirements: 7.1, 7.2, 7.3, 7.4, 7.6, 7.7
   */
  async generate(): Promise<CommitMessage | null> {
    // Step 1: Extract staged diff
    const analysis = this.analyzeStagedDiff();
    if (analysis.totalFiles === 0) {
      return null;
    }

    // Step 2: Detect type and scope from diff heuristics
    const detectedType = this.detectCommitType(analysis);
    const inferredScope = this.inferScope(analysis);

    // Step 3: If no LLM client, fall back to heuristic-only generation
    if (!this.llmClient) {
      return this.generateHeuristicMessage(analysis, detectedType, inferredScope);
    }

    // Step 4: Load project conventions (Req 7.7)
    const conventions = this.loadConventions();

    // Step 5: Generate via LLM
    const needsBody = this.config.generateBody && analysis.totalFiles > MULTI_LINE_BODY_THRESHOLD;
    const message = await this.generateWithLLM(analysis, conventions, needsBody);

    return message;
  }

  /**
   * Analyze the currently staged diff without generating a message.
   * Useful for UI preview (show file count, type hint).
   */
  getDiffAnalysis(): DiffAnalysis {
    return this.analyzeStagedDiff();
  }

  /**
   * Detect the commit type from a diff analysis (Req 7.2).
   * Exposed for testing and UI type suggestions.
   */
  detectCommitType(analysis: DiffAnalysis): CommitType {
    const { files, rawDiff } = analysis;

    // Check file paths and diff content against patterns
    const combinedContent = files.map(f => f.filePath).join('\n') + '\n' + rawDiff;

    for (const { type, patterns } of TYPE_DETECTION_PATTERNS) {
      for (const pattern of patterns) {
        if (pattern.test(combinedContent)) {
          return type;
        }
      }
    }

    // Default: if mostly additions → feat; if mixed → refactor
    const addRatio = analysis.totalAdditions / Math.max(1, analysis.totalAdditions + analysis.totalDeletions);
    if (addRatio > 0.8) return 'feat';
    if (addRatio < 0.3) return 'fix';
    return 'refactor';
  }

  /**
   * Infer the commit scope from affected files (Req 7.3).
   * Returns the most common parent directory or module name.
   */
  inferScope(analysis: DiffAnalysis): string {
    const { files } = analysis;
    if (files.length === 0) return 'root';

    // Count occurrences of each top-level directory or module
    const dirCounts = new Map<string, number>();
    for (const file of files) {
      const scope = this.extractScopeFromPath(file.filePath);
      dirCounts.set(scope, (dirCounts.get(scope) || 0) + 1);
    }

    // Return the most-affected directory
    let maxCount = 0;
    let maxScope = 'root';
    for (const [scope, count] of dirCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxScope = scope;
      }
    }

    return maxScope;
  }

  // ─── Private Methods ──────────────────────────────────────────────

  /**
   * Analyze the staged diff to extract file info and statistics.
   */
  private analyzeStagedDiff(): DiffAnalysis {
    const cwd = this.config.cwd;
    const stagedFiles = this.gitClient.getStagedFiles(cwd);
    const rawDiff = this.gitClient.getStagedDiff(cwd);

    if (stagedFiles.length === 0) {
      return { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, rawDiff: '' };
    }

    // Parse file changes
    const files: FileDiffInfo[] = stagedFiles.map(({ status, path }) => {
      const changeType = this.mapGitStatus(status);
      const { additions, deletions } = this.countLinesForFile(rawDiff, path);
      return { filePath: path, changeType, additions, deletions };
    });

    const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    // Truncate raw diff if it exceeds max size
    const truncatedDiff = rawDiff.length > MAX_DIFF_CHARS
      ? rawDiff.slice(0, MAX_DIFF_CHARS) + '\n... (diff truncated)'
      : rawDiff;

    return {
      files,
      totalFiles: files.length,
      totalAdditions,
      totalDeletions,
      rawDiff: truncatedDiff,
    };
  }

  /**
   * Map git status letter to a friendly change type.
   */
  private mapGitStatus(status: string): FileDiffInfo['changeType'] {
    switch (status.charAt(0)) {
      case 'A': return 'added';
      case 'D': return 'deleted';
      case 'R': return 'renamed';
      case 'M':
      default: return 'modified';
    }
  }

  /**
   * Count added/deleted lines for a specific file within a raw diff.
   */
  private countLinesForFile(rawDiff: string, filePath: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    let inFile = false;

    const lines = rawDiff.split('\n');
    for (const line of lines) {
      // Detect diff header for this file
      if (line.startsWith('diff --git')) {
        inFile = line.includes(filePath);
        continue;
      }
      if (!inFile) continue;

      // Count additions and deletions (skip hunk headers)
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    return { additions, deletions };
  }

  /**
   * Extract a scope name from a file path (Req 7.3).
   * Uses the first meaningful directory as scope.
   */
  private extractScopeFromPath(filePath: string): string {
    const parts = filePath.split('/').filter(p => p.length > 0);

    // Skip the 'src' prefix if present — scope comes from the next level
    if (parts[0] === 'src' && parts.length > 1) {
      return parts[1] ?? 'root';
    }

    // For top-level files (e.g., package.json), use 'root'
    if (parts.length === 1) {
      return 'root';
    }

    return parts[0] ?? 'root';
  }

  /**
   * Load project-specific commit conventions from `.neuronest/commit-conventions.md` (Req 7.7).
   * Returns null if the file doesn't exist.
   */
  private loadConventions(): string | null {
    const conventionsPath = join(this.config.cwd, CONVENTIONS_FILE);
    if (!existsSync(conventionsPath)) {
      return null;
    }

    try {
      const content = readFileSync(conventionsPath, 'utf-8');
      // Limit conventions to reasonable size
      return content.length > 2000 ? content.slice(0, 2000) + '\n...(truncated)' : content;
    } catch {
      return null;
    }
  }

  /**
   * Generate commit message using LLM (Req 7.1, 7.6).
   */
  private async generateWithLLM(
    analysis: DiffAnalysis,
    conventions: string | null,
    needsBody: boolean
  ): Promise<CommitMessage> {
    const systemPrompt = needsBody ? COMMIT_MESSAGE_BODY_PROMPT : COMMIT_MESSAGE_SYSTEM_PROMPT;

    // Build user prompt with diff and optional conventions
    let userPrompt = '';
    if (conventions) {
      userPrompt += `Project commit conventions:\n${conventions}\n\n`;
    }
    userPrompt += `Files changed (${analysis.totalFiles}):\n`;
    for (const file of analysis.files) {
      userPrompt += `  ${file.changeType}: ${file.filePath} (+${file.additions}/-${file.deletions})\n`;
    }
    userPrompt += `\nDiff:\n${analysis.rawDiff}`;

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    try {
      const response = await this.llmClient!.chat(messages, {
        temperature: 0.3,
        maxTokens: 256,
      });

      const rawMessage = response.content?.trim();
      if (!rawMessage) {
        // Fall back to heuristic if LLM returns empty
        return this.generateHeuristicMessage(
          analysis,
          this.detectCommitType(analysis),
          this.inferScope(analysis)
        );
      }

      return this.parseCommitMessage(rawMessage, analysis);
    } catch {
      // LLM failure is non-blocking — fall back to heuristics
      return this.generateHeuristicMessage(
        analysis,
        this.detectCommitType(analysis),
        this.inferScope(analysis)
      );
    }
  }

  /**
   * Parse an LLM-generated commit message into structured form.
   */
  private parseCommitMessage(raw: string, analysis: DiffAnalysis): CommitMessage {
    const lines = raw.split('\n');
    const subject = (lines[0] ?? '').trim();

    // Parse type(scope): description from subject
    const conventionalMatch = subject.match(/^(\w+)\(([^)]+)\):\s*(.+)$/);
    if (conventionalMatch) {
      const typeStr = conventionalMatch[1] ?? '';
      const scope = conventionalMatch[2] ?? '';
      const description = conventionalMatch[3] ?? '';
      const type = this.validateType(typeStr);
      const bodyText = lines.length > 2 ? lines.slice(2).join('\n').trim() : '';

      const result: CommitMessage = {
        full: raw.trim(),
        subject,
        type,
        scope,
        description,
      };
      if (bodyText) {
        result.body = bodyText;
      }
      return result;
    }

    // If the LLM didn't produce proper conventional format, parse best-effort
    const type = this.detectCommitType(analysis);
    const scope = this.inferScope(analysis);
    const description = subject.replace(/^[\w]+(\([^)]*\))?:\s*/, '').toLowerCase();
    const bodyText = lines.length > 2 ? lines.slice(2).join('\n').trim() : '';

    const formattedSubject = `${type}(${scope}): ${description || 'update code'}`;
    const full = bodyText ? `${formattedSubject}\n\n${bodyText}` : formattedSubject;

    const result: CommitMessage = {
      full,
      subject: formattedSubject,
      type,
      scope,
      description: description || 'update code',
    };
    if (bodyText) {
      result.body = bodyText;
    }
    return result;
  }

  /**
   * Validate a string as a commit type, defaulting to 'chore' if unknown.
   */
  private validateType(typeStr: string): CommitType {
    const validTypes: CommitType[] = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'style', 'perf'];
    const lower = typeStr.toLowerCase() as CommitType;
    return validTypes.includes(lower) ? lower : 'chore';
  }

  /**
   * Generate a commit message using only heuristics (no LLM).
   * Used as fallback when LLM is unavailable.
   */
  private generateHeuristicMessage(
    analysis: DiffAnalysis,
    type: CommitType,
    scope: string
  ): CommitMessage {
    // Build a simple description from the file changes
    const description = this.buildHeuristicDescription(analysis, type);
    const subject = `${type}(${scope}): ${description}`;

    // Generate body if many files changed (Req 7.4)
    const bodyText = (this.config.generateBody && analysis.totalFiles > MULTI_LINE_BODY_THRESHOLD)
      ? this.buildHeuristicBody(analysis)
      : '';

    const full = bodyText ? `${subject}\n\n${bodyText}` : subject;

    const result: CommitMessage = { full, subject, type, scope, description };
    if (bodyText) {
      result.body = bodyText;
    }
    return result;
  }

  /**
   * Build a description string from heuristics.
   */
  private buildHeuristicDescription(analysis: DiffAnalysis, type: CommitType): string {
    const { files, totalFiles } = analysis;
    if (totalFiles === 1 && files[0]) {
      const file = files[0];
      const name = basename(file.filePath, '.ts').replace(/\./g, ' ');
      switch (type) {
        case 'feat': return `add ${name}`;
        case 'fix': return `fix ${name}`;
        case 'docs': return `update ${name} documentation`;
        case 'test': return `add tests for ${name}`;
        case 'style': return `format ${name}`;
        case 'perf': return `optimize ${name}`;
        case 'refactor': return `refactor ${name}`;
        case 'chore': return `update ${name}`;
        default: return `update ${name}`;
      }
    }

    return `update ${totalFiles} files`;
  }

  /**
   * Build a multi-line body summarizing changes for large commits (Req 7.4).
   */
  private buildHeuristicBody(analysis: DiffAnalysis): string {
    const lines: string[] = [];
    const added = analysis.files.filter(f => f.changeType === 'added');
    const modified = analysis.files.filter(f => f.changeType === 'modified');
    const deleted = analysis.files.filter(f => f.changeType === 'deleted');

    if (added.length > 0) {
      lines.push(`- Add ${added.length} new file${added.length > 1 ? 's' : ''}`);
    }
    if (modified.length > 0) {
      lines.push(`- Modify ${modified.length} existing file${modified.length > 1 ? 's' : ''}`);
    }
    if (deleted.length > 0) {
      lines.push(`- Remove ${deleted.length} file${deleted.length > 1 ? 's' : ''}`);
    }
    lines.push(`- Total: +${analysis.totalAdditions}/-${analysis.totalDeletions} lines`);

    return lines.join('\n');
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Interface for feature gate dependency injection.
 */
export interface FeatureGateCheck {
  isEnabled(feature: string): boolean;
}

/**
 * Factory function to create a CommitMessageGenerator for use in the pipeline.
 *
 * Resolves the cheapest-tier LLM client via the tier-router and configures
 * the generator based on feature gate state (Req 7.6).
 *
 * @param featureGate - Feature gate system to check `commit_message_gen` flag
 * @param llmClient - LLM client configured for 'fast' (cheapest) tier
 * @param config - Optional configuration overrides
 * @returns A configured CommitMessageGenerator, or null if the feature is disabled
 */
export function createCommitMessageGenerator(
  featureGate: FeatureGateCheck | null,
  llmClient: CommitLLMClient | null,
  config?: Partial<CommitMessageGeneratorConfig>,
): CommitMessageGenerator | null {
  const isEnabled = featureGate?.isEnabled('commit_message_gen') ?? false;

  if (!isEnabled) {
    return null;
  }

  const generator = CommitMessageGenerator.getInstance(config);
  generator.setLLMClient(llmClient);
  return generator;
}
