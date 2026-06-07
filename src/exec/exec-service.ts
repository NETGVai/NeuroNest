/**
 * Headless Exec Service — CI/CD non-interactive execution mode.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface ExecRun {
  id: string;
  project_id: string | null;
  prompt: string;
  autonomy_level: string;
  output_format: string;
  status: string;
  result: string | null;
  model_used: string | null;
  duration_ms: number;
  exit_code: number;
  files_modified: number;
  session_id: string | null;
  created_at: string;
}

export interface ExecConfig {
  project_id: string;
  default_autonomy: string;
  default_model: string | null;
  default_output: string;
  max_turns: number;
  timeout_ms: number;
}

export class ExecService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): ExecConfig {
    const row = this.db.prepare('SELECT * FROM exec_config WHERE project_id = ?').get(projectId) as any;
    if (row) return row;
    this.db.prepare('INSERT INTO exec_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, default_autonomy: 'readonly', default_model: null, default_output: 'text', max_turns: 50, timeout_ms: 300000 };
  }

  updateConfig(projectId: string, updates: Partial<ExecConfig>): ExecConfig {
    this.getConfig(projectId);
    const fields: string[] = []; const values: any[] = [];
    if (updates.default_autonomy !== undefined) { fields.push('default_autonomy = ?'); values.push(updates.default_autonomy); }
    if (updates.default_model !== undefined) { fields.push('default_model = ?'); values.push(updates.default_model); }
    if (updates.default_output !== undefined) { fields.push('default_output = ?'); values.push(updates.default_output); }
    if (updates.max_turns !== undefined) { fields.push('max_turns = ?'); values.push(updates.max_turns); }
    if (updates.timeout_ms !== undefined) { fields.push('timeout_ms = ?'); values.push(updates.timeout_ms); }
    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE exec_config SET ${fields.join(', ')} WHERE project_id = ?`).run(...values, projectId);
    }
    return this.getConfig(projectId);
  }

  startRun(data: { projectId?: string; prompt: string; autonomy?: string; outputFormat?: string; model?: string }): ExecRun {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO exec_runs (id, project_id, prompt, autonomy_level, output_format, model_used) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, data.projectId || null, data.prompt, data.autonomy || 'readonly', data.outputFormat || 'text', data.model || null);
    return this.db.prepare('SELECT * FROM exec_runs WHERE id = ?').get(id) as ExecRun;
  }

  completeRun(runId: string, result: string, exitCode: number, durationMs: number, filesModified?: number): void {
    this.db.prepare(
      `UPDATE exec_runs SET status = 'completed', result = ?, exit_code = ?, duration_ms = ?, files_modified = ? WHERE id = ?`
    ).run(result, exitCode, durationMs, filesModified || 0, runId);
  }

  failRun(runId: string, error: string): void {
    this.db.prepare("UPDATE exec_runs SET status = 'failed', result = ?, exit_code = 1 WHERE id = ?").run(error, runId);
  }

  getRecentRuns(projectId: string, limit = 10): ExecRun[] {
    return this.db.prepare('SELECT * FROM exec_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as ExecRun[];
  }

  getStats(projectId: string): { total: number; completed: number; failed: number; avgDuration: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed, AVG(duration_ms) as avgDur
       FROM exec_runs WHERE project_id = ?`
    ).get(projectId) as any;
    return { total: row?.total || 0, completed: row?.completed || 0, failed: row?.failed || 0, avgDuration: Math.round(row?.avgDur || 0) };
  }
}
