/**
 * SteeringService — Loads and manages steering files from `.neuronest/steering/`.
 *
 * Steering files are Markdown documents that provide project-level instructions,
 * conventions, and architectural guidelines to the agent. They are prepended to
 * the system prompt before every LLM invocation.
 *
 * Supports three inclusion modes:
 * - 'always': always included in the prompt (default)
 * - 'file-match': included when context files match glob patterns
 * - 'manual': only included when explicitly referenced by the user
 *
 * Metadata is persisted in the `steering_files` SQLite table.
 * File content is stored on disk in `.neuronest/steering/`.
 *
 * Feature-gated via `production_ux_steering` — all methods return empty/no-op
 * when the flag is disabled.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { minimatch } from 'minimatch';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SteeringFile {
  id: string;
  name: string;
  path: string;
  inclusionMode: 'always' | 'file-match' | 'manual';
  filePatterns?: string[];
  content: string;
  priority: number;
}

interface SteeringFileRow {
  id: string;
  name: string;
  file_path: string;
  inclusion_mode: 'always' | 'file-match' | 'manual';
  file_patterns: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

// ─── SteeringService Implementation ────────────────────────────

export class SteeringService {
  private readonly projectDir: string;
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly steeringDir: string;

  // Prepared statements
  private readonly stmtSelectAll: Database.Statement;
  private readonly stmtSelectById: Database.Statement;
  private readonly stmtInsert: Database.Statement;
  private readonly stmtUpdateContent: Database.Statement;
  private readonly stmtDelete: Database.Statement;

  constructor(projectDir: string, db: Database.Database, featureGate: FeatureGateSystem) {
    this.projectDir = projectDir;
    this.db = db;
    this.featureGate = featureGate;
    this.steeringDir = path.join(projectDir, '.neuronest', 'steering');

    this.stmtSelectAll = this.db.prepare(
      'SELECT id, name, file_path, inclusion_mode, file_patterns, priority, created_at, updated_at FROM steering_files ORDER BY priority DESC, created_at ASC',
    );

    this.stmtSelectById = this.db.prepare(
      'SELECT id, name, file_path, inclusion_mode, file_patterns, priority, created_at, updated_at FROM steering_files WHERE id = ?',
    );

    this.stmtInsert = this.db.prepare(
      `INSERT INTO steering_files (id, name, file_path, inclusion_mode, file_patterns, priority)
       VALUES (@id, @name, @filePath, @inclusionMode, @filePatterns, @priority)`,
    );

    this.stmtUpdateContent = this.db.prepare(
      `UPDATE steering_files SET updated_at = datetime('now') WHERE id = ?`,
    );

    this.stmtDelete = this.db.prepare(
      'DELETE FROM steering_files WHERE id = ?',
    );
  }

  /**
   * Load all steering files from `.neuronest/steering/` directory.
   * Reads metadata from SQLite and content from disk.
   * Returns empty array when feature is disabled.
   */
  loadAll(): SteeringFile[] {
    if (!this.isEnabled()) return [];

    const rows = this.stmtSelectAll.all() as SteeringFileRow[];
    const steeringFiles: SteeringFile[] = [];

    for (const row of rows) {
      const content = this.readFileContent(row.file_path);
      if (content === null) continue; // Skip files that no longer exist on disk

      steeringFiles.push(this.rowToSteeringFile(row, content));
    }

    return steeringFiles;
  }

  /**
   * Get the active steering content to prepend to the system prompt,
   * based on the current context files.
   *
   * Inclusion logic:
   * - 'always' mode: always included
   * - 'file-match' mode: included if any context file matches the glob patterns
   * - 'manual' mode: never auto-included (must be explicitly referenced)
   *
   * Results are ordered by priority (descending) then creation time (ascending).
   */
  getActiveContent(contextFiles: string[]): string {
    if (!this.isEnabled()) return '';

    const allFiles = this.loadAll();
    const activeFiles: SteeringFile[] = [];

    for (const file of allFiles) {
      if (this.shouldInclude(file, contextFiles)) {
        activeFiles.push(file);
      }
    }

    if (activeFiles.length === 0) return '';

    // Combine content from all active steering files, separated by newlines
    return activeFiles
      .map((f) => `### ${f.name}\n${f.content}`)
      .join('\n\n');
  }

  /**
   * Create a new steering file.
   * Writes the content to disk and persists metadata to SQLite.
   */
  create(
    name: string,
    content: string,
    mode: SteeringFile['inclusionMode'],
    options?: { filePatterns?: string[]; priority?: number },
  ): SteeringFile {
    const id = randomUUID();
    const fileName = this.sanitizeFileName(name) + '.md';
    const filePath = path.join(this.steeringDir, fileName);
    const priority = options?.priority ?? 0;
    const filePatterns = options?.filePatterns;

    // Ensure the steering directory exists
    fs.mkdirSync(this.steeringDir, { recursive: true });

    // Write content to disk
    fs.writeFileSync(filePath, content, 'utf-8');

    // Persist metadata to SQLite
    this.stmtInsert.run({
      id,
      name,
      filePath,
      inclusionMode: mode,
      filePatterns: filePatterns ? JSON.stringify(filePatterns) : null,
      priority,
    });

    const result: SteeringFile = {
      id,
      name,
      path: filePath,
      inclusionMode: mode,
      content,
      priority,
    };

    if (filePatterns) {
      result.filePatterns = filePatterns;
    }

    return result;
  }

  /**
   * Update a steering file's content on disk.
   * Also updates the `updated_at` timestamp in the database.
   */
  update(id: string, content: string): void {
    const row = this.stmtSelectById.get(id) as SteeringFileRow | undefined;
    if (!row) return;

    // Write updated content to disk
    fs.writeFileSync(row.file_path, content, 'utf-8');

    // Touch the updated_at timestamp
    this.stmtUpdateContent.run(id);
  }

  /**
   * Delete a steering file.
   * Removes both the database metadata and the file on disk.
   */
  delete(id: string): void {
    const row = this.stmtSelectById.get(id) as SteeringFileRow | undefined;
    if (!row) return;

    // Remove from database
    this.stmtDelete.run(id);

    // Remove file from disk (if it exists)
    try {
      if (fs.existsSync(row.file_path)) {
        fs.unlinkSync(row.file_path);
      }
    } catch {
      // Best-effort cleanup; don't throw if file is already gone
    }
  }

  // ─── Private Methods ────────────────────────────────────────────

  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_steering');
  }

  /**
   * Determine if a steering file should be included based on its mode
   * and the current context files.
   */
  private shouldInclude(file: SteeringFile, contextFiles: string[]): boolean {
    switch (file.inclusionMode) {
      case 'always':
        return true;

      case 'file-match':
        return this.matchesFilePatterns(file.filePatterns ?? [], contextFiles);

      case 'manual':
        return false;

      default:
        return false;
    }
  }

  /**
   * Check if any of the context files match any of the given glob patterns.
   * Uses minimatch for glob matching.
   */
  private matchesFilePatterns(patterns: string[], contextFiles: string[]): boolean {
    if (patterns.length === 0 || contextFiles.length === 0) return false;

    for (const contextFile of contextFiles) {
      // Match against both the full path and the relative path from project dir
      const relativePath = path.relative(this.projectDir, contextFile);

      for (const pattern of patterns) {
        if (minimatch(contextFile, pattern) || minimatch(relativePath, pattern)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Read the content of a steering file from disk.
   * Returns null if the file doesn't exist.
   */
  private readFileContent(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Sanitize a name for use as a filename.
   * Replaces non-alphanumeric characters with hyphens, lowercased.
   */
  private sanitizeFileName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Convert a database row to a SteeringFile interface.
   */
  private rowToSteeringFile(row: SteeringFileRow, content: string): SteeringFile {
    const result: SteeringFile = {
      id: row.id,
      name: row.name,
      path: row.file_path,
      inclusionMode: row.inclusion_mode,
      content,
      priority: row.priority,
    };

    if (row.file_patterns) {
      result.filePatterns = JSON.parse(row.file_patterns);
    }

    return result;
  }
}
