/**
 * Wiki Generation Service — Auto-generated codebase documentation.
 */
import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

export interface WikiPage {
  id: string;
  project_id: string;
  wiki_id: string;
  title: string;
  slug: string;
  content: string;
  page_type: string;
  parent_slug: string | null;
  sort_order: number;
}

export interface WikiGeneration {
  id: string;
  project_id: string;
  status: string;
  pages_generated: number;
  model_used: string | null;
  duration_ms: number;
  auto_refresh: boolean;
  created_at: string;
}

export interface WikiConfig {
  project_id: string;
  auto_refresh: boolean;
  output_dir: string;
  sync_github: boolean;
}

export class WikiService {
  constructor(private db: Database.Database) {}

  getConfig(projectId: string): WikiConfig {
    const row = this.db.prepare('SELECT * FROM wiki_config WHERE project_id = ?').get(projectId) as any;
    if (row) return { ...row, auto_refresh: !!row.auto_refresh, sync_github: !!row.sync_github };
    this.db.prepare('INSERT INTO wiki_config (project_id) VALUES (?)').run(projectId);
    return { project_id: projectId, auto_refresh: false, output_dir: '.neuronest/wiki', sync_github: false };
  }

  updateConfig(projectId: string, updates: Partial<WikiConfig>): WikiConfig {
    this.getConfig(projectId);
    const fields: string[] = []; const values: any[] = [];
    if (updates.auto_refresh !== undefined) { fields.push('auto_refresh = ?'); values.push(updates.auto_refresh ? 1 : 0); }
    if (updates.output_dir !== undefined) { fields.push('output_dir = ?'); values.push(updates.output_dir); }
    if (updates.sync_github !== undefined) { fields.push('sync_github = ?'); values.push(updates.sync_github ? 1 : 0); }
    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      this.db.prepare(`UPDATE wiki_config SET ${fields.join(', ')} WHERE project_id = ?`).run(...values, projectId);
    }
    return this.getConfig(projectId);
  }

  startGeneration(projectId: string, modelUsed?: string): WikiGeneration {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO wiki_generations (id, project_id, model_used) VALUES (?, ?, ?)`
    ).run(id, projectId, modelUsed || null);
    return this.db.prepare('SELECT * FROM wiki_generations WHERE id = ?').get(id) as WikiGeneration;
  }

  completeGeneration(genId: string, pagesGenerated: number, durationMs: number): void {
    this.db.prepare(
      `UPDATE wiki_generations SET status = 'completed', pages_generated = ?, duration_ms = ? WHERE id = ?`
    ).run(pagesGenerated, durationMs, genId);
  }

  failGeneration(genId: string): void {
    this.db.prepare("UPDATE wiki_generations SET status = 'failed' WHERE id = ?").run(genId);
  }

  addPage(projectId: string, wikiId: string, page: Partial<WikiPage>): WikiPage {
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO wiki_pages (id, project_id, wiki_id, title, slug, content, page_type, parent_slug, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, projectId, wikiId, page.title || 'Untitled', page.slug || id, page.content || '', page.page_type || 'module', page.parent_slug || null, page.sort_order || 0);
    return this.db.prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as WikiPage;
  }

  getPages(projectId: string, wikiId?: string): WikiPage[] {
    if (wikiId) return this.db.prepare('SELECT * FROM wiki_pages WHERE project_id = ? AND wiki_id = ? ORDER BY sort_order').all(projectId, wikiId) as WikiPage[];
    return this.db.prepare('SELECT * FROM wiki_pages WHERE project_id = ? ORDER BY created_at DESC, sort_order').all(projectId) as WikiPage[];
  }

  getGenerations(projectId: string): WikiGeneration[] {
    return this.db.prepare('SELECT * FROM wiki_generations WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').all(projectId) as WikiGeneration[];
  }

  getLatestWikiId(projectId: string): string | null {
    const row = this.db.prepare("SELECT id FROM wiki_generations WHERE project_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1").get(projectId) as any;
    return row?.id || null;
  }

  deleteWiki(wikiId: string): void {
    this.db.prepare('DELETE FROM wiki_pages WHERE wiki_id = ?').run(wikiId);
    this.db.prepare('DELETE FROM wiki_generations WHERE id = ?').run(wikiId);
  }

  getStats(projectId: string): { totalGenerations: number; totalPages: number; lastGenerated: string | null } {
    const row = this.db.prepare(
      `SELECT COUNT(*) as gens, MAX(created_at) as lastGen FROM wiki_generations WHERE project_id = ? AND status = 'completed'`
    ).get(projectId) as any;
    const pages = this.db.prepare('SELECT COUNT(*) as cnt FROM wiki_pages WHERE project_id = ?').get(projectId) as any;
    return { totalGenerations: row?.gens || 0, totalPages: pages?.cnt || 0, lastGenerated: row?.lastGen || null };
  }

  buildWikiPrompt(files: { path: string; content: string }[]): string {
    const fileList = files.map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 1500)}\n\`\`\``).join('\n\n');
    return `You are a technical documentation expert. Generate comprehensive wiki documentation for this codebase.

Analyze the following source files and produce structured documentation pages in Markdown.

Generate these pages:
1. **Overview** — Project summary, purpose, tech stack
2. **Architecture** — System design, component relationships, data flow
3. **Modules** — One section per major module/directory with purpose, key files, exports
4. **API Reference** — Public functions, classes, interfaces with descriptions
5. **Getting Started** — Setup, build, run instructions

Format each page as:
## [Page Title]
[Content]

---

Source files:
${fileList}`;
  }
}
