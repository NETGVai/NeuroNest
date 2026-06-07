/**
 * Project Steering — User-authored rules injected into every agent prompt.
 *
 * Stored per-project in SQLite. Different from learned memory — these are
 * explicit, user-written instructions like team standards, conventions,
 * and build instructions.
 */

export interface SteeringRule {
  id: string;
  projectId: string;
  title: string;
  content: string;
  enabled: boolean;
  category: 'convention' | 'standard' | 'build' | 'test' | 'style' | 'custom';
  createdAt: number;
  updatedAt: number;
}

export class ProjectSteeringStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS project_steering (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          category TEXT NOT NULL DEFAULT 'custom',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    } catch (e) {
      console.warn('[ProjectSteering] Table creation failed:', e);
    }
  }

  addRule(projectId: string, title: string, content: string, category: SteeringRule['category'] = 'custom'): SteeringRule {
    const rule: SteeringRule = {
      id: `steer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId, title, content, enabled: true, category,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    try {
      this.db.prepare(
        'INSERT INTO project_steering (id, project_id, title, content, enabled, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(rule.id, rule.projectId, rule.title, rule.content, 1, rule.category, rule.createdAt, rule.updatedAt);
    } catch (e) { console.warn('[ProjectSteering] Insert failed:', e); }
    return rule;
  }

  getRules(projectId: string): SteeringRule[] {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM project_steering WHERE project_id = ? ORDER BY created_at ASC'
      ).all(projectId) as any[];
      return rows.map((r: any) => ({
        id: r.id, projectId: r.project_id, title: r.title, content: r.content,
        enabled: !!r.enabled, category: r.category, createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    } catch { return []; }
  }

  getEnabledRules(projectId: string): SteeringRule[] {
    return this.getRules(projectId).filter(r => r.enabled);
  }

  getContextString(projectId: string): string {
    const rules = this.getEnabledRules(projectId);
    if (rules.length === 0) return '';
    let ctx = '## Project Rules\n\n';
    for (const r of rules) {
      ctx += `### ${r.title}\n${r.content}\n\n`;
    }
    return ctx;
  }

  updateRule(ruleId: string, updates: Partial<Pick<SteeringRule, 'title' | 'content' | 'enabled' | 'category'>>): void {
    try {
      const sets: string[] = [];
      const vals: any[] = [];
      if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
      if (updates.content !== undefined) { sets.push('content = ?'); vals.push(updates.content); }
      if (updates.enabled !== undefined) { sets.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0); }
      if (updates.category !== undefined) { sets.push('category = ?'); vals.push(updates.category); }
      sets.push('updated_at = ?'); vals.push(Date.now());
      vals.push(ruleId);
      this.db.prepare(`UPDATE project_steering SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } catch {}
  }

  deleteRule(ruleId: string): void {
    try { this.db.prepare('DELETE FROM project_steering WHERE id = ?').run(ruleId); } catch {}
  }
}
