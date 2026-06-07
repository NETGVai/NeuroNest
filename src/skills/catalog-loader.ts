// Catalog loader: loads bundled catalog into catalog_skills table, search/filter

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  content: string;
  loadedAt: string;
}

interface CatalogIndexEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  version: string;
  file: string;
}

interface CatalogRow {
  id: string;
  name: string;
  description: string;
  category: string | null;
  tags: string | null;
  version: string | null;
  content: string;
  loaded_at: string;
}

function rowToEntry(row: CatalogRow): CatalogEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category ?? '',
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    version: row.version ?? '1.0.0',
    content: row.content,
    loadedAt: row.loaded_at,
  };
}

export class CatalogLoader {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Load bundled catalog index into catalog_skills table. Returns count of loaded entries. */
  loadBundledCatalog(): number {
    const catalogDir = path.resolve(__dirname, '../data/bundled-catalog');
    const indexPath = path.join(catalogDir, 'catalog-index.json');

    if (!fs.existsSync(indexPath)) {
      console.warn(`[CatalogLoader] Bundled catalog not found: ${indexPath}`);
      return 0;
    }

    let indexData: string;
    try {
      indexData = fs.readFileSync(indexPath, 'utf-8');
    } catch (err) {
      console.warn(`[CatalogLoader] Failed to read catalog index:`, err);
      return 0;
    }

    let entries: CatalogIndexEntry[];
    try {
      entries = JSON.parse(indexData) as CatalogIndexEntry[];
    } catch (err) {
      console.warn(`[CatalogLoader] Failed to parse catalog index:`, err);
      return 0;
    }

    const upsertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO catalog_skills (id, name, description, category, tags, version, content, loaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Also auto-install into the skills table so they show up in the Skills panel
    const installStmt = this.db.prepare(
      `INSERT OR IGNORE INTO skills (id, name, description, source, version, category, tags, scope, enabled, installed, content, metadata, bundled_skill_id, created_at, updated_at)
       VALUES (?, ?, ?, 'bundled', ?, ?, ?, 'project', 1, 1, ?, '{}', ?, ?, ?)`
    );

    let count = 0;
    const now = new Date().toISOString();

    for (const entry of entries) {
      const filePath = path.join(catalogDir, entry.file);

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        console.warn(`[CatalogLoader] Failed to read skill file ${filePath}:`, err);
        continue;
      }

      upsertStmt.run(
        entry.id,
        entry.name,
        entry.description,
        entry.category ?? null,
        entry.tags ? JSON.stringify(entry.tags) : null,
        entry.version ?? null,
        content,
        now,
      );

      // Auto-install into skills table
      installStmt.run(
        entry.id,
        entry.name,
        entry.description,
        entry.version ?? '1.0.0',
        entry.category ?? 'general',
        entry.tags ? JSON.stringify(entry.tags) : '[]',
        content,
        entry.id,
        now,
        now,
      );

      count++;
    }

    return count;
  }

  /** Refresh catalog from bundled data (re-read and upsert). */
  refreshCatalog(): number {
    return this.loadBundledCatalog() + this.loadDesignTemplates();
  }

  /** Load bundled design templates into skills table. Returns count loaded. */
  loadDesignTemplates(): number {
    const templatesDir = path.resolve(__dirname, '../data/design-templates');
    const indexPath = path.join(templatesDir, 'template-index.json');

    if (!fs.existsSync(indexPath)) {
      console.warn(`[CatalogLoader] Design templates not found: ${indexPath}`);
      return 0;
    }

    let indexData: string;
    try {
      indexData = fs.readFileSync(indexPath, 'utf-8');
    } catch (err) {
      console.warn(`[CatalogLoader] Failed to read template index:`, err);
      return 0;
    }

    let entries: any[];
    try {
      entries = JSON.parse(indexData);
    } catch (err) {
      console.warn(`[CatalogLoader] Failed to parse template index:`, err);
      return 0;
    }

    const installStmt = this.db.prepare(
      `INSERT OR IGNORE INTO skills (id, name, description, source, version, category, tags, scope, enabled, installed, content, metadata, bundled_skill_id, created_at, updated_at)
       VALUES (?, ?, ?, 'bundled', ?, 'design-template', ?, 'project', 1, 1, ?, ?, ?, ?, ?)`
    );

    let count = 0;
    const now = new Date().toISOString();

    for (const entry of entries) {
      const filePath = path.join(templatesDir, entry.file);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const meta = JSON.stringify({
        designStyle: entry.designStyle || '',
        industry: entry.industry || '',
        colorScheme: entry.colorScheme || [],
      });

      installStmt.run(
        entry.id,
        entry.name,
        entry.description || '',
        entry.version || '1.0.0',
        entry.tags ? JSON.stringify(entry.tags) : '[]',
        content,
        meta,
        entry.id,
        now,
        now,
      );
      count++;
    }

    console.log(`[CatalogLoader] Loaded ${count} design templates`);
    return count;
  }

  /** List catalog entries with optional search/filter. */
  listCatalog(filters?: { category?: string; search?: string }): CatalogEntry[] {
    let sql = 'SELECT * FROM catalog_skills WHERE 1=1';
    const params: unknown[] = [];

    if (filters?.category !== undefined) {
      sql += ' AND category = ?';
      params.push(filters.category);
    }

    if (filters?.search !== undefined && filters.search.length > 0) {
      sql += ' AND (name LIKE ? OR description LIKE ? OR category LIKE ?)';
      const term = `%${filters.search}%`;
      params.push(term, term, term);
    }

    sql += ' ORDER BY name ASC';

    const rows = this.db.prepare(sql).all(...params) as CatalogRow[];
    return rows.map(rowToEntry);
  }

  /** Get a single catalog entry by id. */
  getCatalogEntry(id: string): CatalogEntry | null {
    const row = this.db
      .prepare('SELECT * FROM catalog_skills WHERE id = ?')
      .get(id) as CatalogRow | undefined;
    return row ? rowToEntry(row) : null;
  }
}
