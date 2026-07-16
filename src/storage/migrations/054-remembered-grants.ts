import type Database from 'better-sqlite3';

export const version = 54;
export const description = 'Remembered Grants: per-project authorization decisions and dangerous-command list';

export function up(db: Database.Database): void {
  db.exec(`
    -- Persisted authorization grants keyed by project, tool, and argument prefix
    CREATE TABLE IF NOT EXISTS remembered_grants (
      project_id TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      arg_prefix TEXT NOT NULL DEFAULT '',
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, tool_id, arg_prefix)
    );

    CREATE INDEX IF NOT EXISTS idx_rg_project ON remembered_grants(project_id);
    CREATE INDEX IF NOT EXISTS idx_rg_tool ON remembered_grants(tool_id);

    -- Dangerous commands that always require approval regardless of grants
    CREATE TABLE IF NOT EXISTS dangerous_commands (
      pattern TEXT NOT NULL PRIMARY KEY,
      category TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dc_category ON dangerous_commands(category);
  `);

  // Seed the dangerous_commands table with default entries
  const insert = db.prepare(
    'INSERT OR IGNORE INTO dangerous_commands (pattern, category) VALUES (?, ?)',
  );

  const dangerousDefaults: Array<[string, string]> = [
    // Recursive deletion
    ['rm -rf', 'recursive-deletion'],
    ['rm -r', 'recursive-deletion'],
    ['rimraf', 'recursive-deletion'],
    // Force push
    ['git push --force', 'force-push'],
    ['git push -f', 'force-push'],
    ['git push --force-with-lease', 'force-push'],
    // Package publishing
    ['npm publish', 'package-publishing'],
    ['yarn publish', 'package-publishing'],
    ['pnpm publish', 'package-publishing'],
    // Credential writes
    ['.env', 'credential-write'],
    ['.pem', 'credential-write'],
    ['.key', 'credential-write'],
    ['credentials', 'credential-write'],
    ['.ssh/', 'credential-write'],
  ];

  for (const [pattern, category] of dangerousDefaults) {
    insert.run(pattern, category);
  }
}
