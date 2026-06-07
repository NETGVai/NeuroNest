/**
 * QA/Demo/Verify Service — Automated testing, behavior verification, and demo recording.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface QARun {
  id: string;
  project_id: string;
  run_type: string;
  target: string;
  target_type: string;
  status: string;
  test_plan: string;
  results: string;
  evidence: string;
  conclusion: string | null;
  verdict: string | null;
  steps_total: number;
  steps_passed: number;
  steps_failed: number;
  duration_ms: number;
  created_at: string;
}

export interface QAConfig {
  project_id: string;
  default_target_type: string;
  auto_screenshot: boolean;
  browser_url: string;
}

export class QAService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): QAConfig {
    const row = this.db.prepare('SELECT * FROM qa_config WHERE project_id = ?').get(projectId) as any;
    if (row) return { ...row, auto_screenshot: !!row.auto_screenshot };
    this.db.prepare('INSERT INTO qa_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, default_target_type: 'web', auto_screenshot: true, browser_url: 'http://localhost:3000' };
  }

  updateConfig(projectId: string, updates: Partial<QAConfig>): QAConfig {
    this.getConfig(projectId);
    const fields: string[] = []; const values: any[] = [];
    if (updates.default_target_type !== undefined) { fields.push('default_target_type = ?'); values.push(updates.default_target_type); }
    if (updates.auto_screenshot !== undefined) { fields.push('auto_screenshot = ?'); values.push(updates.auto_screenshot ? 1 : 0); }
    if (updates.browser_url !== undefined) { fields.push('browser_url = ?'); values.push(updates.browser_url); }
    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE qa_config SET ${fields.join(', ')} WHERE project_id = ?`).run(...values, projectId);
    }
    return this.getConfig(projectId);
  }

  startRun(projectId: string, data: { runType: string; target: string; targetType?: string; testPlan?: any[] }): QARun {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO qa_runs (id, project_id, run_type, target, target_type, test_plan, steps_total, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'planning')`
    ).run(id, projectId, data.runType, data.target, data.targetType || 'web', JSON.stringify(data.testPlan || []), (data.testPlan || []).length);
    return this.db.prepare('SELECT * FROM qa_runs WHERE id = ?').get(id) as QARun;
  }

  updateRun(runId: string, updates: Partial<QARun>): void {
    const fields: string[] = []; const values: any[] = [];
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.results !== undefined) { fields.push('results = ?'); values.push(updates.results); }
    if (updates.evidence !== undefined) { fields.push('evidence = ?'); values.push(updates.evidence); }
    if (updates.conclusion !== undefined) { fields.push('conclusion = ?'); values.push(updates.conclusion); }
    if (updates.verdict !== undefined) { fields.push('verdict = ?'); values.push(updates.verdict); }
    if (updates.steps_passed !== undefined) { fields.push('steps_passed = ?'); values.push(updates.steps_passed); }
    if (updates.steps_failed !== undefined) { fields.push('steps_failed = ?'); values.push(updates.steps_failed); }
    if (updates.duration_ms !== undefined) { fields.push('duration_ms = ?'); values.push(updates.duration_ms); }
    if (fields.length > 0) this.db.prepare(`UPDATE qa_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values, runId);
  }

  getRun(runId: string): QARun | null {
    return this.db.prepare('SELECT * FROM qa_runs WHERE id = ?').get(runId) as QARun | null;
  }

  getRecentRuns(projectId: string, limit = 10): QARun[] {
    return this.db.prepare('SELECT * FROM qa_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as QARun[];
  }

  getStats(projectId: string): { total: number; passed: number; failed: number; avgDuration: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN verdict='pass' OR verdict='confirmed' THEN 1 ELSE 0 END) as passed,
              SUM(CASE WHEN verdict='fail' OR verdict='refuted' THEN 1 ELSE 0 END) as failed, AVG(duration_ms) as avgDur
       FROM qa_runs WHERE project_id = ?`
    ).get(projectId) as any;
    return { total: row?.total || 0, passed: row?.passed || 0, failed: row?.failed || 0, avgDuration: Math.round(row?.avgDur || 0) };
  }

  buildQAPrompt(target: string, targetType: string, steps?: string[]): string {
    const stepsText = steps && steps.length > 0 ? `\n\nTest steps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '';
    return `You are an automated QA engineer. Test the following ${targetType} application and report results.

Target: ${target}
Type: ${targetType}${stepsText}

For each test step:
1. Describe what you're testing
2. Execute the test (describe the interaction)
3. Record the result: ✅ PASS or ❌ FAIL
4. Note any evidence (screenshots, logs, error messages)

At the end, provide:
- **Summary**: X/Y steps passed
- **Verdict**: PASS (all passed) or FAIL (any failed)
- **Issues Found**: List any bugs or problems discovered
- **Recommendations**: Suggested fixes`;
  }

  buildVerifyPrompt(claim: string, target: string): string {
    return `You are an investigator, not an advocate. Test whether this behavior claim is true.

Claim: "${claim}"
Target: ${target}

Investigation steps:
1. Determine what evidence would confirm or refute the claim
2. Describe the minimal interaction needed to test it
3. Execute the test and capture evidence
4. Report your finding

Respond with:
- **Verdict**: CONFIRMED / REFUTED / INCONCLUSIVE
- **Evidence**: What you observed
- **Details**: Explanation of the finding

If the claim is false, that is a valid finding — do not fabricate evidence to match expected outcomes.`;
  }
}
