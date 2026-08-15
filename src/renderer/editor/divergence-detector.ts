/**
 * DivergenceDetector — Monitors for external filesystem divergence.
 *
 * Detects content, version-only, timestamp, permission, and other metadata
 * divergence. Offers resolution options: Compare, Reload, Keep Editor Version,
 * or Merge. Suppresses resolution only when NO divergence exists.
 *
 * Requirements: 1.8
 */

import { canonicalizeUri } from './uri-canonicalization';

/** Types of divergence detected between editor and disk. */
export type DivergenceType =
  | 'content'
  | 'version-only'
  | 'timestamp'
  | 'permission'
  | 'metadata';

/** A detected divergence record. */
export interface DivergenceRecord {
  canonicalUri: string;
  types: DivergenceType[];
  /** Disk content hash (if content divergence) */
  diskContentHash?: string;
  /** Editor content hash (if content divergence) */
  editorContentHash?: string;
  /** Disk modification time */
  diskMtime?: number;
  /** Editor's last known disk mtime */
  editorKnownMtime?: number;
  /** Disk permissions string */
  diskPermissions?: string;
  /** Editor's last known permissions */
  editorKnownPermissions?: string;
  /** Disk version */
  diskVersion?: number;
  /** Editor version */
  editorVersion?: number;
  /** Detection timestamp */
  detectedAt: number;
}

/** Resolution actions available when divergence is detected. */
export type ResolutionAction = 'Compare' | 'Reload' | 'KeepEditorVersion' | 'Merge';

/** Resolution request presented to the user. */
export interface DivergenceResolution {
  canonicalUri: string;
  divergence: DivergenceRecord;
  availableActions: ResolutionAction[];
}

/** Result of applying a resolution action. */
export interface ResolutionResult {
  action: ResolutionAction;
  canonicalUri: string;
  success: boolean;
  error?: string;
}

/** Filesystem metadata for comparison. */
export interface FileMetadata {
  contentHash: string;
  mtime: number;
  permissions: string;
  version?: number;
}

/** Source of file metadata from the filesystem. */
export interface FileMetadataSource {
  getMetadata(canonicalUri: string): FileMetadata | undefined;
}

/** Source of editor state for comparison. */
export interface EditorStateSource {
  getContentHash(canonicalUri: string): string | undefined;
  getKnownMtime(canonicalUri: string): number | undefined;
  getKnownPermissions(canonicalUri: string): string | undefined;
  getVersion(canonicalUri: string): number | undefined;
}

export type DivergenceListener = (resolution: DivergenceResolution) => void;

/**
 * DivergenceDetector monitors for external filesystem divergence and offers
 * resolution options.
 *
 * Per Requirement 1.8:
 * - Detects content, version-only, timestamp, permission, and metadata divergence
 * - Offers Compare, Reload, Keep Editor Version, or Merge
 * - Suppresses resolution only when NO divergence exists
 * - Offers resolution even for version-only divergence with unchanged content
 */
export class DivergenceDetector {
  private readonly fileMetadataSource: FileMetadataSource;
  private readonly editorStateSource: EditorStateSource;
  private readonly listeners: Set<DivergenceListener> = new Set();
  private readonly activeDivergences: Map<string, DivergenceRecord> = new Map();

  constructor(
    fileMetadataSource: FileMetadataSource,
    editorStateSource: EditorStateSource,
  ) {
    this.fileMetadataSource = fileMetadataSource;
    this.editorStateSource = editorStateSource;
  }

  /**
   * Subscribe to divergence detection notifications.
   */
  onDivergenceDetected(listener: DivergenceListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Check a file for divergence. Returns a DivergenceResolution if divergence
   * is detected, or null if no divergence exists.
   *
   * Per Requirement 1.8: suppresses resolution ONLY when no content,
   * version, or metadata divergence exists.
   */
  checkForDivergence(uri: string): DivergenceResolution | null {
    const canonicalUri = canonicalizeUri(uri);
    const diskMetadata = this.fileMetadataSource.getMetadata(canonicalUri);

    if (!diskMetadata) {
      // File no longer exists on disk — this is a missing-file scenario, not divergence
      return null;
    }

    const types: DivergenceType[] = [];
    const record: DivergenceRecord = {
      canonicalUri,
      types,
      detectedAt: Date.now(),
    };

    // Check content divergence
    const editorContentHash = this.editorStateSource.getContentHash(canonicalUri);
    if (editorContentHash !== undefined && editorContentHash !== diskMetadata.contentHash) {
      types.push('content');
      record.diskContentHash = diskMetadata.contentHash;
      record.editorContentHash = editorContentHash;
    }

    // Check version divergence (version incremented without content change)
    const editorVersion = this.editorStateSource.getVersion(canonicalUri);
    if (diskMetadata.version !== undefined && editorVersion !== undefined) {
      if (diskMetadata.version !== editorVersion) {
        // Version differs; if content is the same, this is version-only divergence
        if (!types.includes('content')) {
          types.push('version-only');
        }
        record.diskVersion = diskMetadata.version;
        record.editorVersion = editorVersion;
      }
    }

    // Check timestamp divergence
    const editorKnownMtime = this.editorStateSource.getKnownMtime(canonicalUri);
    if (editorKnownMtime !== undefined && diskMetadata.mtime !== editorKnownMtime) {
      types.push('timestamp');
      record.diskMtime = diskMetadata.mtime;
      record.editorKnownMtime = editorKnownMtime;
    }

    // Check permission divergence
    const editorKnownPermissions = this.editorStateSource.getKnownPermissions(canonicalUri);
    if (editorKnownPermissions !== undefined && diskMetadata.permissions !== editorKnownPermissions) {
      types.push('permission');
      record.diskPermissions = diskMetadata.permissions;
      record.editorKnownPermissions = editorKnownPermissions;
    }

    // Suppress resolution only when NO divergence exists
    if (types.length === 0) {
      this.activeDivergences.delete(canonicalUri);
      return null;
    }

    // Record the active divergence
    this.activeDivergences.set(canonicalUri, record);

    // All four resolution actions are always available per Requirement 1.8
    const resolution: DivergenceResolution = {
      canonicalUri,
      divergence: record,
      availableActions: ['Compare', 'Reload', 'KeepEditorVersion', 'Merge'],
    };

    // Notify listeners
    for (const listener of this.listeners) {
      listener(resolution);
    }

    return resolution;
  }

  /**
   * Resolve a divergence with the chosen action.
   */
  resolve(canonicalUri: string, action: ResolutionAction): ResolutionResult {
    const uri = canonicalizeUri(canonicalUri);
    const divergence = this.activeDivergences.get(uri);

    if (!divergence) {
      return { action, canonicalUri: uri, success: false, error: 'no-active-divergence' };
    }

    // Clear the active divergence after resolution
    this.activeDivergences.delete(uri);

    return { action, canonicalUri: uri, success: true };
  }

  /**
   * Get the active divergence for a URI, if any.
   */
  getActiveDivergence(uri: string): DivergenceRecord | undefined {
    const canonicalUri = canonicalizeUri(uri);
    return this.activeDivergences.get(canonicalUri);
  }

  /**
   * Get all currently active divergences.
   */
  getAllActiveDivergences(): Map<string, DivergenceRecord> {
    return new Map(this.activeDivergences);
  }

  /**
   * Clear a divergence record (e.g., after the file is saved or refreshed).
   */
  clearDivergence(uri: string): void {
    const canonicalUri = canonicalizeUri(uri);
    this.activeDivergences.delete(canonicalUri);
  }
}
