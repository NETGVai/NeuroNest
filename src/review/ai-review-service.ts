/**
 * AI Review Service — dedicated review agent with configurable model, effort level, and fast mode.
 * Reviews uncommitted changes, staged changes, or branch diff against target.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface ReviewConfig {
  id: string;
  project_id: string;
  review_model_provider: string | null;
  review_model_name: string | null;
  effort_level: 'quick' | 'standard' | 'thorough';
  fast_mode: boolean;
  auto_review: boolean;
  review_scope: 'uncommitted' | 'branch' | 'staged';
  custom_instructions: string | null;
}

export interface ReviewRun {
  id: string;
  project_id: string;
  review_type: 'manual' | 'auto';
  scope: string;
  files_reviewed: number;
  issues_found: number;
  effort_level: string;
  model_used: string | null;
  summary: string | null;
  findings: string;
  duration_ms: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
}

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: string;
  message: string;
  suggestion?: string;
}

const EFFORT_PROMPTS: Record<string, string> = {
  quick: 'Do a quick scan focusing only on critical issues: security vulnerabilities, obvious bugs, and breaking changes. Be brief.',
  standard: 'Review the code changes thoroughly. Check for bugs, security issues, code quality, naming, error handling, and edge cases. Provide actionable feedback.',
  thorough: 'Perform an exhaustive code review. Check security, performance, correctness, error handling, edge cases, naming conventions, documentation, test coverage gaps, accessibility, and architectural concerns. Be detailed and specific with line references.',
};

export class AIReviewService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Get or create review config for a project */
  getConfig(projectId: string): ReviewConfig {
    const row = this.db.prepare('SELECT * FROM ai_review_config WHERE project_id = ?').get(projectId) as any;
    if (row) {
      return {
        ...row,
        fast_mode: !!row.fast_mode,
        auto_review: !!row.auto_review,
      };
    }
    // Create default config
    const id = crypto.randomUUID();
    this.db.prepare(
      'INSERT INTO ai_review_config (id, project_id) VALUES (?, ?)'
    ).run(id, projectId);
    return {
      id,
      project_id: projectId,
      review_model_provider: null,
      review_model_name: null,
      effort_level: 'standard',
      fast_mode: false,
      auto_review: false,
      review_scope: 'uncommitted',
      custom_instructions: null,
    };
  }

  /** Update review config */
  updateConfig(projectId: string, updates: Partial<ReviewConfig>): ReviewConfig {
    const current = this.getConfig(projectId);
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.review_model_provider !== undefined) { fields.push('review_model_provider = ?'); values.push(updates.review_model_provider); }
    if (updates.review_model_name !== undefined) { fields.push('review_model_name = ?'); values.push(updates.review_model_name); }
    if (updates.effort_level !== undefined) { fields.push('effort_level = ?'); values.push(updates.effort_level); }
    if (updates.fast_mode !== undefined) { fields.push('fast_mode = ?'); values.push(updates.fast_mode ? 1 : 0); }
    if (updates.auto_review !== undefined) { fields.push('auto_review = ?'); values.push(updates.auto_review ? 1 : 0); }
    if (updates.review_scope !== undefined) { fields.push('review_scope = ?'); values.push(updates.review_scope); }
    if (updates.custom_instructions !== undefined) { fields.push('custom_instructions = ?'); values.push(updates.custom_instructions); }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE ai_review_config SET ${fields.join(', ')} WHERE project_id = ?`).run(...values, projectId);
    }

    return this.getConfig(projectId);
  }

  /** Build the review system prompt based on config */
  buildReviewPrompt(config: ReviewConfig, diff: string): string {
    const effortPrompt = EFFORT_PROMPTS[config.effort_level] || EFFORT_PROMPTS.standard;
    const customInstructions = config.custom_instructions ? `\n\nAdditional instructions: ${config.custom_instructions}` : '';

    let prompt = `You are an expert code reviewer. ${effortPrompt}${customInstructions}

Review the following code changes and provide structured feedback.

For each issue found, use this format:
**[SEVERITY]** (file:line) category — description
> Suggestion: how to fix

Severity levels: 🔴 critical, 🟠 error, 🟡 warning, ℹ️ info

At the end, provide a brief summary with:
- Total issues found by severity
- Overall assessment (approve / request changes / needs discussion)
- Key recommendations

Code changes to review:
\`\`\`diff
${diff}
\`\`\``;

    if (config.fast_mode) {
      prompt = `You are a fast code reviewer. Focus ONLY on critical and error-level issues. Skip style, naming, and minor suggestions. Be extremely concise.${customInstructions}

\`\`\`diff
${diff}
\`\`\`

List only critical/error issues. If none found, say "✅ No critical issues found."`;
    }

    return prompt;
  }

  /** Record a review run */
  recordRun(projectId: string, run: Partial<ReviewRun>): ReviewRun {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO ai_review_runs (id, project_id, review_type, scope, files_reviewed, issues_found, effort_level, model_used, summary, findings, duration_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      projectId,
      run.review_type || 'manual',
      run.scope || 'uncommitted',
      run.files_reviewed || 0,
      run.issues_found || 0,
      run.effort_level || 'standard',
      run.model_used || null,
      run.summary || null,
      run.findings || '[]',
      run.duration_ms || 0,
      run.status || 'completed',
    );
    return this.db.prepare('SELECT * FROM ai_review_runs WHERE id = ?').get(id) as ReviewRun;
  }

  /** Update a review run */
  updateRun(runId: string, updates: Partial<ReviewRun>): void {
    const fields: string[] = [];
    const values: any[] = [];
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.summary !== undefined) { fields.push('summary = ?'); values.push(updates.summary); }
    if (updates.findings !== undefined) { fields.push('findings = ?'); values.push(updates.findings); }
    if (updates.files_reviewed !== undefined) { fields.push('files_reviewed = ?'); values.push(updates.files_reviewed); }
    if (updates.issues_found !== undefined) { fields.push('issues_found = ?'); values.push(updates.issues_found); }
    if (updates.duration_ms !== undefined) { fields.push('duration_ms = ?'); values.push(updates.duration_ms); }
    if (fields.length > 0) {
      this.db.prepare(`UPDATE ai_review_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values, runId);
    }
  }

  /** Get recent review runs for a project */
  getRecentRuns(projectId: string, limit = 10): ReviewRun[] {
    return this.db.prepare(
      'SELECT * FROM ai_review_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(projectId, limit) as ReviewRun[];
  }

  /** Get review stats for a project */
  getStats(projectId: string): { totalReviews: number; totalIssues: number; avgDuration: number; lastReview: string | null } {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total, COALESCE(SUM(issues_found), 0) as issues,
              COALESCE(AVG(duration_ms), 0) as avgDur, MAX(created_at) as lastReview
       FROM ai_review_runs WHERE project_id = ? AND status = 'completed'`
    ).get(projectId) as any;
    return {
      totalReviews: row?.total || 0,
      totalIssues: row?.issues || 0,
      avgDuration: Math.round(row?.avgDur || 0),
      lastReview: row?.lastReview || null,
    };
  }
}
