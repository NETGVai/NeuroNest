import type Database from 'better-sqlite3';

export const version = 51;
export const description = 'MCP Marketplace: catalog and installations tables for the MCP marketplace feature';

export function up(db: Database.Database): void {
  db.exec(`
    -- MCP Catalog: stores the marketplace catalog of available MCP servers
    -- Requirements: 9.1
    CREATE TABLE IF NOT EXISTS mcp_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL DEFAULT '0.0.0',
      categories TEXT NOT NULL DEFAULT '[]',
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      url TEXT,
      rating REAL NOT NULL DEFAULT 0,
      downloads INTEGER NOT NULL DEFAULT 0,
      verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- MCP Catalog Metadata: key-value store for catalog sync state
    CREATE TABLE IF NOT EXISTS mcp_catalog_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- MCP Installations: tracks installed MCP servers per project
    -- Requirements: 9.3, 9.4, 9.5
    CREATE TABLE IF NOT EXISTS mcp_installations (
      id TEXT PRIMARY KEY,
      catalog_id TEXT NOT NULL,
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      installed_at INTEGER NOT NULL,
      last_health_check INTEGER NOT NULL DEFAULT 0,
      health_status TEXT NOT NULL DEFAULT 'unknown'
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_inst_status ON mcp_installations(status);
    CREATE INDEX IF NOT EXISTS idx_mcp_inst_catalog ON mcp_installations(catalog_id);
  `);
}
