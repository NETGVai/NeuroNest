/**
 * Version-Guarded File Operations — Atomic writes with version guards derived
 * from read-before-edit state. Rejects writes on version conflict with zero
 * byte mutation on conflict.
 *
 * Requirements: 23.2–23.3
 */

import { createHash } from 'node:crypto';
import type {
  VersionGuardedWriteRequest,
  VersionGuardedWriteResult,
  FileVersionGuard,
} from './bounded-operations-schemas';
import { VersionGuardedWriteRequestSchema } from './bounded-operations-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Filesystem authority port for performing version-guarded writes.
 */
export interface FileOpsFilesystemPort {
  /** Read current version and content hash for a file. */
  readFileVersion(path: string, executionWorldId: string): Promise<FileState | null>;
  /** Perform atomic write replacement. Returns the new version on success. */
  atomicWrite(path: string, content: string, executionWorldId: string): Promise<string>;
}

/**
 * Security authority port for verifying write access within execution world.
 */
export interface FileOpsSecurityPort {
  /** Verify that the given path is writable within the execution world and scope. */
  verifyWriteAccess(
    path: string,
    executionWorldId: string,
    scope: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface FileState {
  version: string;
  contentHash: string;
  sizeBytes: number;
}

export interface VersionGuardedFileOpsDeps {
  filesystem: FileOpsFilesystemPort;
  security: FileOpsSecurityPort;
}

// ─── Version-Guarded File Operations Service ────────────────────

/**
 * Manages atomic file writes with version guards. Uses an atomic replacement
 * strategy where a write succeeds only if the file's current version matches
 * the expected version from the read-before-edit state.
 */
export class VersionGuardedFileOps {
  private readonly deps: VersionGuardedFileOpsDeps;

  constructor(deps: VersionGuardedFileOpsDeps) {
    this.deps = deps;
  }

  /**
   * Perform a version-guarded atomic write.
   *
   * Requirement 23.2: Uses atomic replacement strategy with version guard
   * derived from read-before-edit state.
   *
   * Requirement 23.3: Rejects write if version guard does not match current
   * file state. Returns conflict result containing no overwritten content.
   */
  async write(request: VersionGuardedWriteRequest): Promise<VersionGuardedWriteResult> {
    // Validate request
    const validation = VersionGuardedWriteRequestSchema.safeParse(request);
    if (!validation.success) {
      return {
        requestId: request.requestId,
        path: request.path,
        outcome: 'denied',
        schemaVersion: 1,
      };
    }

    // Verify write access through Security_Authority
    const hasAccess = await this.deps.security.verifyWriteAccess(
      request.path,
      request.executionWorldId,
      request.scope,
    );
    if (!hasAccess) {
      return {
        requestId: request.requestId,
        path: request.path,
        outcome: 'denied',
        schemaVersion: 1,
      };
    }

    // Read current file state to check version guard
    const currentState = await this.deps.filesystem.readFileVersion(
      request.path,
      request.executionWorldId,
    );

    // If file doesn't exist and version guard expects it to, that's a conflict
    if (!currentState && request.versionGuard.expectedVersion !== '__new__') {
      return {
        requestId: request.requestId,
        path: request.path,
        outcome: 'conflict',
        conflictVersion: '__missing__',
        schemaVersion: 1,
      };
    }

    // Requirement 23.3: Check version guard match
    if (currentState && currentState.version !== request.versionGuard.expectedVersion) {
      return {
        requestId: request.requestId,
        path: request.path,
        outcome: 'conflict',
        conflictVersion: currentState.version,
        schemaVersion: 1,
      };
    }

    // If content hash is specified, verify it matches too
    if (request.versionGuard.contentHash && currentState) {
      if (currentState.contentHash !== request.versionGuard.contentHash) {
        return {
          requestId: request.requestId,
          path: request.path,
          outcome: 'conflict',
          conflictVersion: currentState.version,
          schemaVersion: 1,
        };
      }
    }

    // Requirement 23.2: Perform atomic write
    const newVersion = await this.deps.filesystem.atomicWrite(
      request.path,
      request.content,
      request.executionWorldId,
    );

    return {
      requestId: request.requestId,
      path: request.path,
      outcome: 'written',
      newVersion,
      bytesWritten: Buffer.byteLength(request.content, 'utf-8'),
      schemaVersion: 1,
    };
  }

  /**
   * Compute a version guard from current file state (for read-before-edit flow).
   */
  async readVersionGuard(
    path: string,
    executionWorldId: string,
  ): Promise<FileVersionGuard | null> {
    const state = await this.deps.filesystem.readFileVersion(path, executionWorldId);
    if (!state) return null;
    return {
      path,
      expectedVersion: state.version,
      contentHash: state.contentHash,
    };
  }

  /**
   * Create a version guard for a new file (no existing file expected).
   */
  createNewFileGuard(path: string): FileVersionGuard {
    return {
      path,
      expectedVersion: '__new__',
    };
  }

  /**
   * Compute content hash for a given string.
   */
  static computeContentHash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}
