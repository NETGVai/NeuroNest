/**
 * Code Review Pipeline IPC Handler Registration
 *
 * Registers IPC channels for the automated code review feature:
 *   - `review:start`          — Start a code review on staged, PR, worktree, or manual diff
 *   - `review:status`         — Get the status of a running or completed review
 *   - `review:comments`       — Retrieve inline comments for a given review
 *   - `review:post-to-github` — Post review comments to a GitHub PR
 *
 * All handlers are gated behind the `code_review_pipeline` feature flag.
 * Supports trigger modes: slash command, UI button, post-commit hook, scheduled interval.
 * Respects project review rules from `.neuronest/review-rules.md`.
 *
 * Requirements: 4.6, 4.7
 */

import { ipcMain } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CodeReviewPipeline,
  type ReviewPipelineInput,
  type ReviewResult,
  type ReviewLLMClient,
} from '../review/review-pipeline.js';
import {
  ReviewCommentsService,
  type InlineComment,
  type GitHubPostConfig,
  type GitHubPostResult,
} from '../review/review-comments.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ReviewIPCDeps {
  /** Check if the code_review_pipeline feature flag is enabled */
  isFeatureEnabled: () => boolean;
  /** Resolve the active LLM client for review agents */
  resolveLLMClient: () => ReviewLLMClient | null;
  /** Get the active project working directory */
  getProjectCwd: () => string | null;
  /** Get the active project ID */
  getProjectId: () => string | null;
  /** Database instance for persisting reviews (optional — in-memory only if not provided) */
  db?: import('better-sqlite3').Database;
}

export interface ReviewStartArgs {
  /** Source type: 'staged' | 'pr' | 'worktree' | 'manual' */
  source?: string;
  /** PR number (for PR source) */
  prNumber?: number;
  /** Repository in owner/repo format (for PR source) */
  repository?: string;
  /** GitHub token (for PR source and posting) */
  githubToken?: string;
  /** Worktree branch name (for worktree source) */
  worktreeBranch?: string;
  /** Base branch for comparison (default: 'main') */
  baseBranch?: string;
  /** Manual diff text */
  manualDiff?: string;
  /** Working directory override */
  cwd?: string;
  /** Trigger source: 'command' | 'button' | 'hook' | 'scheduled' */
  trigger?: string;
}

export interface ReviewStartResult {
  success: boolean;
  reviewId?: string;
  result?: ReviewResult;
  error?: string;
  flagDisabled?: boolean;
}

export interface ReviewStatusResult {
  success: boolean;
  status?: string;
  review?: ReviewResult;
  error?: string;
  flagDisabled?: boolean;
}

export interface ReviewCommentsResult {
  success: boolean;
  comments?: InlineComment[];
  error?: string;
  flagDisabled?: boolean;
}

export interface ReviewPostResult {
  success: boolean;
  result?: GitHubPostResult;
  error?: string;
  flagDisabled?: boolean;
}

// ─── State ──────────────────────────────────────────────────────

/** In-memory store of recent reviews (keyed by review ID) */
const reviewCache = new Map<string, ReviewResult>();

// ─── Review Rules (Req 4.7) ─────────────────────────────────────

/**
 * Load project-specific review rules from `.neuronest/review-rules.md`.
 * Returns the content as a string to be injected into agent prompts,
 * or null if no rules file is present.
 *
 * Requirement 4.7: Respect project-specific review rules.
 */
function loadReviewRules(cwd: string): string | null {
  const rulesPath = join(cwd, '.neuronest', 'review-rules.md');
  if (!existsSync(rulesPath)) return null;
  try {
    const content = readFileSync(rulesPath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

// ─── Persistence Helpers ────────────────────────────────────────

function persistReview(db: import('better-sqlite3').Database | undefined, result: ReviewResult, projectId: string | null): void {
  if (!db) return;
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO code_reviews (id, project_id, source, source_ref, score_security, score_performance, score_style, score_test_coverage, score_complexity, overall_score, status, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      result.id,
      projectId || 'unknown',
      result.source,
      result.sourceRef || null,
      result.scores.security,
      result.scores.performance,
      result.scores.readability, // maps to style column
      null, // test_coverage (not scored by current agents)
      null, // complexity (not scored separately)
      result.scores.overall,
      result.status,
      result.createdAt,
      result.completedAt || null,
    );
  } catch (err) {
    console.warn('[ReviewIPC] Failed to persist review:', err);
  }
}

function persistComments(db: import('better-sqlite3').Database | undefined, reviewId: string, comments: InlineComment[]): void {
  if (!db || comments.length === 0) return;
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO review_comments (id, review_id, file_path, start_line, end_line, severity, category, message, suggested_fix, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((items: InlineComment[]) => {
      for (const c of items) {
        stmt.run(
          c.id,
          reviewId,
          c.filePath,
          c.startLine,
          c.endLine,
          c.severity,
          c.category,
          c.finding.message,
          c.finding.suggestedFix || null,
          c.finding.agentId,
          Date.now(),
        );
      }
    });
    insertMany(comments);
  } catch (err) {
    console.warn('[ReviewIPC] Failed to persist comments:', err);
  }
}

// ─── Registration ───────────────────────────────────────────────

/**
 * Register code review pipeline IPC handlers.
 *
 * Channels registered:
 * - `review:start`          — Start a review. Args: ReviewStartArgs. Returns: ReviewStartResult
 * - `review:status`         — Get review status. Args: { reviewId: string }. Returns: ReviewStatusResult
 * - `review:comments`       — Get comments. Args: { reviewId: string }. Returns: ReviewCommentsResult
 * - `review:post-to-github` — Post to PR. Args: { reviewId, token, repository, prNumber }. Returns: ReviewPostResult
 *
 * All channels are gated behind the `code_review_pipeline` feature flag.
 * When the flag is disabled, handlers return early with flagDisabled: true.
 *
 * Requirements: 4.6, 4.7
 */
export function registerReviewIPC(deps: ReviewIPCDeps): void {
  const { isFeatureEnabled, resolveLLMClient, getProjectCwd, getProjectId, db } = deps;

  // ── review:start ────────────────────────────────────────────────
  // Start a code review on the specified diff source.
  // Supports triggers: slash command (/review), UI button, post-commit hook, scheduled interval.
  ipcMain.handle('review:start', async (_ev, args?: ReviewStartArgs): Promise<ReviewStartResult> => {
    try {
      // Feature flag gate
      if (!isFeatureEnabled()) {
        return { success: false, flagDisabled: true, error: 'code_review_pipeline feature flag is disabled' };
      }

      // Resolve working directory
      const cwd = args?.cwd || getProjectCwd() || process.cwd();
      const projectId = getProjectId();
      const source = (args?.source || 'staged') as ReviewPipelineInput['source'];

      // Resolve LLM client
      const llmClient = resolveLLMClient();
      if (!llmClient) {
        return { success: false, error: 'No LLM client available. Configure a provider first.' };
      }

      // Load project-specific review rules (Req 4.7)
      const reviewRules = loadReviewRules(cwd);

      // Create the pipeline
      const pipeline = new CodeReviewPipeline({
        featureGate: { isEnabled: () => true }, // Already checked above
        llmClient: reviewRules
          ? wrapClientWithRules(llmClient, reviewRules)
          : llmClient,
        maxDiffSize: 100_000,
        agentTimeoutMs: 60_000,
      });

      // Build input
      const input: ReviewPipelineInput = {
        source,
        cwd,
        prNumber: args?.prNumber,
        repository: args?.repository,
        githubToken: args?.githubToken,
        worktreeBranch: args?.worktreeBranch,
        baseBranch: args?.baseBranch,
        manualDiff: args?.manualDiff,
        projectId: projectId || undefined,
      };

      // Execute the pipeline
      const result = await pipeline.execute(input);

      // Cache the result
      reviewCache.set(result.id, result);

      // Persist to database
      persistReview(db, result, projectId);

      // Generate and persist comments
      if (result.findings.length > 0) {
        const commentsService = new ReviewCommentsService();
        const comments = commentsService.generateComments(result.findings);
        persistComments(db, result.id, comments);
      }

      return { success: true, reviewId: result.id, result };
    } catch (e: any) {
      console.error('[ReviewIPC] review:start error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error starting review' };
    }
  });

  // ── review:status ───────────────────────────────────────────────
  // Get the status and result of a review by ID.
  ipcMain.handle('review:status', async (_ev, args?: { reviewId?: string }): Promise<ReviewStatusResult> => {
    try {
      if (!isFeatureEnabled()) {
        return { success: false, flagDisabled: true, error: 'code_review_pipeline feature flag is disabled' };
      }

      const reviewId = args?.reviewId;
      if (!reviewId) {
        return { success: false, error: 'reviewId is required' };
      }

      // Check in-memory cache first
      const cached = reviewCache.get(reviewId);
      if (cached) {
        return { success: true, status: cached.status, review: cached };
      }

      // Try database lookup
      if (db) {
        try {
          const row = db.prepare('SELECT * FROM code_reviews WHERE id = ?').get(reviewId) as any;
          if (row) {
            return {
              success: true,
              status: row.status,
              review: {
                id: row.id,
                source: row.source,
                sourceRef: row.source_ref,
                findings: [],
                scores: {
                  correctness: 0,
                  security: row.score_security || 0,
                  performance: row.score_performance || 0,
                  readability: row.score_style || 0,
                  maintainability: 0,
                  overall: row.overall_score || 0,
                },
                status: row.status,
                error: undefined,
                createdAt: row.created_at,
                completedAt: row.completed_at,
              },
            };
          }
        } catch {}
      }

      return { success: false, error: `Review not found: ${reviewId}` };
    } catch (e: any) {
      console.error('[ReviewIPC] review:status error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error' };
    }
  });

  // ── review:comments ─────────────────────────────────────────────
  // Retrieve inline comments for a completed review.
  ipcMain.handle('review:comments', async (_ev, args?: { reviewId?: string }): Promise<ReviewCommentsResult> => {
    try {
      if (!isFeatureEnabled()) {
        return { success: false, flagDisabled: true, error: 'code_review_pipeline feature flag is disabled' };
      }

      const reviewId = args?.reviewId;
      if (!reviewId) {
        return { success: false, error: 'reviewId is required' };
      }

      // Check in-memory cache for the review result to generate comments
      const cached = reviewCache.get(reviewId);
      if (cached && cached.findings.length > 0) {
        const commentsService = new ReviewCommentsService();
        const comments = commentsService.generateComments(cached.findings);
        return { success: true, comments };
      }

      // Try database lookup for persisted comments
      if (db) {
        try {
          const rows = db.prepare('SELECT * FROM review_comments WHERE review_id = ? ORDER BY severity, file_path, start_line').all(reviewId) as any[];
          if (rows.length > 0) {
            const comments: InlineComment[] = rows.map((row) => ({
              id: row.id,
              filePath: row.file_path,
              startLine: row.start_line,
              endLine: row.end_line,
              severity: row.severity,
              category: row.category,
              body: row.message,
              finding: {
                id: row.id,
                filePath: row.file_path,
                startLine: row.start_line,
                endLine: row.end_line,
                severity: row.severity,
                category: row.category,
                message: row.message,
                suggestedFix: row.suggested_fix || undefined,
                agentId: row.agent_id,
              },
            }));
            return { success: true, comments };
          }
        } catch {}
      }

      // No findings means no comments
      if (cached && cached.findings.length === 0) {
        return { success: true, comments: [] };
      }

      return { success: false, error: `Review not found: ${reviewId}` };
    } catch (e: any) {
      console.error('[ReviewIPC] review:comments error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error' };
    }
  });

  // ── review:post-to-github ───────────────────────────────────────
  // Post review comments to a GitHub PR (Req 4.4 via ReviewCommentsService).
  ipcMain.handle('review:post-to-github', async (_ev, args?: any): Promise<ReviewPostResult> => {
    try {
      if (!isFeatureEnabled()) {
        return { success: false, flagDisabled: true, error: 'code_review_pipeline feature flag is disabled' };
      }

      const reviewId = args?.reviewId as string | undefined;
      const token = args?.token as string | undefined;
      const repository = args?.repository as string | undefined;
      const prNumber = args?.prNumber as number | undefined;

      if (!reviewId || !token || !repository || !prNumber) {
        return { success: false, error: 'Required: reviewId, token, repository, prNumber' };
      }

      // Get comments for this review
      const cached = reviewCache.get(reviewId);
      if (!cached || cached.findings.length === 0) {
        return { success: false, error: 'No findings to post for this review' };
      }

      const commentsService = new ReviewCommentsService();
      const comments = commentsService.generateComments(cached.findings);

      const config: GitHubPostConfig = {
        token,
        repository,
        prNumber,
        commitSha: args?.commitSha,
      };

      const result = await commentsService.postToGitHub(comments, config);
      return { success: result.success, result };
    } catch (e: any) {
      console.error('[ReviewIPC] review:post-to-github error:', e?.message);
      return { success: false, error: e?.message || 'Unknown error posting to GitHub' };
    }
  });

  console.log('[IPC] Code Review Pipeline IPC handlers registered (review:start, review:status, review:comments, review:post-to-github)');
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Wrap an LLM client to prepend project-specific review rules to every system prompt.
 * This ensures agents respect `.neuronest/review-rules.md` (Req 4.7).
 */
function wrapClientWithRules(client: ReviewLLMClient, rules: string): ReviewLLMClient {
  return {
    async chat(messages, options) {
      // Inject review rules into the system message
      const augmented = messages.map((msg) => {
        if (msg.role === 'system') {
          return {
            ...msg,
            content: `${msg.content}\n\n## Project Review Rules\n\nThe following project-specific rules MUST be respected during review:\n\n${rules}`,
          };
        }
        return msg;
      });
      return client.chat(augmented, options);
    },
  };
}
