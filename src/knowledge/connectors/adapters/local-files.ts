// ─── Local Files Connector Adapter ─────────────────────────────
// Implements the KBConnector interface for local file system sources.
// Integrates with PathGuard for path validation and enforces per-connector
// security profiles (allowed paths, max fetch size, max total size).
//
// Requirements: 1.4, 32.1, 32.2, 32.4

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { validatePath, type PathGuardResult } from '../../../security/path-guard';
import type {
  KBConnector,
  ConnectorConfig,
  ConnectorSecurityProfile,
  RawDocument,
  SourceEntry,
} from '../types';

// ─── MIME Type Mapping ──────────────────────────────────────────

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.xml': 'text/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.py': 'text/x-python',
  '.rb': 'text/x-ruby',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/**
 * Resolves a MIME type from a file extension.
 * Falls back to 'application/octet-stream' for unknown extensions.
 */
function mimeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';
}

// ─── Error Classes ──────────────────────────────────────────────

export class LocalFilesConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'LocalFilesConnectorError';
  }
}

// ─── Default Security Profile ───────────────────────────────────

const DEFAULT_SECURITY_PROFILE: ConnectorSecurityProfile = {
  maxFetchSizeBytes: 10 * 1024 * 1024, // 10 MB per document
  maxTotalSizeBytes: 1024 * 1024 * 1024, // 1 GB total per source
  executionTimeoutMs: 60_000,
};

// ─── Local Files Connector ──────────────────────────────────────

/**
 * KBConnector implementation for local file system sources.
 *
 * Lifecycle:
 * 1. `connect(config)` — validates the source URI with PathGuard against the project root
 * 2. `list()` — recursively enumerates files in the directory
 * 3. `fetch(entries)` — reads file contents, computes SHA-256 hash, enforces size limits
 * 4. `disconnect()` — releases resources
 */
export class LocalFilesConnector implements KBConnector {
  readonly type = 'local-files' as const;

  private projectRoot: string | null = null;
  private resolvedProjectRoot: string | null = null;
  private resolvedSourcePath: string | null = null;
  private securityProfile: ConnectorSecurityProfile = DEFAULT_SECURITY_PROFILE;
  private connected = false;

  /**
   * @param projectRoot - The project root directory for PathGuard validation.
   *   Can be overridden per-connect call if the config specifies a project root.
   */
  constructor(projectRoot?: string) {
    if (projectRoot) {
      this.projectRoot = path.resolve(projectRoot);
      // Also store the realpath for internal sub-path validation
      try {
        this.resolvedProjectRoot = fs.realpathSync(this.projectRoot);
      } catch {
        this.resolvedProjectRoot = this.projectRoot;
      }
    }
  }

  // ─── connect() ──────────────────────────────────────────────

  /**
   * Establishes connection to the local file source.
   * Validates the source URI with PathGuard against the project root.
   *
   * @throws LocalFilesConnectorError if path validation fails or path is inaccessible.
   */
  async connect(config: ConnectorConfig): Promise<void> {
    if (config.type !== 'local-files') {
      throw new LocalFilesConnectorError(
        `Invalid connector type: expected "local-files", got "${config.type}"`,
        'INVALID_TYPE',
      );
    }

    // Resolve security profile from config or use defaults
    this.securityProfile = {
      ...DEFAULT_SECURITY_PROFILE,
      ...config.securityProfile,
    };

    // Determine project root — must be set either via constructor or environment
    if (!this.projectRoot) {
      throw new LocalFilesConnectorError(
        'Project root must be provided for path validation',
        'NO_PROJECT_ROOT',
      );
    }

    const sourceUri = config.uri;

    // Validate source path with PathGuard.
    // We pass the project root as-is; PathGuard resolves both the root and
    // the input path to their canonical form when followSymlinks is true.
    const validationResult: PathGuardResult = validatePath(
      sourceUri,
      this.projectRoot,
      { followSymlinks: true },
    );

    if (!validationResult.safe) {
      throw new LocalFilesConnectorError(
        `Path validation failed: ${validationResult.reason}`,
        'PATH_VALIDATION_FAILED',
      );
    }

    // Check allowed paths from security profile
    if (this.securityProfile.allowedPaths && this.securityProfile.allowedPaths.length > 0) {
      const resolvedPath = validationResult.resolved;
      const isAllowed = this.securityProfile.allowedPaths.some((allowedPath) => {
        // Resolve relative to project root, then canonicalize via realpath
        const logicalAllowed = path.resolve(this.projectRoot!, allowedPath);
        let resolvedAllowed: string;
        try {
          resolvedAllowed = fs.realpathSync(logicalAllowed);
        } catch {
          resolvedAllowed = logicalAllowed;
        }
        return (
          resolvedPath === resolvedAllowed || resolvedPath.startsWith(resolvedAllowed + path.sep)
        );
      });

      if (!isAllowed) {
        throw new LocalFilesConnectorError(
          `Path "${sourceUri}" is not within the allowed paths for this connector`,
          'PATH_NOT_ALLOWED',
        );
      }
    }

    // Verify the path exists and is accessible
    const resolvedPath = validationResult.resolved;
    try {
      await fs.promises.access(resolvedPath, fs.constants.R_OK);
    } catch {
      throw new LocalFilesConnectorError(
        `Source path "${resolvedPath}" is not accessible or does not exist`,
        'PATH_NOT_ACCESSIBLE',
      );
    }

    this.resolvedSourcePath = resolvedPath;
    this.connected = true;
  }

  // ─── list() ─────────────────────────────────────────────────

  /**
   * Recursively enumerates files in the connected directory.
   * Returns SourceEntry[] with file names, sizes, and modification times.
   *
   * @throws LocalFilesConnectorError if not connected.
   */
  async list(): Promise<SourceEntry[]> {
    this.ensureConnected();

    const sourcePath = this.resolvedSourcePath!;
    const stat = await fs.promises.stat(sourcePath);

    // If the source is a single file, return just that entry
    if (stat.isFile()) {
      return [this.statToSourceEntry(sourcePath, stat)];
    }

    // Otherwise, recursively enumerate the directory
    const entries: SourceEntry[] = [];
    await this.enumerateDirectory(sourcePath, entries);
    return entries;
  }

  // ─── fetch() ────────────────────────────────────────────────

  /**
   * Reads file contents for the specified entries.
   * Computes SHA-256 content hash and enforces size limits.
   *
   * Enforces:
   * - maxFetchSizeBytes per individual file
   * - maxTotalSizeBytes across all files in the fetch batch
   *
   * @throws LocalFilesConnectorError if not connected.
   */
  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    this.ensureConnected();

    let totalBytesRead = 0;

    for (const entry of entries) {
      // Validate each entry path with PathGuard before reading.
      // Use resolvedProjectRoot since list() returns realpath-based URIs.
      // For externally-constructed entries, PathGuard resolves symlinks in its second pass.
      const validationResult = validatePath(entry.uri, this.resolvedProjectRoot!, {
        followSymlinks: true,
      });

      if (!validationResult.safe) {
        // Skip entries that fail path validation — do not crash the pipeline
        continue;
      }

      const filePath = validationResult.resolved;

      // Check per-file size limit before reading
      let fileStat: fs.Stats;
      try {
        fileStat = await fs.promises.stat(filePath);
      } catch {
        // Skip files that can't be stat'd (may have been deleted)
        continue;
      }

      if (!fileStat.isFile()) {
        continue;
      }

      if (fileStat.size > this.securityProfile.maxFetchSizeBytes) {
        // Skip files exceeding per-document size limit
        continue;
      }

      // Check total size limit across all files
      if (totalBytesRead + fileStat.size > this.securityProfile.maxTotalSizeBytes) {
        // Stop fetching once total size limit would be exceeded
        break;
      }

      // Read file content
      let content: Buffer;
      try {
        content = await fs.promises.readFile(filePath);
      } catch {
        // Skip files that can't be read
        continue;
      }

      // Compute SHA-256 content hash
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');

      totalBytesRead += content.length;

      const rawDocument: RawDocument = {
        content,
        mimeType: mimeFromExtension(filePath),
        sourceUri: entry.uri,
        fetchTimestamp: Date.now(),
        contentHash,
        byteSize: content.length,
      };

      yield rawDocument;
    }
  }

  // ─── disconnect() ───────────────────────────────────────────

  /**
   * Releases resources and marks the connector as disconnected.
   */
  async disconnect(): Promise<void> {
    this.resolvedSourcePath = null;
    this.connected = false;
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Ensures the connector is in a connected state.
   * @throws LocalFilesConnectorError if not connected.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.resolvedSourcePath) {
      throw new LocalFilesConnectorError(
        'Connector is not connected. Call connect() first.',
        'NOT_CONNECTED',
      );
    }
  }

  /**
   * Recursively enumerates all files in a directory, appending to entries.
   */
  private async enumerateDirectory(dirPath: string, entries: SourceEntry[]): Promise<void> {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    } catch {
      // Skip directories that can't be read
      return;
    }

    for (const dirent of dirEntries) {
      const fullPath = path.join(dirPath, dirent.name);

      // Validate each path with PathGuard to prevent symlink escapes.
      // Use resolvedProjectRoot (realpath) since dirPath comes from resolvedSourcePath (also a realpath).
      const validationResult = validatePath(fullPath, this.resolvedProjectRoot!, {
        followSymlinks: true,
      });
      if (!validationResult.safe) {
        continue;
      }

      if (dirent.isDirectory()) {
        await this.enumerateDirectory(fullPath, entries);
      } else if (dirent.isFile()) {
        try {
          const fileStat = await fs.promises.stat(fullPath);
          entries.push(this.statToSourceEntry(fullPath, fileStat));
        } catch {
          // Skip files that can't be stat'd
        }
      }
    }
  }

  /**
   * Converts a file path and stat into a SourceEntry.
   */
  private statToSourceEntry(filePath: string, stat: fs.Stats): SourceEntry {
    return {
      uri: filePath,
      name: path.basename(filePath),
      mimeType: mimeFromExtension(filePath),
      sizeBytes: stat.size,
      lastModified: stat.mtimeMs,
    };
  }
}
