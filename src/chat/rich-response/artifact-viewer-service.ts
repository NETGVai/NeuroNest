/**
 * ArtifactViewerService — Typed artifact viewers with version history,
 * diffs, export, and origin links.
 *
 * Artifacts render in dedicated viewers appropriate to type and support:
 * - Version history navigation
 * - Diff between versions
 * - Download/export
 * - Link-back to originating message and Task
 *
 * Requirements: 17.5
 */

// ─── Types ──────────────────────────────────────────────────────

import type { TypedArtifact } from './types';

/**
 * A version entry in the artifact version history.
 */
export interface ArtifactVersion {
  readonly versionId: string;
  readonly artifactId: string;
  readonly version: number;
  readonly content: string;
  readonly createdAt: string;
  readonly createdBy: 'agent' | 'user';
  readonly changeDescription?: string | undefined;
  readonly messageId?: string | undefined;
  readonly taskId?: string | undefined;
}

/**
 * A diff between two artifact versions.
 */
export interface ArtifactDiff {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly additions: number;
  readonly removals: number;
  readonly hunks: readonly ArtifactDiffHunk[];
}

/**
 * A single hunk in an artifact diff.
 */
export interface ArtifactDiffHunk {
  readonly startLine: number;
  readonly endLine: number;
  readonly type: 'addition' | 'removal' | 'unchanged';
  readonly content: string;
}

/**
 * Origin link for an artifact, pointing back to its source.
 */
export interface ArtifactOriginLink {
  readonly messageId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly runId?: string | undefined;
  readonly changeSetId?: string | undefined;
  readonly chatTurnIndex?: number | undefined;
}

/**
 * Export format for artifact download.
 */
export type ExportFormat = 'raw' | 'markdown' | 'json' | 'patch';

/**
 * Export result.
 */
export interface ExportResult {
  readonly content: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly format: ExportFormat;
}

/**
 * Viewer state for a currently displayed artifact.
 */
export interface ArtifactViewerState {
  readonly artifactId: string;
  readonly currentVersion: number;
  readonly totalVersions: number;
  readonly showingDiff: boolean;
  readonly diffFromVersion?: number | undefined;
  readonly expanded: boolean;
}

// ─── Service ────────────────────────────────────────────────────

function generateVersionId(): string {
  return `ver-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ArtifactViewerService {
  /** Versions by artifact ID */
  private readonly versions: Map<string, ArtifactVersion[]> = new Map();
  /** Origin links by artifact ID */
  private readonly origins: Map<string, ArtifactOriginLink> = new Map();
  /** Viewer state by artifact ID */
  private readonly viewerStates: Map<string, ArtifactViewerState> = new Map();

  /**
   * Register an artifact for viewing. Creates the first version entry.
   */
  registerArtifact(artifact: TypedArtifact, originLink: ArtifactOriginLink): ArtifactVersion {
    const taskId = artifact.metadata.taskId ?? originLink.taskId;
    const version: ArtifactVersion = {
      versionId: generateVersionId(),
      artifactId: artifact.id,
      version: 1,
      content: artifact.content,
      createdAt: artifact.createdAt,
      createdBy: 'agent',
      changeDescription: 'Initial version',
      ...(originLink.messageId !== undefined ? { messageId: originLink.messageId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    };

    this.versions.set(artifact.id, [version]);
    this.origins.set(artifact.id, originLink);
    this.viewerStates.set(artifact.id, {
      artifactId: artifact.id,
      currentVersion: 1,
      totalVersions: 1,
      showingDiff: false,
      expanded: false,
    });

    return version;
  }

  /**
   * Add a new version to an artifact.
   */
  addVersion(
    artifactId: string,
    content: string,
    createdBy: 'agent' | 'user',
    changeDescription?: string
  ): ArtifactVersion | null {
    const existing = this.versions.get(artifactId);
    if (!existing || existing.length === 0) {
      return null;
    }

    const newVersionNumber = existing.length + 1;
    const version: ArtifactVersion = {
      versionId: generateVersionId(),
      artifactId,
      version: newVersionNumber,
      content,
      createdAt: new Date().toISOString(),
      createdBy,
      ...(changeDescription !== undefined ? { changeDescription } : {}),
    };

    existing.push(version);

    // Update viewer state
    const state = this.viewerStates.get(artifactId);
    if (state) {
      this.viewerStates.set(artifactId, {
        ...state,
        currentVersion: newVersionNumber,
        totalVersions: newVersionNumber,
      });
    }

    return version;
  }

  /**
   * Get all versions of an artifact.
   */
  getVersions(artifactId: string): readonly ArtifactVersion[] {
    return this.versions.get(artifactId) ?? [];
  }

  /**
   * Get a specific version of an artifact.
   */
  getVersion(artifactId: string, versionNumber: number): ArtifactVersion | undefined {
    const versions = this.versions.get(artifactId);
    if (!versions) return undefined;
    return versions.find(v => v.version === versionNumber);
  }

  /**
   * Get the latest version of an artifact.
   */
  getLatestVersion(artifactId: string): ArtifactVersion | undefined {
    const versions = this.versions.get(artifactId);
    if (!versions || versions.length === 0) return undefined;
    return versions[versions.length - 1];
  }

  /**
   * Compute a diff between two versions of the same artifact.
   */
  diff(artifactId: string, fromVersion: number, toVersion: number): ArtifactDiff | null {
    const from = this.getVersion(artifactId, fromVersion);
    const to = this.getVersion(artifactId, toVersion);
    if (!from || !to) return null;

    const fromLines = from.content.split('\n');
    const toLines = to.content.split('\n');

    const hunks: ArtifactDiffHunk[] = [];
    let additions = 0;
    let removals = 0;

    // Simple line-by-line diff (sufficient for viewer purposes)
    const maxLines = Math.max(fromLines.length, toLines.length);
    let currentHunkStart = -1;
    let currentHunkType: 'addition' | 'removal' | 'unchanged' = 'unchanged';
    let currentHunkContent: string[] = [];

    for (let i = 0; i < maxLines; i++) {
      const fromLine = i < fromLines.length ? fromLines[i] : undefined;
      const toLine = i < toLines.length ? toLines[i] : undefined;

      let lineType: 'addition' | 'removal' | 'unchanged';
      let lineContent: string;

      if (fromLine === toLine) {
        lineType = 'unchanged';
        lineContent = fromLine ?? '';
      } else if (fromLine === undefined) {
        lineType = 'addition';
        lineContent = toLine!;
        additions++;
      } else if (toLine === undefined) {
        lineType = 'removal';
        lineContent = fromLine;
        removals++;
      } else {
        // Line changed — treat as removal + addition
        hunks.push({
          startLine: i + 1,
          endLine: i + 1,
          type: 'removal',
          content: fromLine,
        });
        removals++;
        lineType = 'addition';
        lineContent = toLine;
        additions++;
      }

      if (lineType !== currentHunkType || currentHunkStart === -1) {
        if (currentHunkStart !== -1 && currentHunkType !== 'unchanged') {
          hunks.push({
            startLine: currentHunkStart,
            endLine: currentHunkStart + currentHunkContent.length - 1,
            type: currentHunkType,
            content: currentHunkContent.join('\n'),
          });
        }
        currentHunkStart = i + 1;
        currentHunkType = lineType;
        currentHunkContent = [lineContent];
      } else {
        currentHunkContent.push(lineContent);
      }
    }

    // Flush final hunk
    if (currentHunkStart !== -1 && currentHunkType !== 'unchanged') {
      hunks.push({
        startLine: currentHunkStart,
        endLine: currentHunkStart + currentHunkContent.length - 1,
        type: currentHunkType,
        content: currentHunkContent.join('\n'),
      });
    }

    return { fromVersion, toVersion, additions, removals, hunks };
  }

  /**
   * Export an artifact version in the specified format.
   */
  export(artifactId: string, versionNumber: number, format: ExportFormat): ExportResult | null {
    const version = this.getVersion(artifactId, versionNumber);
    if (!version) return null;

    const origin = this.origins.get(artifactId);

    switch (format) {
      case 'raw':
        return {
          content: version.content,
          filename: `artifact-${artifactId}-v${versionNumber}.txt`,
          mimeType: 'text/plain',
          format,
        };

      case 'markdown': {
        const header = [
          `# Artifact: ${artifactId}`,
          `Version: ${versionNumber}`,
          `Created: ${version.createdAt}`,
          `Created by: ${version.createdBy}`,
          origin?.taskId ? `Task: ${origin.taskId}` : '',
          origin?.runId ? `Run: ${origin.runId}` : '',
          version.changeDescription ? `Description: ${version.changeDescription}` : '',
          '',
          '---',
          '',
        ].filter(Boolean).join('\n');
        return {
          content: header + version.content,
          filename: `artifact-${artifactId}-v${versionNumber}.md`,
          mimeType: 'text/markdown',
          format,
        };
      }

      case 'json':
        return {
          content: JSON.stringify({ version, origin }, null, 2),
          filename: `artifact-${artifactId}-v${versionNumber}.json`,
          mimeType: 'application/json',
          format,
        };

      case 'patch': {
        if (versionNumber <= 1) {
          // No previous version to diff against
          return {
            content: version.content,
            filename: `artifact-${artifactId}-v${versionNumber}.patch`,
            mimeType: 'text/x-patch',
            format,
          };
        }
        const diffResult = this.diff(artifactId, versionNumber - 1, versionNumber);
        const patchContent = diffResult
          ? diffResult.hunks.map(h => `${h.type === 'addition' ? '+' : h.type === 'removal' ? '-' : ' '} ${h.content}`).join('\n')
          : version.content;
        return {
          content: patchContent,
          filename: `artifact-${artifactId}-v${versionNumber}.patch`,
          mimeType: 'text/x-patch',
          format,
        };
      }

      default:
        return null;
    }
  }

  /**
   * Get the origin link for an artifact.
   */
  getOriginLink(artifactId: string): ArtifactOriginLink | undefined {
    return this.origins.get(artifactId);
  }

  /**
   * Get the current viewer state for an artifact.
   */
  getViewerState(artifactId: string): ArtifactViewerState | undefined {
    return this.viewerStates.get(artifactId);
  }

  /**
   * Navigate to a specific version in the viewer.
   */
  navigateToVersion(artifactId: string, versionNumber: number): boolean {
    const versions = this.versions.get(artifactId);
    if (!versions || versionNumber < 1 || versionNumber > versions.length) {
      return false;
    }

    const state = this.viewerStates.get(artifactId);
    if (state) {
      this.viewerStates.set(artifactId, {
        ...state,
        currentVersion: versionNumber,
        showingDiff: false,
      });
    }
    return true;
  }

  /**
   * Toggle diff mode between current version and the previous one.
   */
  toggleDiff(artifactId: string, fromVersion?: number): boolean {
    const state = this.viewerStates.get(artifactId);
    if (!state) return false;

    if (state.showingDiff) {
      this.viewerStates.set(artifactId, {
        artifactId: state.artifactId,
        currentVersion: state.currentVersion,
        totalVersions: state.totalVersions,
        showingDiff: false,
        expanded: state.expanded,
      });
    } else {
      const from = fromVersion ?? Math.max(1, state.currentVersion - 1);
      this.viewerStates.set(artifactId, {
        ...state,
        showingDiff: true,
        diffFromVersion: from,
      });
    }
    return true;
  }

  /**
   * Toggle expanded state.
   */
  toggleExpanded(artifactId: string): boolean {
    const state = this.viewerStates.get(artifactId);
    if (!state) return false;
    this.viewerStates.set(artifactId, { ...state, expanded: !state.expanded });
    return true;
  }

  /**
   * Clear all viewer data.
   */
  clear(): void {
    this.versions.clear();
    this.origins.clear();
    this.viewerStates.clear();
  }
}
