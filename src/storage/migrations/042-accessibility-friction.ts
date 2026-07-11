import type Database from 'better-sqlite3';

export const version = 42;
export const description = 'Accessibility friction entries for GUI_Agent operability metrics';

export function up(db: Database.Database): void {
  db.exec(`
    -- Accessibility Friction: per-element operability metrics from GUI_Agent failures
    -- Only accessibility-specific issues (poor labeling, missing ARIA roles, non-semantic markup)
    -- General failures (network errors, timing) do NOT produce entries here.
    -- Requirements: 15.4, 15.5
    CREATE TABLE IF NOT EXISTS accessibility_friction (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      element_selector TEXT NOT NULL,
      issue TEXT NOT NULL CHECK(issue IN ('missing-label', 'no-aria-role', 'non-semantic-markup')),
      operability_score REAL NOT NULL DEFAULT 0,
      logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_accessibility_friction_project ON accessibility_friction(project_id);
  `);
}
