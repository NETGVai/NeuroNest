/**
 * ReviewComments — Inline comment generation and GitHub PR posting.
 *
 * Maps review findings from the CodeReviewPipeline to specific line ranges
 * in diffs, formats them as inline comments with severity badges, explanations,
 * and code suggestions, and optionally posts them to GitHub PRs via the REST API.
 *
 * Integration:
 * - Uses ReviewFinding type from review-pipeline.ts
 * - Feature-gated behind `code_review_pipeline` flag
 * - Follows NeuroNest's lazy-initialized TypeScript singleton pattern
 * - Uses native fetch (no Octokit dependency) for GitHub API
 *
 * Requirements: 4.3, 4.4
 */

import type { ReviewFinding, ReviewSeverity, ReviewCategory } from './review-pipeline.js';

// ─── Types ──────────────────────────────────────────────────────

/** A formatted inline comment ready for display or posting */
export interface InlineComment {
  /** Unique identifier (matches the finding ID) */
  id: string;
  /** File path relative to the repository root */
  filePath: string;
  /** Start line in the diff */
  startLine: number;
  /** End line in the diff */
  endLine: number;
  /** Severity of the finding */
  severity: ReviewSeverity;
  /** Category of the finding */
  category: ReviewCategory;
  /** Formatted comment body (Markdown) */
  body: string;
  /** The raw finding this comment was generated from */
  finding: ReviewFinding;
}

/** Options for formatting inline comments */
export interface FormatOptions {
  /** Whether to include code suggestions in the comment body (default: true) */
  includeSuggestions?: boolean;
  /** Whether to include the severity badge (default: true) */
  includeBadge?: boolean;
  /** Maximum length for the suggestion block in characters (default: 2000) */
  maxSuggestionLength?: number;
}

/** GitHub PR comment posting configuration */
export interface GitHubPostConfig {
  /** GitHub personal access token or app token */
  token: string;
  /** Repository in owner/repo format (e.g., "octocat/hello-world") */
  repository: string;
  /** PR number to post comments on */
  prNumber: number;
  /** Commit SHA to anchor comments to (uses latest PR commit if omitted) */
  commitSha?: string;
}

/** Result of posting comments to a GitHub PR */
export interface GitHubPostResult {
  /** Whether the posting was successful */
  success: boolean;
  /** Number of comments posted */
  postedCount: number;
  /** Number of comments that failed to post */
  failedCount: number;
  /** Error messages for failed posts */
  errors: string[];
  /** The review ID from GitHub (if review was created) */
  reviewId?: number;
}

/** A single comment in a GitHub PR review */
interface GitHubReviewComment {
  path: string;
  /** For multi-line comments, this is the start line */
  start_line?: number;
  /** The line in the diff that the comment applies to */
  line: number;
  /** Side of the diff ('RIGHT' for additions, 'LEFT' for deletions) */
  side: 'LEFT' | 'RIGHT';
  /** Start side for multi-line comments */
  start_side?: 'LEFT' | 'RIGHT';
  /** The comment body in Markdown */
  body: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Severity badge emojis for visual distinction */
const SEVERITY_BADGES: Record<ReviewSeverity, string> = {
  critical: '\u{1F6A8}', // 🚨
  warning: '\u{26A0}\u{FE0F}', // ⚠️
  info: '\u{1F4AC}', // 💬
};

/** Severity labels for display */
const SEVERITY_LABELS: Record<ReviewSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

/** Category labels for display */
const CATEGORY_LABELS: Record<ReviewCategory, string> = {
  security: 'Security',
  performance: 'Performance',
  style: 'Style',
  correctness: 'Correctness',
  maintainability: 'Maintainability',
};

/** Default format options */
const DEFAULT_FORMAT_OPTIONS: Required<FormatOptions> = {
  includeSuggestions: true,
  includeBadge: true,
  maxSuggestionLength: 2000,
};

/** GitHub API base URL */
const GITHUB_API_BASE = 'https://api.github.com';

/** User-Agent for GitHub API requests */
const GITHUB_USER_AGENT = 'NeuroNest-CodeReview';

// ─── Comment Formatting (Req 4.3) ──────────────────────────────

/**
 * Format a severity badge string.
 */
export function formatSeverityBadge(severity: ReviewSeverity): string {
  return `${SEVERITY_BADGES[severity]} **${SEVERITY_LABELS[severity]}**`;
}

/**
 * Format a category tag.
 */
export function formatCategoryTag(category: ReviewCategory): string {
  return `\`${CATEGORY_LABELS[category]}\``;
}

/**
 * Format a code suggestion as a GitHub-compatible suggestion block.
 * Uses the ```suggestion syntax that GitHub renders as an applicable suggestion.
 */
export function formatSuggestion(suggestedFix: string, maxLength: number = 2000): string {
  const trimmed = suggestedFix.length > maxLength
    ? suggestedFix.slice(0, maxLength) + '\n... (truncated)'
    : suggestedFix;

  return `\n\n**Suggested fix:**\n\`\`\`suggestion\n${trimmed}\n\`\`\``;
}

/**
 * Format a single ReviewFinding into a Markdown inline comment body.
 *
 * Format:
 * 🚨 **Critical** | `Security`
 *
 * <message>
 *
 * **Suggested fix:**
 * ```suggestion
 * <code>
 * ```
 *
 * Requirement 4.3: Format as inline comments with severity badge, explanation, and code suggestion.
 */
export function formatCommentBody(finding: ReviewFinding, options?: FormatOptions): string {
  const opts = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  const parts: string[] = [];

  // Header with severity badge and category
  if (opts.includeBadge) {
    parts.push(`${formatSeverityBadge(finding.severity)} | ${formatCategoryTag(finding.category)}`);
    parts.push('');
  }

  // Explanation message
  parts.push(finding.message);

  // Code suggestion block
  if (opts.includeSuggestions && finding.suggestedFix) {
    parts.push(formatSuggestion(finding.suggestedFix, opts.maxSuggestionLength));
  }

  return parts.join('\n');
}

/**
 * Map a ReviewFinding to an InlineComment anchored to specific line ranges.
 *
 * Requirement 4.3: Map review findings to specific line ranges in the diff.
 */
export function mapFindingToComment(finding: ReviewFinding, options?: FormatOptions): InlineComment {
  return {
    id: finding.id,
    filePath: finding.filePath,
    startLine: finding.startLine,
    endLine: finding.endLine,
    severity: finding.severity,
    category: finding.category,
    body: formatCommentBody(finding, options),
    finding,
  };
}

/**
 * Map an array of ReviewFindings to InlineComments.
 * Sorts by severity (critical first) then by file path and line number.
 *
 * Requirement 4.3: Map review findings to specific line ranges in the diff.
 */
export function mapFindingsToComments(
  findings: ReviewFinding[],
  options?: FormatOptions,
): InlineComment[] {
  const severityOrder: Record<ReviewSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  const sorted = [...findings].sort((a, b) => {
    // Sort by severity first
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;

    // Then by file path
    const pathDiff = a.filePath.localeCompare(b.filePath);
    if (pathDiff !== 0) return pathDiff;

    // Then by line number
    return a.startLine - b.startLine;
  });

  return sorted.map((finding) => mapFindingToComment(finding, options));
}

// ─── GitHub PR Posting (Req 4.4) ────────────────────────────────

/**
 * Convert an InlineComment to a GitHub review comment structure.
 * Handles both single-line and multi-line comments.
 */
export function toGitHubReviewComment(comment: InlineComment): GitHubReviewComment {
  const isMultiLine = comment.startLine !== comment.endLine && comment.startLine > 0;

  const result: GitHubReviewComment = {
    path: comment.filePath,
    line: comment.endLine,
    side: 'RIGHT',
    body: comment.body,
  };

  if (isMultiLine) {
    result.start_line = comment.startLine;
    result.start_side = 'RIGHT';
  }

  return result;
}

/**
 * Fetch the latest commit SHA for a PR if not provided.
 */
async function fetchLatestPRCommitSha(config: GitHubPostConfig): Promise<string> {
  const url = `${GITHUB_API_BASE}/repos/${config.repository}/pulls/${config.prNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': GITHUB_USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch PR info: ${response.status} ${response.statusText}`);
  }

  const pr = (await response.json()) as { head: { sha: string } };
  return pr.head.sha;
}

/**
 * Create a review with inline comments on a GitHub PR.
 *
 * Uses the GitHub REST API Pull Request Reviews endpoint to batch-submit
 * all comments as a single review. This is more efficient than individual
 * comment posts and groups the feedback together.
 *
 * Requirement 4.4: Support GitHub PR comment posting via REST API when token is configured.
 */
export async function postCommentsToGitHub(
  comments: InlineComment[],
  config: GitHubPostConfig,
): Promise<GitHubPostResult> {
  if (comments.length === 0) {
    return { success: true, postedCount: 0, failedCount: 0, errors: [] };
  }

  try {
    // Resolve the commit SHA
    const commitSha = config.commitSha ?? await fetchLatestPRCommitSha(config);

    // Convert comments to GitHub review comment format
    const reviewComments = comments.map(toGitHubReviewComment);

    // Determine the review event based on severity of findings
    const hasCritical = comments.some((c) => c.severity === 'critical');
    const event = hasCritical ? 'REQUEST_CHANGES' : 'COMMENT';

    // Build the review summary body
    const summary = buildReviewSummary(comments);

    // Create the review with all comments
    const url = `${GITHUB_API_BASE}/repos/${config.repository}/pulls/${config.prNumber}/reviews`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': GITHUB_USER_AGENT,
      },
      body: JSON.stringify({
        commit_id: commitSha,
        body: summary,
        event,
        comments: reviewComments,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // If the batch fails, try posting individual comments as fallback
      if (response.status === 422) {
        return await postCommentsIndividually(comments, config, commitSha);
      }
      return {
        success: false,
        postedCount: 0,
        failedCount: comments.length,
        errors: [`GitHub API error ${response.status}: ${errorBody}`],
      };
    }

    const review = (await response.json()) as { id: number };
    return {
      success: true,
      postedCount: comments.length,
      failedCount: 0,
      errors: [],
      reviewId: review.id,
    };
  } catch (err) {
    return {
      success: false,
      postedCount: 0,
      failedCount: comments.length,
      errors: [err instanceof Error ? err.message : 'Unknown error posting to GitHub'],
    };
  }
}

/**
 * Fallback: post comments individually when batch submission fails (e.g., due
 * to invalid line numbers in some comments).
 */
async function postCommentsIndividually(
  comments: InlineComment[],
  config: GitHubPostConfig,
  commitSha: string,
): Promise<GitHubPostResult> {
  const errors: string[] = [];
  let postedCount = 0;
  let failedCount = 0;

  for (const comment of comments) {
    try {
      const url = `${GITHUB_API_BASE}/repos/${config.repository}/pulls/${config.prNumber}/comments`;
      const ghComment = toGitHubReviewComment(comment);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': GITHUB_USER_AGENT,
        },
        body: JSON.stringify({
          ...ghComment,
          commit_id: commitSha,
        }),
      });

      if (response.ok) {
        postedCount++;
      } else {
        failedCount++;
        const errorBody = await response.text();
        errors.push(`Failed to post comment on ${comment.filePath}:${comment.endLine}: ${errorBody}`);
      }
    } catch (err) {
      failedCount++;
      errors.push(
        `Error posting comment on ${comment.filePath}:${comment.endLine}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  }

  return {
    success: failedCount === 0,
    postedCount,
    failedCount,
    errors,
  };
}

/**
 * Build a Markdown summary body for the GitHub review.
 * Summarizes the number and types of findings.
 */
export function buildReviewSummary(comments: InlineComment[]): string {
  const criticalCount = comments.filter((c) => c.severity === 'critical').length;
  const warningCount = comments.filter((c) => c.severity === 'warning').length;
  const infoCount = comments.filter((c) => c.severity === 'info').length;

  const parts: string[] = [
    '## NeuroNest Code Review',
    '',
  ];

  if (criticalCount > 0) {
    parts.push(`${SEVERITY_BADGES.critical} **${criticalCount} critical** issue${criticalCount > 1 ? 's' : ''} found`);
  }
  if (warningCount > 0) {
    parts.push(`${SEVERITY_BADGES.warning} **${warningCount} warning${warningCount > 1 ? 's' : ''}**`);
  }
  if (infoCount > 0) {
    parts.push(`${SEVERITY_BADGES.info} **${infoCount} suggestion${infoCount > 1 ? 's' : ''}**`);
  }

  // Category breakdown
  const categorySet = new Set(comments.map((c) => c.category));
  if (categorySet.size > 0) {
    parts.push('');
    parts.push(`**Categories:** ${[...categorySet].map((cat) => CATEGORY_LABELS[cat]).join(', ')}`);
  }

  return parts.join('\n');
}

// ─── Singleton Instance ─────────────────────────────────────────

/**
 * ReviewCommentsService — manages inline comment generation and posting.
 *
 * Lazy-initialized singleton pattern following NeuroNest conventions.
 * Feature-gated behind `code_review_pipeline`.
 *
 * Requirements: 4.3, 4.4
 */
export class ReviewCommentsService {
  private readonly formatOptions: FormatOptions;

  constructor(options?: FormatOptions) {
    this.formatOptions = { ...DEFAULT_FORMAT_OPTIONS, ...options };
  }

  /**
   * Generate inline comments from review findings.
   * Requirement 4.3: Map findings to specific line ranges and format as inline comments.
   */
  generateComments(findings: ReviewFinding[]): InlineComment[] {
    return mapFindingsToComments(findings, this.formatOptions);
  }

  /**
   * Post inline comments to a GitHub PR.
   * Requirement 4.4: Support posting review comments directly to GitHub PRs.
   *
   * Returns null if no token is configured (caller should check config first).
   */
  async postToGitHub(
    comments: InlineComment[],
    config: GitHubPostConfig,
  ): Promise<GitHubPostResult> {
    return postCommentsToGitHub(comments, config);
  }
}

let _instance: ReviewCommentsService | null = null;

/**
 * Get or create the ReviewCommentsService singleton.
 * Follows NeuroNest's lazy-initialization pattern.
 */
export function getReviewCommentsService(options?: FormatOptions): ReviewCommentsService {
  if (!_instance) {
    _instance = new ReviewCommentsService(options);
  }
  return _instance;
}

/** Reset the singleton (for testing) */
export function resetReviewCommentsService(): void {
  _instance = null;
}
