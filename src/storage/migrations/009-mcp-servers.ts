import type Database from 'better-sqlite3';

export const version = 9;
export const description = 'MCP servers and OAuth tokens tables';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      url         TEXT NOT NULL,
      auth_type   TEXT NOT NULL CHECK(auth_type IN ('none', 'oauth2', 'api_key')),
      auth_config TEXT,
      status      TEXT NOT NULL DEFAULT 'disconnected',
      created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
      server_id      TEXT PRIMARY KEY REFERENCES mcp_servers(id) ON DELETE CASCADE,
      access_token   TEXT NOT NULL,
      refresh_token  TEXT NOT NULL,
      expires_at     DATETIME NOT NULL,
      created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
