/**
 * Lineage Tracker
 *
 * Manages data lineage records in the `lineage` table, providing source
 * traceability for every Knowledge Graph node back to its exact source
 * location (file path, byte offset, line range, commit hash).
 *
 * Requirements: 7.1, 7.2, 7.4, 7.5
 */

import type Database from 'better-sqlite3';

export interface LineageRecord {
  id?: number;
  nodeId: string;
  projectId: string;
  filePath: string;
  startByte: number;
  endByte: number;
  startLine: number;
  endLine: number;
  commitHash: string | null;
  isStale: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export class LineageTracker {
  constructor(
    private db: Database.Database,
    private projectId: string = ''
  ) {}

  /**
   * Create a new lineage record linking a graph node to its source location.
   * Attaches file_path, start_byte, end_byte, start_line, end_line, and commit_hash.
   *
   * Requirement 7.1: Attach lineage record when a graph node is created.
   * Requirement 7.2: Store in dedicated SQLite table with FK to graph node identifier.
   */
  createRecord(record: Omit<LineageRecord, 'id' | 'isStale' | 'createdAt' | 'updatedAt'>): number {
    const stmt = this.db.prepare(`
      INSERT INTO lineage (node_id, project_id, file_path, start_byte, end_byte, start_line, end_line, commit_hash, is_stale, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch(), unixepoch())
    `);

    const result = stmt.run(
      record.nodeId,
      record.projectId || this.projectId,
      record.filePath,
      record.startByte,
      record.endByte,
      record.startLine,
      record.endLine,
      record.commitHash ?? null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Update all lineage records for a given file with new byte offsets and line numbers.
   * Called when a file is modified to keep lineage records in sync.
   *
   * Requirement 7.4: Update lineage records when files are modified.
   *
   * @param filePath - The file that was modified
   * @param updatedChunks - Array of updated chunk data with new positions
   */
  updateRecordsForFile(
    filePath: string,
    updatedChunks: Array<{
      nodeId: string;
      startByte: number;
      endByte: number;
      startLine: number;
      endLine: number;
      commitHash?: string | null;
    }>
  ): number {
    const updateStmt = this.db.prepare(`
      UPDATE lineage
      SET start_byte = ?, end_byte = ?, start_line = ?, end_line = ?, commit_hash = COALESCE(?, commit_hash), is_stale = 0, updated_at = unixepoch()
      WHERE node_id = ? AND file_path = ?
    `);

    let updatedCount = 0;

    const transaction = this.db.transaction(() => {
      for (const chunk of updatedChunks) {
        const result = updateStmt.run(
          chunk.startByte,
          chunk.endByte,
          chunk.startLine,
          chunk.endLine,
          chunk.commitHash ?? null,
          chunk.nodeId,
          filePath
        );
        updatedCount += result.changes;
      }
    });

    transaction();
    return updatedCount;
  }

  /**
   * Mark lineage records as stale when their byte range exceeds the current file size.
   * A record is stale if end_byte > currentFileSize.
   *
   * Requirement 7.5: Mark graph node as stale when byte range no longer exists.
   *
   * @param filePath - The file to check
   * @param currentFileSize - The current size of the file in bytes
   * @returns Number of records marked as stale
   */
  markStale(filePath: string, currentFileSize: number): number {
    const stmt = this.db.prepare(`
      UPDATE lineage
      SET is_stale = 1, updated_at = unixepoch()
      WHERE file_path = ? AND end_byte > ? AND is_stale = 0
    `);

    const result = stmt.run(filePath, currentFileSize);
    return result.changes;
  }

  /**
   * Get all lineage records for a given graph node ID.
   *
   * @param nodeId - The Knowledge Graph node identifier
   * @returns Array of lineage records for that node
   */
  getByNodeId(nodeId: string): LineageRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, node_id, project_id, file_path, start_byte, end_byte, start_line, end_line, commit_hash, is_stale, created_at, updated_at
      FROM lineage
      WHERE node_id = ?
    `);

    const rows = stmt.all(nodeId) as Array<{
      id: number;
      node_id: string;
      project_id: string;
      file_path: string;
      start_byte: number;
      end_byte: number;
      start_line: number;
      end_line: number;
      commit_hash: string | null;
      is_stale: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      projectId: row.project_id,
      filePath: row.file_path,
      startByte: row.start_byte,
      endByte: row.end_byte,
      startLine: row.start_line,
      endLine: row.end_line,
      commitHash: row.commit_hash,
      isStale: row.is_stale === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Remove all lineage records for a given file path.
   * Used when a file is deleted from the project.
   *
   * @param filePath - The file path whose lineage records should be removed
   * @returns Number of records removed
   */
  removeByFile(filePath: string): number {
    const stmt = this.db.prepare('DELETE FROM lineage WHERE file_path = ?');
    const result = stmt.run(filePath);
    return result.changes;
  }

  /**
   * Get all lineage records for a given file path.
   *
   * @param filePath - The file path to query
   * @returns Array of lineage records for that file
   */
  getByFile(filePath: string): LineageRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, node_id, project_id, file_path, start_byte, end_byte, start_line, end_line, commit_hash, is_stale, created_at, updated_at
      FROM lineage
      WHERE file_path = ?
    `);

    const rows = stmt.all(filePath) as Array<{
      id: number;
      node_id: string;
      project_id: string;
      file_path: string;
      start_byte: number;
      end_byte: number;
      start_line: number;
      end_line: number;
      commit_hash: string | null;
      is_stale: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      projectId: row.project_id,
      filePath: row.file_path,
      startByte: row.start_byte,
      endByte: row.end_byte,
      startLine: row.start_line,
      endLine: row.end_line,
      commitHash: row.commit_hash,
      isStale: row.is_stale === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Get all stale lineage records for a project.
   *
   * @returns Array of stale lineage records
   */
  getStaleRecords(): LineageRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, node_id, project_id, file_path, start_byte, end_byte, start_line, end_line, commit_hash, is_stale, created_at, updated_at
      FROM lineage
      WHERE is_stale = 1 AND (project_id = ? OR ? = '')
    `);

    const rows = stmt.all(this.projectId, this.projectId) as Array<{
      id: number;
      node_id: string;
      project_id: string;
      file_path: string;
      start_byte: number;
      end_byte: number;
      start_line: number;
      end_line: number;
      commit_hash: string | null;
      is_stale: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.node_id,
      projectId: row.project_id,
      filePath: row.file_path,
      startByte: row.start_byte,
      endByte: row.end_byte,
      startLine: row.start_line,
      endLine: row.end_line,
      commitHash: row.commit_hash,
      isStale: row.is_stale === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
