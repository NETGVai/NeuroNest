import type Database from 'better-sqlite3';

export const version = 13;
export const description = 'Extension system registry';

export function up(db: Database.Database): void {
  db.exec(`
    -- Installed extensions registry
    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '1.0.0',
      description TEXT,
      author TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      file_patterns TEXT,          -- JSON array of file extensions this handles (e.g. [".csv", ".excalidraw"])
      editor_type TEXT,            -- 'monaco', 'iframe', 'custom'
      entry_point TEXT,            -- path to the extension's main file
      icon TEXT,                   -- emoji or icon path
      category TEXT DEFAULT 'general',
      installed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_extensions_enabled ON extensions(enabled);
  `);
}
