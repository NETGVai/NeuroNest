import type Database from 'better-sqlite3';

export const version = 33;
export const description = 'Encrypted secret store (secrets_v2) with envelope format';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets_v2 (
      key TEXT PRIMARY KEY,
      envelope TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
