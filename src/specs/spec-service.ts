/**
 * Specification Mode Service — Read-only planning before execution.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface Specification {
  id: string;
  project_id: string;
  title: string;
  input_description: string;
  spec_content: string | null;
  implementation_plan: string | null;
  acceptance_criteria: string;
  files_to_change: string;
  testing_strategy: string | null;
  status: string;
  spec_model: string | null;
  exec_model: string | null;
  save_as_markdown: boolean;
  markdown_path: string | null;
  created_at: string;
}

export interface SpecConfig {
  project_id: string;
  auto_spec_mode: boolean;
  spec_model: string | null;
  exec_model: string | null;
  save_markdown: boolean;
  markdown_dir: string;
}

export class SpecService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): SpecConfig {
    const row = this.db.prepare('SELECT * FROM spec_config WHERE project_id = ?').get(projectId) as any;
    if (row) return { ...row, auto_spec_mode: !!row.auto_spec_mode, save_markdown: !!row.save_markdown };
    this.db.prepare('INSERT INTO spec_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, auto_spec_mode: false, spec_model: null, exec_model: null, save_markdown: false, markdown_dir: '.neuronest/specs' };
  }

  updateConfig(projectId: string, updates: Partial<SpecConfig>): SpecConfig {
    this.getConfig(projectId);
    const fields: string[] = []; const values: any[] = [];
    if (updates.auto_spec_mode !== undefined) { fields.push('auto_spec_mode = ?'); values.push(updates.auto_spec_mode ? 1 : 0); }
    if (updates.spec_model !== undefined) { fields.push('spec_model = ?'); values.push(updates.spec_model); }
    if (updates.exec_model !== undefined) { fields.push('exec_model = ?'); values.push(updates.exec_model); }
    if (updates.save_markdown !== undefined) { fields.push('save_markdown = ?'); values.push(updates.save_markdown ? 1 : 0); }
    if (updates.markdown_dir !== undefined) { fields.push('markdown_dir = ?'); values.push(updates.markdown_dir); }
    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE spec_config SET ${fields.join(', ')} WHERE project_id = ?`).run(...values, projectId);
    }
    return this.getConfig(projectId);
  }

  create(projectId: string, data: { title: string; input_description: string }): Specification {
    const id = crypto.randomUUID();
    const cfg = this.getConfig(projectId);
    this.db.prepare(
      `INSERT INTO specifications (id, project_id, title, input_description, spec_model, exec_model, save_as_markdown) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, data.title, data.input_description, cfg.spec_model, cfg.exec_model, cfg.save_markdown ? 1 : 0);
    return this.db.prepare('SELECT * FROM specifications WHERE id = ?').get(id) as Specification;
  }

  update(specId: string, updates: Partial<Specification>): void {
    const fields: string[] = []; const values: any[] = [];
    if (updates.spec_content !== undefined) { fields.push('spec_content = ?'); values.push(updates.spec_content); }
    if (updates.implementation_plan !== undefined) { fields.push('implementation_plan = ?'); values.push(updates.implementation_plan); }
    if (updates.acceptance_criteria !== undefined) { fields.push('acceptance_criteria = ?'); values.push(updates.acceptance_criteria); }
    if (updates.files_to_change !== undefined) { fields.push('files_to_change = ?'); values.push(updates.files_to_change); }
    if (updates.testing_strategy !== undefined) { fields.push('testing_strategy = ?'); values.push(updates.testing_strategy); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
    if (updates.markdown_path !== undefined) { fields.push('markdown_path = ?'); values.push(updates.markdown_path); }
    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE specifications SET ${fields.join(', ')} WHERE id = ?`).run(...values, specId);
    }
  }

  get(specId: string): Specification | null {
    return this.db.prepare('SELECT * FROM specifications WHERE id = ?').get(specId) as Specification | null;
  }

  list(projectId: string): Specification[] {
    return this.db.prepare('SELECT * FROM specifications WHERE project_id = ? ORDER BY created_at DESC LIMIT 20').all(projectId) as Specification[];
  }

  getStats(projectId: string): { total: number; completed: number; avgFiles: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed FROM specifications WHERE project_id = ?`
    ).get(projectId) as any;
    return { total: row?.total || 0, completed: row?.completed || 0, avgFiles: 0 };
  }

  buildSpecPrompt(description: string): string {
    return `You are a senior software architect. Analyze this feature request and produce a detailed specification.

Feature Request:
${description}

Generate a complete specification with these sections:
1. **Title** — Clear, concise title
2. **Overview** — What this feature does and why
3. **Acceptance Criteria** — Numbered list of testable criteria
4. **Implementation Plan** — Step-by-step plan with file-by-file breakdown
5. **Files to Change** — List of files that need modification
6. **Testing Strategy** — How to verify the implementation
7. **Security Considerations** — Any security implications
8. **Estimated Complexity** — Low/Medium/High with reasoning

Do NOT make any code changes. This is a read-only planning phase.`;
  }
}
