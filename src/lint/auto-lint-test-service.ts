/**
 * Auto Lint/Test Service — automatically runs linters and tests after AI changes.
 *
 * Configurable per-project with custom lint and test commands.
 * Can auto-fix lint issues and report test failures back to the AI.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface LintTestConfig {
  projectId: string;
  lintEnabled: boolean;
  lintCommand?: string;
  testEnabled: boolean;
  testCommand?: string;
  autoFix: boolean;
  runOnAiChange: boolean;
  updatedAt: string;
}

export interface LintTestRun {
  id: string;
  projectId: string;
  type: 'lint' | 'test';
  command: string;
  exitCode?: number;
  output?: string;
  autoFixed: boolean;
  triggeredBy: string;
  runAt: string;
}

export class AutoLintTestService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): LintTestConfig {
    const row = this.db.prepare('SELECT * FROM lint_test_config WHERE project_id = ?').get(projectId) as any;
    if (row) return this.mapConfig(row);
    return {
      projectId, lintEnabled: false, testEnabled: false,
      autoFix: false, runOnAiChange: true, updatedAt: new Date().toISOString(),
    };
  }

  setConfig(projectId: string, updates: Partial<Omit<LintTestConfig, 'projectId' | 'updatedAt'>>): LintTestConfig {
    const existing = this.getConfig(projectId);
    const merged = { ...existing, ...updates };
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR REPLACE INTO lint_test_config (project_id, lint_enabled, lint_command, test_enabled, test_command, auto_fix, run_on_ai_change, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(projectId, merged.lintEnabled ? 1 : 0, merged.lintCommand || null,
      merged.testEnabled ? 1 : 0, merged.testCommand || null,
      merged.autoFix ? 1 : 0, merged.runOnAiChange ? 1 : 0, now);
    return this.getConfig(projectId);
  }

  recordRun(projectId: string, type: 'lint' | 'test', command: string, exitCode: number, output: string, triggeredBy?: string, autoFixed?: boolean): LintTestRun {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO lint_test_runs (id, project_id, type, command, exit_code, output, auto_fixed, triggered_by, run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, type, command, exitCode, output.slice(0, 10000), autoFixed ? 1 : 0, triggeredBy || 'manual', now);
    return { id, projectId, type, command, exitCode, output, autoFixed: autoFixed || false, triggeredBy: triggeredBy || 'manual', runAt: now };
  }

  getRecentRuns(projectId: string, limit?: number): LintTestRun[] {
    return (this.db.prepare(
      'SELECT * FROM lint_test_runs WHERE project_id = ? ORDER BY run_at DESC LIMIT ?'
    ).all(projectId, limit || 20) as any[]).map(r => ({
      id: r.id, projectId: r.project_id, type: r.type, command: r.command,
      exitCode: r.exit_code, output: r.output || undefined,
      autoFixed: r.auto_fixed === 1, triggeredBy: r.triggered_by, runAt: r.run_at,
    }));
  }

  getStats(projectId: string): { lintRuns: number; lintPassed: number; testRuns: number; testPassed: number; autoFixes: number } {
    const lintRows = this.db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) as passed FROM lint_test_runs WHERE project_id = ? AND type = ?'
    ).get(projectId, 'lint') as any;
    const testRows = this.db.prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) as passed FROM lint_test_runs WHERE project_id = ? AND type = ?'
    ).get(projectId, 'test') as any;
    const fixes = (this.db.prepare(
      'SELECT COUNT(*) as c FROM lint_test_runs WHERE project_id = ? AND auto_fixed = 1'
    ).get(projectId) as any)?.c || 0;
    return {
      lintRuns: lintRows?.total || 0, lintPassed: lintRows?.passed || 0,
      testRuns: testRows?.total || 0, testPassed: testRows?.passed || 0,
      autoFixes: fixes,
    };
  }

  /** Detect common lint/test commands from project files */
  detectCommands(projectPath: string): { lintCommand?: string; testCommand?: string } {
    const fs = require('node:fs');
    const path = require('node:path');
    const result: { lintCommand?: string; testCommand?: string } = {};

    try {
      const pkgPath = path.join(projectPath, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts?.lint) result.lintCommand = 'npm run lint';
        else if (pkg.scripts?.['lint:fix']) result.lintCommand = 'npm run lint:fix';
        if (pkg.scripts?.test) result.testCommand = 'npm test';
        else if (pkg.scripts?.['test:run']) result.testCommand = 'npm run test:run';
      }
    } catch {}

    try {
      const fs2 = require('node:fs');
      if (fs2.existsSync(require('node:path').join(projectPath, 'Makefile'))) {
        if (!result.lintCommand) result.lintCommand = 'make lint';
        if (!result.testCommand) result.testCommand = 'make test';
      }
    } catch {}

    return result;
  }

  private mapConfig(row: any): LintTestConfig {
    return {
      projectId: row.project_id, lintEnabled: row.lint_enabled === 1,
      lintCommand: row.lint_command || undefined, testEnabled: row.test_enabled === 1,
      testCommand: row.test_command || undefined, autoFix: row.auto_fix === 1,
      runOnAiChange: row.run_on_ai_change === 1, updatedAt: row.updated_at,
    };
  }
}
