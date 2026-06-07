import type Database from 'better-sqlite3';

export const version = 10;
export const description = 'Full-text search index for long_term_memory';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ltm_fts USING fts5(
      key, value, content='long_term_memory', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS ltm_ai AFTER INSERT ON long_term_memory BEGIN
      INSERT INTO ltm_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
    END;

    CREATE TRIGGER IF NOT EXISTS ltm_ad AFTER DELETE ON long_term_memory BEGIN
      INSERT INTO ltm_fts(ltm_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
    END;

    CREATE TRIGGER IF NOT EXISTS ltm_au AFTER UPDATE ON long_term_memory BEGIN
      INSERT INTO ltm_fts(ltm_fts, rowid, key, value) VALUES ('delete', old.rowid, old.key, old.value);
      INSERT INTO ltm_fts(rowid, key, value) VALUES (new.rowid, new.key, new.value);
    END;
  `);
}
