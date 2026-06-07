/**
 * Extension Manager — registry and lifecycle for pluggable editors and file handlers.
 *
 * Extensions register file type associations and provide custom editor UIs.
 * Built-in extensions (CSV viewer, Markdown preview, etc.) use the same contract
 * as third-party extensions.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface Extension {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  enabled: boolean;
  filePatterns: string[];   // e.g. [".csv", ".excalidraw", ".md"]
  editorType: 'monaco' | 'iframe' | 'custom';
  entryPoint?: string;      // path to extension's main file
  icon?: string;            // emoji or icon path
  category: string;
  installedAt: string;
  updatedAt: string;
}

export interface ExtensionManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  filePatterns: string[];
  editorType: 'monaco' | 'iframe' | 'custom';
  entryPoint?: string;
  icon?: string;
  category?: string;
}

// Built-in extensions that ship with NeuroNest
const BUILTIN_EXTENSIONS: ExtensionManifest[] = [
  {
    name: 'CSV Viewer',
    description: 'Spreadsheet-style viewer for CSV files with sorting and filtering',
    filePatterns: ['.csv', '.tsv'],
    editorType: 'custom',
    icon: '📊',
    category: 'data',
  },
  {
    name: 'Markdown Preview',
    description: 'Live preview for Markdown files with syntax highlighting',
    filePatterns: ['.md', '.mdx'],
    editorType: 'custom',
    icon: '📝',
    category: 'document',
  },
  {
    name: 'JSON Viewer',
    description: 'Collapsible tree view for JSON files',
    filePatterns: ['.json'],
    editorType: 'custom',
    icon: '🔧',
    category: 'data',
  },
  {
    name: 'Image Viewer',
    description: 'Preview for common image formats',
    filePatterns: ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'],
    editorType: 'custom',
    icon: '🖼️',
    category: 'media',
  },
];

export class ExtensionManager {
  private stmtInsert: Database.Statement;
  private stmtGet: Database.Statement;
  private stmtList: Database.Statement;
  private stmtEnabled: Database.Statement;
  private stmtToggle: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtByPattern: Database.Statement;

  constructor(private db: Database.Database) {
    this.stmtInsert = db.prepare(
      'INSERT OR REPLACE INTO extensions (id, name, version, description, author, enabled, file_patterns, editor_type, entry_point, icon, category, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this.stmtGet = db.prepare('SELECT * FROM extensions WHERE id = ?');
    this.stmtList = db.prepare('SELECT * FROM extensions ORDER BY name ASC');
    this.stmtEnabled = db.prepare('SELECT * FROM extensions WHERE enabled = 1 ORDER BY name ASC');
    this.stmtToggle = db.prepare('UPDATE extensions SET enabled = ?, updated_at = ? WHERE id = ?');
    this.stmtDelete = db.prepare('DELETE FROM extensions WHERE id = ?');
    this.stmtByPattern = db.prepare('SELECT * FROM extensions WHERE enabled = 1');

    // Ensure built-in extensions are registered
    this.ensureBuiltins();
  }

  private ensureBuiltins(): void {
    for (const manifest of BUILTIN_EXTENSIONS) {
      const id = 'builtin:' + manifest.name.toLowerCase().replace(/\s+/g, '-');
      const existing = this.stmtGet.get(id) as any;
      if (!existing) {
        this.install({ ...manifest, version: '1.0.0' }, id);
      }
    }
  }

  install(manifest: ExtensionManifest, id?: string): Extension {
    const extId = id || randomUUID();
    const now = new Date().toISOString();
    this.stmtInsert.run(
      extId, manifest.name, manifest.version || '1.0.0',
      manifest.description || null, manifest.author || null,
      1, JSON.stringify(manifest.filePatterns), manifest.editorType,
      manifest.entryPoint || null, manifest.icon || null,
      manifest.category || 'general', now, now
    );
    return this.get(extId)!;
  }

  get(id: string): Extension | null {
    const row = this.stmtGet.get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  list(): Extension[] {
    return (this.stmtList.all() as any[]).map(r => this.mapRow(r));
  }

  listEnabled(): Extension[] {
    return (this.stmtEnabled.all() as any[]).map(r => this.mapRow(r));
  }

  toggle(id: string, enabled: boolean): boolean {
    const now = new Date().toISOString();
    return this.stmtToggle.run(enabled ? 1 : 0, now, id).changes > 0;
  }

  uninstall(id: string): boolean {
    // Don't allow uninstalling built-in extensions
    if (id.startsWith('builtin:')) return false;
    return this.stmtDelete.run(id).changes > 0;
  }

  /**
   * Find the best extension to handle a given file extension.
   * Returns null if no extension handles this file type.
   */
  findForFile(filePath: string): Extension | null {
    const ext = '.' + (filePath.split('.').pop() || '').toLowerCase();
    const enabled = this.listEnabled();
    for (const extension of enabled) {
      if (extension.filePatterns.includes(ext)) {
        return extension;
      }
    }
    return null;
  }

  private mapRow(row: any): Extension {
    let patterns: string[] = [];
    try { patterns = JSON.parse(row.file_patterns || '[]'); } catch {}
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description || undefined,
      author: row.author || undefined,
      enabled: row.enabled === 1,
      filePatterns: patterns,
      editorType: row.editor_type,
      entryPoint: row.entry_point || undefined,
      icon: row.icon || undefined,
      category: row.category || 'general',
      installedAt: row.installed_at,
      updatedAt: row.updated_at,
    };
  }
}
