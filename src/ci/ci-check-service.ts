/**
 * CI Check Service — AI-powered code review checks that can run on file changes.
 *
 * Each check is defined with a name, description, and prompt. When run, the AI
 * reviews the specified files and either passes or fails with a suggested fix.
 * Modeled after Continue's PR check system.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface CICheck {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  prompt: string;
  enabled: boolean;
  severity: 'info' | 'warning' | 'error';
  createdAt: string;
}

export interface CICheckRun {
  id: string;
  checkId: string;
  projectId: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  result?: string;
  suggestedFix?: string;
  filesChecked: string[];
  runAt: string;
  completedAt?: string;
}

// Built-in check templates
export const BUILTIN_CHECK_TEMPLATES = [
  {
    name: 'Security Review',
    description: 'Check for hardcoded secrets, missing input validation, and SQL injection',
    prompt: 'Review this code and check that:\n- No secrets or API keys are hardcoded\n- All new API endpoints have input validation\n- SQL queries use parameterized statements, not string concatenation\n- Error responses don\'t leak internal details\nIf issues found, explain each one and suggest a fix.',
    severity: 'error' as const,
  },
  {
    name: 'Code Quality',
    description: 'Check for code smells, unused variables, and missing error handling',
    prompt: 'Review this code for quality issues:\n- Unused variables or imports\n- Missing error handling (try/catch, null checks)\n- Functions longer than 50 lines\n- Deeply nested conditionals (>3 levels)\n- Magic numbers without constants\nIf issues found, explain each one and suggest a fix.',
    severity: 'warning' as const,
  },
  {
    name: 'Documentation',
    description: 'Check that public functions and classes have documentation',
    prompt: 'Review this code and check that:\n- All exported/public functions have JSDoc or docstring comments\n- Complex logic has inline comments explaining the "why"\n- Any new API endpoints are documented\nIf documentation is missing, suggest what should be added.',
    severity: 'info' as const,
  },
  {
    name: 'Performance',
    description: 'Check for common performance issues',
    prompt: 'Review this code for performance issues:\n- N+1 query patterns in database access\n- Missing pagination for list endpoints\n- Synchronous I/O in hot paths\n- Large objects created in loops\n- Missing caching for repeated expensive operations\nIf issues found, explain the impact and suggest a fix.',
    severity: 'warning' as const,
  },
];

export class CICheckService {
  constructor(private db: Database.Database) {}

  createCheck(opts: { projectId: string; name: string; description?: string; prompt: string; severity?: string }): CICheck {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO ci_checks (id, project_id, name, description, prompt, enabled, severity, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)'
    ).run(id, opts.projectId, opts.name, opts.description || null, opts.prompt, opts.severity || 'warning', now);
    return this.getCheck(id)!;
  }

  getCheck(id: string): CICheck | null {
    const row = this.db.prepare('SELECT * FROM ci_checks WHERE id = ?').get(id) as any;
    return row ? this.mapCheck(row) : null;
  }

  listChecks(projectId: string): CICheck[] {
    return (this.db.prepare('SELECT * FROM ci_checks WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as any[]).map(r => this.mapCheck(r));
  }

  toggleCheck(id: string, enabled: boolean): boolean {
    return this.db.prepare('UPDATE ci_checks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0;
  }

  deleteCheck(id: string): boolean {
    return this.db.prepare('DELETE FROM ci_checks WHERE id = ?').run(id).changes > 0;
  }

  /** Start a check run — returns the run record. Caller is responsible for executing the AI check. */
  startRun(checkId: string, projectId: string, filesChecked: string[]): CICheckRun {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO ci_check_runs (id, check_id, project_id, status, files_checked, run_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, checkId, projectId, 'running', JSON.stringify(filesChecked), now);
    return { id, checkId, projectId, status: 'running', filesChecked, runAt: now };
  }

  /** Complete a check run with pass/fail result */
  completeRun(runId: string, passed: boolean, result?: string, suggestedFix?: string): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(
      'UPDATE ci_check_runs SET status = ?, result = ?, suggested_fix = ?, completed_at = ? WHERE id = ?'
    ).run(passed ? 'passed' : 'failed', result || null, suggestedFix || null, now, runId).changes > 0;
  }

  /** Get recent runs for a project */
  getRecentRuns(projectId: string, limit?: number): CICheckRun[] {
    return (this.db.prepare(
      'SELECT * FROM ci_check_runs WHERE project_id = ? ORDER BY run_at DESC LIMIT ?'
    ).all(projectId, limit || 20) as any[]).map(r => this.mapRun(r));
  }

  getRunStats(projectId: string): { total: number; passed: number; failed: number; running: number } {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) as c FROM ci_check_runs WHERE project_id = ? GROUP BY status'
    ).all(projectId) as any[];
    const stats = { total: 0, passed: 0, failed: 0, running: 0 };
    for (const r of rows) {
      stats.total += r.c;
      if (r.status === 'passed') stats.passed = r.c;
      if (r.status === 'failed') stats.failed = r.c;
      if (r.status === 'running') stats.running = r.c;
    }
    return stats;
  }

  private mapCheck(row: any): CICheck {
    return {
      id: row.id, projectId: row.project_id, name: row.name,
      description: row.description || undefined, prompt: row.prompt,
      enabled: row.enabled === 1, severity: row.severity, createdAt: row.created_at,
    };
  }

  private mapRun(row: any): CICheckRun {
    return {
      id: row.id, checkId: row.check_id, projectId: row.project_id,
      status: row.status, result: row.result || undefined,
      suggestedFix: row.suggested_fix || undefined,
      filesChecked: JSON.parse(row.files_checked || '[]'),
      runAt: row.run_at, completedAt: row.completed_at || undefined,
    };
  }
}
