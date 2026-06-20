/**
 * IPC handler registration for the Artifact System.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (diagnostics-ipc.ts, skill-packs-ipc.ts).
 *
 * Channels:
 *   artifact:list    — list artifacts by session or project
 *   artifact:get     — retrieve artifact metadata + content
 *   artifact:delete  — delete artifact (with confirmation expected from renderer)
 *   artifact:history — get checkpoint version history
 *   artifact:diff    — compute diff between two checkpoint versions
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { ArtifactService } from '../artifacts/artifact-service.js';
import type { Artifact, ArtifactCheckpoint } from '../shared/feature-integration-types.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface ArtifactIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let artifactService: ArtifactService | null = null;

function getArtifactService(db: Database.Database): ArtifactService {
  if (!artifactService) artifactService = new ArtifactService(db);
  return artifactService;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): ArtifactIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Serialization helpers ──────────────────────────────────────

/**
 * Convert a Buffer or string content to a plain string for IPC transport.
 */
function contentToString(content: Buffer | string): string {
  if (Buffer.isBuffer(content)) return content.toString('utf-8');
  return content;
}

/**
 * Serialize a checkpoint for IPC (strip heavy Buffer content, include metadata).
 */
function serializeCheckpointSummary(cp: ArtifactCheckpoint): object {
  return {
    id: cp.id,
    artifactId: cp.artifactId,
    version: cp.version,
    createdAt: cp.createdAt,
    hasDiff: !!cp.diff,
  };
}

// ─── Registration ───────────────────────────────────────────────

export function registerArtifactIPC(
  _mainWindow: BrowserWindow,
  db: Database.Database,
): void {
  // ── artifact:list ──
  // Requirement 2.1: List all artifacts for current project grouped by session
  ipcMain.handle(
    'artifact:list',
    async (
      _event,
      args: { sessionId?: string; projectDir?: string },
    ) => {
      try {
        const service = getArtifactService(db);

        if (args.sessionId) {
          return await service.listBySession(args.sessionId);
        }

        if (args.projectDir) {
          return await service.listByProject(args.projectDir);
        }

        return makeError('INVALID_ARGS', new Error('Either sessionId or projectDir is required'));
      } catch (err) {
        return makeError('ARTIFACT_LIST_FAILED', err);
      }
    },
  );

  // ── artifact:get ──
  // Requirement 2.2: Retrieve artifact metadata and content for preview
  ipcMain.handle(
    'artifact:get',
    async (_event, args: { artifactId: string; version?: number }) => {
      try {
        const service = getArtifactService(db);
        const artifact = await service.get(args.artifactId);

        if (!artifact) {
          return makeError('ARTIFACT_NOT_FOUND', new Error(`Artifact not found: ${args.artifactId}`));
        }

        const content = await service.getContent(args.artifactId, args.version);

        return {
          artifact,
          content: contentToString(content),
          version: args.version ?? undefined,
        };
      } catch (err) {
        return makeError('ARTIFACT_GET_FAILED', err);
      }
    },
  );

  // ── artifact:delete ──
  // Requirement 2.4: Delete artifact (confirmation handled by renderer before calling)
  ipcMain.handle(
    'artifact:delete',
    async (_event, args: { artifactId: string }) => {
      try {
        const service = getArtifactService(db);
        await service.delete(args.artifactId);
        return { success: true };
      } catch (err) {
        return makeError('ARTIFACT_DELETE_FAILED', err);
      }
    },
  );

  // ── artifact:history ──
  // Requirement 2.5: Get version history with checkpoint summaries
  ipcMain.handle(
    'artifact:history',
    async (_event, args: { artifactId: string }) => {
      try {
        const service = getArtifactService(db);
        const history = await service.getHistory(args.artifactId);
        return history.map(serializeCheckpointSummary);
      } catch (err) {
        return makeError('ARTIFACT_HISTORY_FAILED', err);
      }
    },
  );

  // ── artifact:diff ──
  // Requirement 2.5: Compute diff between two checkpoint versions
  ipcMain.handle(
    'artifact:diff',
    async (_event, args: { artifactId: string; v1: number; v2: number }) => {
      try {
        const service = getArtifactService(db);
        const diff = await service.diffCheckpoints(args.artifactId, args.v1, args.v2);
        return { diff, v1: args.v1, v2: args.v2 };
      } catch (err) {
        return makeError('ARTIFACT_DIFF_FAILED', err);
      }
    },
  );
}
