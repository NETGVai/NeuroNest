/**
 * Best-of-N Parallel Evaluation Service.
 * Spawns N agents on the same task, synthesizes the strongest result.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface BestOfNRun {
  id: string; project_id: string; prompt: string; n: number; status: string;
  candidates: string; winner_index: number | null; synthesized_result: string | null;
  model_used: string | null; duration_ms: number; created_at: string;
}
export interface BestOfNConfig {
  project_id: string; default_n: number; auto_best_of_n: boolean; synthesis_strategy: string;
}

export class BestOfNService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): BestOfNConfig {
    const row = this.db.prepare('SELECT * FROM best_of_n_config WHERE project_id = ?').get(projectId) as any;
    if (row) return { ...row, auto_best_of_n: !!row.auto_best_of_n };
    this.db.prepare('INSERT INTO best_of_n_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, default_n: 3, auto_best_of_n: false, synthesis_strategy: 'best' };
  }

  updateConfig(projectId: string, updates: Partial<BestOfNConfig>): BestOfNConfig {
    this.getConfig(projectId);
    const f: string[] = []; const v: any[] = [];
    if (updates.default_n !== undefined) { f.push('default_n = ?'); v.push(updates.default_n); }
    if (updates.auto_best_of_n !== undefined) { f.push('auto_best_of_n = ?'); v.push(updates.auto_best_of_n ? 1 : 0); }
    if (updates.synthesis_strategy !== undefined) { f.push('synthesis_strategy = ?'); v.push(updates.synthesis_strategy); }
    if (f.length) { f.push('updated_at = CURRENT_TIMESTAMP'); this.db.prepare(`UPDATE best_of_n_config SET ${f.join(', ')} WHERE project_id = ?`).run(...v, projectId); }
    return this.getConfig(projectId);
  }

  startRun(projectId: string, prompt: string, n: number, model?: string): BestOfNRun {
    const id = crypto.randomUUID();
    this.db.prepare('INSERT INTO best_of_n_runs (id, project_id, prompt, n, model_used) VALUES (?, ?, ?, ?, ?)').run(id, projectId, prompt, n, model || null);
    return this.db.prepare('SELECT * FROM best_of_n_runs WHERE id = ?').get(id) as BestOfNRun;
  }

  updateRun(runId: string, updates: Partial<BestOfNRun>): void {
    const f: string[] = []; const v: any[] = [];
    if (updates.status) { f.push('status = ?'); v.push(updates.status); }
    if (updates.candidates) { f.push('candidates = ?'); v.push(updates.candidates); }
    if (updates.winner_index !== undefined) { f.push('winner_index = ?'); v.push(updates.winner_index); }
    if (updates.synthesized_result !== undefined) { f.push('synthesized_result = ?'); v.push(updates.synthesized_result); }
    if (updates.duration_ms !== undefined) { f.push('duration_ms = ?'); v.push(updates.duration_ms); }
    if (f.length) this.db.prepare(`UPDATE best_of_n_runs SET ${f.join(', ')} WHERE id = ?`).run(...v, runId);
  }

  getRecent(projectId: string, limit = 10): BestOfNRun[] {
    return this.db.prepare('SELECT * FROM best_of_n_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit) as BestOfNRun[];
  }

  getStats(projectId: string): { total: number; completed: number; avgN: number } {
    const r = this.db.prepare("SELECT COUNT(*) as t, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as c, AVG(n) as a FROM best_of_n_runs WHERE project_id = ?").get(projectId) as any;
    return { total: r?.t || 0, completed: r?.c || 0, avgN: Math.round(r?.a || 3) };
  }

  buildSynthesisPrompt(prompt: string, candidates: string[]): string {
    const numbered = candidates.map((c, i) => `### Candidate ${i + 1}\n${c}`).join('\n\n---\n\n');
    return `You are a synthesis expert. ${candidates.length} independent agents were given the same task. Review all candidates and produce the best possible answer by selecting the strongest parts from each.\n\nOriginal task: ${prompt}\n\n${numbered}\n\nSynthesize the best answer. If one candidate is clearly superior, use it as the base and incorporate improvements from others. Explain briefly which candidates contributed what.`;
  }
}
