/**
 * ArtifactService — Manages artifact lifecycle: creation, versioning (checkpoints),
 * retrieval, and deletion. Persists to SQLite via existing database patterns.
 *
 * Registers `artifact-store` and `artifact-retrieve` tools in the ToolSystem.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */

import Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';
import type {
  Artifact,
  ArtifactCheckpoint,
  ArtifactType,
  CreateArtifactParams,
} from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import type { ToolSystem, ExecutableToolDefinition } from '../tools/tool-system.js';
import type { ToolContext, ToolResult } from '../shared/types.js';

// ─── Unified Diff Utility ───────────────────────────────────────

/**
 * Compute a unified diff between two text strings.
 * Returns a unified diff string with context lines.
 */
function computeUnifiedDiff(oldText: string, newText: string, contextLines = 3): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Simple LCS-based diff
  const lcs = computeLCS(oldLines, newLines);
  const hunks = buildHunks(oldLines, newLines, lcs, contextLines);

  if (hunks.length === 0) {
    return '';
  }

  const header = `--- a/artifact\n+++ b/artifact\n`;
  return header + hunks.join('\n') + '\n';
}

/**
 * Compute the Longest Common Subsequence table.
 */
function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/**
 * Build unified diff hunks from the LCS table.
 */
function buildHunks(oldLines: string[], newLines: string[], dp: number[][], context: number): string[] {
  // Backtrack to get the diff operations
  const ops: Array<{ type: 'equal' | 'delete' | 'insert'; oldIdx?: number; newIdx?: number }> = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift({ type: 'equal', oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ type: 'insert', newIdx: j - 1 });
      j--;
    } else {
      ops.unshift({ type: 'delete', oldIdx: i - 1 });
      i--;
    }
  }

  // Group operations into hunks with context
  const hunks: string[] = [];
  let hunkStart = -1;
  let hunkEnd = -1;

  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].type !== 'equal') {
      const start = Math.max(0, idx - context);
      const end = Math.min(ops.length - 1, idx + context);

      if (hunkStart === -1) {
        hunkStart = start;
        hunkEnd = end;
      } else if (start <= hunkEnd + 1) {
        hunkEnd = end;
      } else {
        // Emit previous hunk
        hunks.push(formatHunk(ops, oldLines, newLines, hunkStart, hunkEnd));
        hunkStart = start;
        hunkEnd = end;
      }
    }
  }

  if (hunkStart !== -1) {
    hunks.push(formatHunk(ops, oldLines, newLines, hunkStart, hunkEnd));
  }

  return hunks;
}

function formatHunk(
  ops: Array<{ type: 'equal' | 'delete' | 'insert'; oldIdx?: number; newIdx?: number }>,
  oldLines: string[],
  newLines: string[],
  start: number,
  end: number,
): string {
  let oldStart = 1;
  let newStart = 1;
  let oldCount = 0;
  let newCount = 0;

  // Compute old/new line numbers for the hunk header
  let foundFirst = false;
  for (let idx = 0; idx < start; idx++) {
    if (ops[idx].type === 'equal' || ops[idx].type === 'delete') oldStart++;
    if (ops[idx].type === 'equal' || ops[idx].type === 'insert') newStart++;
  }

  const lines: string[] = [];
  for (let idx = start; idx <= end; idx++) {
    const op = ops[idx];
    if (op.type === 'equal') {
      lines.push(` ${oldLines[op.oldIdx!]}`);
      oldCount++;
      newCount++;
    } else if (op.type === 'delete') {
      lines.push(`-${oldLines[op.oldIdx!]}`);
      oldCount++;
    } else if (op.type === 'insert') {
      lines.push(`+${newLines[op.newIdx!]}`);
      newCount++;
    }
  }

  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return header + '\n' + lines.join('\n');
}

// ─── ArtifactService Class ──────────────────────────────────────

export class ArtifactService {
  private db: Database.Database;

  // Prepared statements
  private stmtInsertArtifact: Database.Statement;
  private stmtGetArtifact: Database.Statement;
  private stmtListBySession: Database.Statement;
  private stmtListByProject: Database.Statement;
  private stmtUpdateTimestamp: Database.Statement;
  private stmtDeleteArtifact: Database.Statement;
  private stmtInsertCheckpoint: Database.Statement;
  private stmtGetLatestCheckpoint: Database.Statement;
  private stmtGetCheckpointByVersion: Database.Statement;
  private stmtGetMaxVersion: Database.Statement;
  private stmtGetHistory: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    this.stmtInsertArtifact = db.prepare(
      `INSERT INTO artifacts (id, session_id, project_dir, title, type, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmtGetArtifact = db.prepare(
      `SELECT id, session_id, project_dir, title, type, metadata, created_at, updated_at
       FROM artifacts WHERE id = ?`,
    );

    this.stmtListBySession = db.prepare(
      `SELECT id, session_id, project_dir, title, type, metadata, created_at, updated_at
       FROM artifacts WHERE session_id = ? ORDER BY created_at DESC`,
    );

    this.stmtListByProject = db.prepare(
      `SELECT id, session_id, project_dir, title, type, metadata, created_at, updated_at
       FROM artifacts WHERE project_dir = ? ORDER BY created_at DESC`,
    );

    this.stmtUpdateTimestamp = db.prepare(
      `UPDATE artifacts SET updated_at = ? WHERE id = ?`,
    );

    this.stmtDeleteArtifact = db.prepare(
      `DELETE FROM artifacts WHERE id = ?`,
    );

    this.stmtInsertCheckpoint = db.prepare(
      `INSERT INTO artifact_checkpoints (id, artifact_id, version, content, diff, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.stmtGetLatestCheckpoint = db.prepare(
      `SELECT id, artifact_id, version, content, diff, created_at
       FROM artifact_checkpoints WHERE artifact_id = ? ORDER BY version DESC LIMIT 1`,
    );

    this.stmtGetCheckpointByVersion = db.prepare(
      `SELECT id, artifact_id, version, content, diff, created_at
       FROM artifact_checkpoints WHERE artifact_id = ? AND version = ?`,
    );

    this.stmtGetMaxVersion = db.prepare(
      `SELECT MAX(version) as max_version FROM artifact_checkpoints WHERE artifact_id = ?`,
    );

    this.stmtGetHistory = db.prepare(
      `SELECT id, artifact_id, version, content, diff, created_at
       FROM artifact_checkpoints WHERE artifact_id = ? ORDER BY version ASC`,
    );
  }

  /**
   * Create a new artifact with initial content (version 1 checkpoint).
   */
  async create(params: CreateArtifactParams): Promise<Artifact> {
    const now = new Date().toISOString();
    const artifactId = uuidv7();
    const checkpointId = uuidv7();
    const metadata = params.metadata ?? {};

    const contentBuffer = typeof params.content === 'string'
      ? Buffer.from(params.content, 'utf-8')
      : params.content;

    this.db.transaction(() => {
      this.stmtInsertArtifact.run(
        artifactId,
        params.sessionId,
        params.projectDir,
        params.title,
        params.type,
        JSON.stringify(metadata),
        now,
        now,
      );

      this.stmtInsertCheckpoint.run(
        checkpointId,
        artifactId,
        1, // first version
        contentBuffer,
        null, // no diff for first version
        now,
      );
    })();

    return {
      id: artifactId,
      sessionId: params.sessionId,
      title: params.title,
      type: params.type,
      createdAt: now,
      updatedAt: now,
      metadata,
    };
  }

  /**
   * Get an artifact by ID, or null if not found.
   */
  async get(artifactId: string): Promise<Artifact | null> {
    const row = this.stmtGetArtifact.get(artifactId) as ArtifactRow | undefined;
    if (!row) return null;
    return rowToArtifact(row);
  }

  /**
   * Get the content of an artifact at a specific version (defaults to latest).
   */
  async getContent(artifactId: string, version?: number): Promise<Buffer | string> {
    let row: CheckpointRow | undefined;

    if (version !== undefined) {
      row = this.stmtGetCheckpointByVersion.get(artifactId, version) as CheckpointRow | undefined;
    } else {
      row = this.stmtGetLatestCheckpoint.get(artifactId) as CheckpointRow | undefined;
    }

    if (!row) {
      throw new FeatureError({
        message: version !== undefined
          ? `Checkpoint version ${version} not found for artifact ${artifactId}`
          : `No checkpoints found for artifact ${artifactId}`,
        category: 'artifact',
        code: 'CHECKPOINT_NOT_FOUND',
        details: { artifactId, version },
      });
    }

    // Content is stored as BLOB; return as Buffer
    return Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
  }

  /**
   * List all artifacts for a given session.
   */
  async listBySession(sessionId: string): Promise<Artifact[]> {
    const rows = this.stmtListBySession.all(sessionId) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  /**
   * List all artifacts for a given project directory.
   */
  async listByProject(projectDir: string): Promise<Artifact[]> {
    const rows = this.stmtListByProject.all(projectDir) as ArtifactRow[];
    return rows.map(rowToArtifact);
  }

  /**
   * Update an artifact with new content, creating a new checkpoint.
   * Computes unified diff from the previous version.
   */
  async update(artifactId: string, content: Buffer | string): Promise<ArtifactCheckpoint> {
    const artifact = await this.get(artifactId);
    if (!artifact) {
      throw new FeatureError({
        message: `Artifact not found: ${artifactId}`,
        category: 'artifact',
        code: 'ARTIFACT_NOT_FOUND',
        details: { artifactId },
      });
    }

    const now = new Date().toISOString();
    const checkpointId = uuidv7();

    // Get current max version
    const versionRow = this.stmtGetMaxVersion.get(artifactId) as { max_version: number | null };
    const newVersion = (versionRow.max_version ?? 0) + 1;

    const contentBuffer = typeof content === 'string'
      ? Buffer.from(content, 'utf-8')
      : content;

    // Compute diff from previous version
    let diff: string | null = null;
    if (newVersion > 1) {
      try {
        const prevContent = await this.getContent(artifactId, newVersion - 1);
        const prevText = Buffer.isBuffer(prevContent) ? prevContent.toString('utf-8') : prevContent;
        const newText = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
        diff = computeUnifiedDiff(prevText, newText);
      } catch {
        // If previous content is binary or unavailable, skip diff
        diff = null;
      }
    }

    this.db.transaction(() => {
      this.stmtInsertCheckpoint.run(
        checkpointId,
        artifactId,
        newVersion,
        contentBuffer,
        diff,
        now,
      );

      this.stmtUpdateTimestamp.run(now, artifactId);
    })();

    return {
      id: checkpointId,
      artifactId,
      version: newVersion,
      content: contentBuffer,
      createdAt: now,
      diff: diff ?? undefined,
    };
  }

  /**
   * Delete an artifact and all its checkpoints (CASCADE).
   */
  async delete(artifactId: string): Promise<void> {
    const result = this.stmtDeleteArtifact.run(artifactId);
    if (result.changes === 0) {
      throw new FeatureError({
        message: `Artifact not found: ${artifactId}`,
        category: 'artifact',
        code: 'ARTIFACT_NOT_FOUND',
        details: { artifactId },
      });
    }
  }

  /**
   * Get the full version history of an artifact.
   */
  async getHistory(artifactId: string): Promise<ArtifactCheckpoint[]> {
    const rows = this.stmtGetHistory.all(artifactId) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  /**
   * Compute the unified diff between two specific checkpoint versions.
   */
  async diffCheckpoints(artifactId: string, v1: number, v2: number): Promise<string> {
    const cp1 = this.stmtGetCheckpointByVersion.get(artifactId, v1) as CheckpointRow | undefined;
    const cp2 = this.stmtGetCheckpointByVersion.get(artifactId, v2) as CheckpointRow | undefined;

    if (!cp1) {
      throw new FeatureError({
        message: `Checkpoint version ${v1} not found for artifact ${artifactId}`,
        category: 'artifact',
        code: 'CHECKPOINT_NOT_FOUND',
        details: { artifactId, version: v1 },
      });
    }

    if (!cp2) {
      throw new FeatureError({
        message: `Checkpoint version ${v2} not found for artifact ${artifactId}`,
        category: 'artifact',
        code: 'CHECKPOINT_NOT_FOUND',
        details: { artifactId, version: v2 },
      });
    }

    const text1 = Buffer.isBuffer(cp1.content)
      ? cp1.content.toString('utf-8')
      : Buffer.from(cp1.content).toString('utf-8');
    const text2 = Buffer.isBuffer(cp2.content)
      ? cp2.content.toString('utf-8')
      : Buffer.from(cp2.content).toString('utf-8');

    return computeUnifiedDiff(text1, text2);
  }

  /**
   * Register artifact tools with the ToolSystem.
   */
  registerTools(toolSystem: ToolSystem): void {
    toolSystem.register(createArtifactStoreTool(this));
    toolSystem.register(createArtifactRetrieveTool(this));
  }
}

// ─── Database Row Types ─────────────────────────────────────────

interface ArtifactRow {
  id: string;
  session_id: string;
  project_dir: string;
  title: string;
  type: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  id: string;
  artifact_id: string;
  version: number;
  content: Buffer | Uint8Array;
  diff: string | null;
  created_at: string;
}

// ─── Row Mapping Helpers ────────────────────────────────────────

function rowToArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    type: row.type as ArtifactType,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

function rowToCheckpoint(row: CheckpointRow): ArtifactCheckpoint {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
    createdAt: row.created_at,
    diff: row.diff ?? undefined,
  };
}

// ─── Tool Definitions ───────────────────────────────────────────

function createArtifactStoreTool(service: ArtifactService): ExecutableToolDefinition {
  return {
    id: 'artifact-store',
    name: 'ArtifactStore',
    description: 'Create or update an artifact. For new artifacts, provide sessionId, projectDir, title, type, and content. For updates, provide artifactId and content.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to perform: "create" or "update"',
          enum: ['create', 'update'],
        },
        // Create params
        sessionId: { type: 'string', description: 'Session ID (required for create)' },
        projectDir: { type: 'string', description: 'Project directory path (required for create)' },
        title: { type: 'string', description: 'Human-readable artifact title (required for create)' },
        artifactType: {
          type: 'string',
          description: 'Artifact type (required for create)',
          enum: ['code-bundle', 'document', 'spreadsheet-data', 'diagram', 'generated-app'],
        },
        // Update params
        artifactId: { type: 'string', description: 'Artifact ID (required for update)' },
        // Shared
        content: { type: 'string', description: 'Artifact content (required for both create and update)' },
        metadata: { type: 'object', description: 'Optional metadata (create only)' },
      },
      required: ['action', 'content'],
    },
    riskLevel: 'write',
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = input as Record<string, unknown>;
      const action = params.action as string;
      const content = params.content as string;

      try {
        if (action === 'create') {
          const sessionId = (params.sessionId as string) || context.sessionId;
          const projectDir = (params.projectDir as string) || context.projectDir || '';
          const title = params.title as string;
          const artifactType = params.artifactType as ArtifactType;

          if (!title) {
            return { success: false, output: null, error: 'Missing required parameter: title' };
          }
          if (!artifactType) {
            return { success: false, output: null, error: 'Missing required parameter: artifactType' };
          }

          const artifact = await service.create({
            sessionId,
            projectDir,
            title,
            type: artifactType,
            content,
            metadata: params.metadata as Record<string, unknown> | undefined,
          });

          return { success: true, output: artifact };
        } else if (action === 'update') {
          const artifactId = params.artifactId as string;
          if (!artifactId) {
            return { success: false, output: null, error: 'Missing required parameter: artifactId' };
          }

          const checkpoint = await service.update(artifactId, content);
          return { success: true, output: checkpoint };
        } else {
          return { success: false, output: null, error: `Unknown action: ${action}` };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: message };
      }
    },
  };
}

function createArtifactRetrieveTool(service: ArtifactService): ExecutableToolDefinition {
  return {
    id: 'artifact-retrieve',
    name: 'ArtifactRetrieve',
    description: 'Retrieve an artifact by ID, list artifacts by session or project, get version history, or diff between versions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action: "get", "getContent", "listBySession", "listByProject", "history", "diff"',
          enum: ['get', 'getContent', 'listBySession', 'listByProject', 'history', 'diff'],
        },
        artifactId: { type: 'string', description: 'Artifact ID (for get, getContent, history, diff)' },
        sessionId: { type: 'string', description: 'Session ID (for listBySession)' },
        projectDir: { type: 'string', description: 'Project directory (for listByProject)' },
        version: { type: 'number', description: 'Version number (for getContent)' },
        v1: { type: 'number', description: 'First version (for diff)' },
        v2: { type: 'number', description: 'Second version (for diff)' },
      },
      required: ['action'],
    },
    riskLevel: 'read-only',
    execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
      const params = input as Record<string, unknown>;
      const action = params.action as string;

      try {
        switch (action) {
          case 'get': {
            const artifactId = params.artifactId as string;
            if (!artifactId) {
              return { success: false, output: null, error: 'Missing required parameter: artifactId' };
            }
            const artifact = await service.get(artifactId);
            if (!artifact) {
              return { success: false, output: null, error: `Artifact not found: ${artifactId}` };
            }
            return { success: true, output: artifact };
          }

          case 'getContent': {
            const artifactId = params.artifactId as string;
            if (!artifactId) {
              return { success: false, output: null, error: 'Missing required parameter: artifactId' };
            }
            const version = params.version as number | undefined;
            const content = await service.getContent(artifactId, version);
            const contentStr = Buffer.isBuffer(content) ? content.toString('utf-8') : content;
            return { success: true, output: { content: contentStr, version } };
          }

          case 'listBySession': {
            const sessionId = (params.sessionId as string) || context.sessionId;
            const artifacts = await service.listBySession(sessionId);
            return { success: true, output: artifacts };
          }

          case 'listByProject': {
            const projectDir = (params.projectDir as string) || context.projectDir || '';
            const artifacts = await service.listByProject(projectDir);
            return { success: true, output: artifacts };
          }

          case 'history': {
            const artifactId = params.artifactId as string;
            if (!artifactId) {
              return { success: false, output: null, error: 'Missing required parameter: artifactId' };
            }
            const history = await service.getHistory(artifactId);
            // Return history without content blobs to keep response lightweight
            const summary = history.map((cp) => ({
              id: cp.id,
              artifactId: cp.artifactId,
              version: cp.version,
              createdAt: cp.createdAt,
              hasDiff: !!cp.diff,
            }));
            return { success: true, output: summary };
          }

          case 'diff': {
            const artifactId = params.artifactId as string;
            const v1 = params.v1 as number;
            const v2 = params.v2 as number;
            if (!artifactId) {
              return { success: false, output: null, error: 'Missing required parameter: artifactId' };
            }
            if (v1 === undefined || v2 === undefined) {
              return { success: false, output: null, error: 'Missing required parameters: v1, v2' };
            }
            const diff = await service.diffCheckpoints(artifactId, v1, v2);
            return { success: true, output: { diff, v1, v2 } };
          }

          default:
            return { success: false, output: null, error: `Unknown action: ${action}` };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, output: null, error: message };
      }
    },
  };
}

// ─── Exported diff utility for testing ──────────────────────────

export { computeUnifiedDiff };
