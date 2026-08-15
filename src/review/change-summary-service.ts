/**
 * ChangeSummaryService — Generates change summaries with statistics and dependency info.
 *
 * Produces a structured summary including file list, hunk count, additions/removals,
 * and affected dependencies from the repository map. Statistics cover total files
 * changed, lines added, lines removed, and total hunks.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import { ChangeSet, FileOperation } from '../change-set/types';
import { ShadowModelService, ShadowModel } from '../change-set/shadow-model-service';

// ─── Types ──────────────────────────────────────────────────────

/** Summary statistics for a file within the Change_Set. */
export interface FileSummary {
  /** The file URI. */
  readonly fileUri: string;
  /** The kind of file operation. */
  readonly operationKind: FileOperation['kind'];
  /** Number of lines added. */
  readonly additions: number;
  /** Number of lines removed. */
  readonly removals: number;
  /** Number of hunks in this file. */
  readonly hunkCount: number;
  /** Language identifier (from shadow model or inferred). */
  readonly languageId: string;
  /** Whether this is a zero-content creation. */
  readonly isEmptyCreation: boolean;
}

/** Overall statistics for the entire Change_Set. */
export interface ChangeSetStatistics {
  /** Total files in the Change_Set. */
  readonly totalFiles: number;
  /** Total lines added across all files. */
  readonly totalAdditions: number;
  /** Total lines removed across all files. */
  readonly totalRemovals: number;
  /** Total hunks across all files. */
  readonly totalHunks: number;
  /** Breakdown of operation types. */
  readonly operationCounts: Readonly<Record<FileOperation['kind'], number>>;
}

/** An affected dependency entry identified from the Change_Set. */
export interface AffectedDependency {
  /** The dependency name or path. */
  readonly name: string;
  /** Whether it is a production or dev dependency. */
  readonly scope: 'production' | 'dev' | 'peer' | 'unknown';
  /** The kind of change to the dependency. */
  readonly changeKind: 'added' | 'removed' | 'modified';
}

/** Complete change summary for a Change_Set. */
export interface ChangeSummary {
  /** The Change_Set ID. */
  readonly changeSetId: string;
  /** Individual file summaries. */
  readonly files: readonly FileSummary[];
  /** Aggregate statistics. */
  readonly statistics: ChangeSetStatistics;
  /** Affected dependencies identified. */
  readonly affectedDependencies: readonly AffectedDependency[];
  /** Timestamp when the summary was generated. */
  readonly generatedAt: string;
}

// ─── Dependency patterns ─────────────────────────────────────────

/** File patterns that indicate dependency changes. */
const DEPENDENCY_FILE_PATTERNS = [
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'requirements.txt',
  'Pipfile',
  'Pipfile.lock',
  'pyproject.toml',
  'Gemfile',
  'Gemfile.lock',
  'build.gradle',
  'pom.xml',
];

// ─── Service ────────────────────────────────────────────────────

/**
 * ChangeSummaryService generates structured summaries for Change_Sets.
 * It computes per-file and aggregate statistics, and identifies affected dependencies.
 */
export class ChangeSummaryService {
  constructor(private readonly shadowModelService: ShadowModelService) {}

  /**
   * Generates a complete summary for a Change_Set.
   */
  generateSummary(changeSet: ChangeSet): ChangeSummary {
    const files = changeSet.operations.map((op) => this.summarizeFile(changeSet, op));
    const statistics = this.computeStatistics(files, changeSet.operations);
    const affectedDependencies = this.identifyAffectedDependencies(changeSet);

    return {
      changeSetId: changeSet.id,
      files,
      statistics,
      affectedDependencies,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Gets just the statistics for a Change_Set without full summary.
   */
  getStatistics(changeSet: ChangeSet): ChangeSetStatistics {
    const files = changeSet.operations.map((op) => this.summarizeFile(changeSet, op));
    return this.computeStatistics(files, changeSet.operations);
  }

  /**
   * Checks if a file operation affects dependency files.
   */
  isDependencyFile(fileUri: string): boolean {
    const filename = fileUri.split('/').pop() ?? '';
    return DEPENDENCY_FILE_PATTERNS.some(
      (pattern) => filename === pattern || fileUri.endsWith(`/${pattern}`)
    );
  }

  // ─── Private helpers ────────────────────────────────────────────

  private summarizeFile(changeSet: ChangeSet, op: FileOperation): FileSummary {
    const fileUri = this.getFileUri(op);
    const shadowModel = this.findShadowModel(changeSet.id, fileUri);
    const { additions, removals, hunkCount } = this.computeFileDiff(shadowModel, op);
    const languageId = shadowModel?.languageId ?? 'plaintext';

    // Detect zero-content creation
    const isEmptyCreation =
      op.kind === 'create' &&
      additions === 0 &&
      removals === 0 &&
      (!('proposedBlob' in op) || op.proposedBlob === '');

    return {
      fileUri,
      operationKind: op.kind,
      additions,
      removals,
      hunkCount,
      languageId,
      isEmptyCreation,
    };
  }

  private computeFileDiff(
    shadowModel: ShadowModel | null,
    op: FileOperation
  ): { additions: number; removals: number; hunkCount: number } {
    if (!shadowModel) {
      // No shadow model — estimate from operation
      if (op.kind === 'create' && 'proposedBlob' in op) {
        const lines = op.proposedBlob ? op.proposedBlob.split('\n').length : 0;
        return { additions: lines, removals: 0, hunkCount: lines > 0 ? 1 : 0 };
      }
      if (op.kind === 'delete') {
        return { additions: 0, removals: 0, hunkCount: 1 };
      }
      return { additions: 0, removals: 0, hunkCount: 0 };
    }

    const baseLines = shadowModel.baseContent?.split('\n') ?? [];
    const proposedLines = shadowModel.proposedContent?.split('\n') ?? [];

    // Compute line-level changes and hunk count
    let additions = 0;
    let removals = 0;
    let hunkCount = 0;
    let inHunk = false;
    const maxLen = Math.max(baseLines.length, proposedLines.length);

    for (let i = 0; i < maxLen; i++) {
      const baseLine = i < baseLines.length ? baseLines[i] : undefined;
      const proposedLine = i < proposedLines.length ? proposedLines[i] : undefined;

      if (baseLine !== proposedLine) {
        if (!inHunk) {
          hunkCount++;
          inHunk = true;
        }
        if (baseLine !== undefined && proposedLine === undefined) {
          removals++;
        } else if (baseLine === undefined && proposedLine !== undefined) {
          additions++;
        } else {
          // Line changed — count as one removal and one addition
          removals++;
          additions++;
        }
      } else {
        inHunk = false;
      }
    }

    // Handle create operation with no base
    if (shadowModel.baseContent === null && shadowModel.proposedContent) {
      additions = proposedLines.length;
      removals = 0;
      hunkCount = 1;
    }

    // Handle delete operation with no proposed
    if (shadowModel.proposedContent === null && shadowModel.baseContent) {
      additions = 0;
      removals = baseLines.length;
      hunkCount = 1;
    }

    return { additions, removals, hunkCount };
  }

  private computeStatistics(
    files: FileSummary[],
    operations: readonly FileOperation[]
  ): ChangeSetStatistics {
    const operationCounts: Record<FileOperation['kind'], number> = {
      create: 0,
      modify: 0,
      rename: 0,
      move: 0,
      delete: 0,
    };

    for (const op of operations) {
      operationCounts[op.kind]++;
    }

    return {
      totalFiles: files.length,
      totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
      totalRemovals: files.reduce((sum, f) => sum + f.removals, 0),
      totalHunks: files.reduce((sum, f) => sum + f.hunkCount, 0),
      operationCounts,
    };
  }

  private identifyAffectedDependencies(changeSet: ChangeSet): AffectedDependency[] {
    const deps: AffectedDependency[] = [];

    for (const op of changeSet.operations) {
      const fileUri = this.getFileUri(op);
      if (!this.isDependencyFile(fileUri)) continue;

      const shadowModel = this.findShadowModel(changeSet.id, fileUri);
      if (!shadowModel) {
        // Can't inspect contents — just note the file is affected
        deps.push({
          name: fileUri.split('/').pop() ?? fileUri,
          scope: 'unknown',
          changeKind: op.kind === 'create' ? 'added' : op.kind === 'delete' ? 'removed' : 'modified',
        });
        continue;
      }

      // For package.json-like files, attempt to extract dependency changes
      if (fileUri.endsWith('package.json')) {
        const extracted = this.extractPackageJsonDeps(shadowModel);
        deps.push(...extracted);
      } else {
        deps.push({
          name: fileUri.split('/').pop() ?? fileUri,
          scope: 'unknown',
          changeKind: op.kind === 'create' ? 'added' : op.kind === 'delete' ? 'removed' : 'modified',
        });
      }
    }

    return deps;
  }

  private extractPackageJsonDeps(shadowModel: ShadowModel): AffectedDependency[] {
    const deps: AffectedDependency[] = [];

    try {
      const baseDeps = shadowModel.baseContent
        ? this.parsePackageDeps(JSON.parse(shadowModel.baseContent))
        : new Map<string, string>();
      const proposedDeps = shadowModel.proposedContent
        ? this.parsePackageDeps(JSON.parse(shadowModel.proposedContent))
        : new Map<string, string>();

      // Find added deps
      for (const [name, scope] of proposedDeps) {
        if (!baseDeps.has(name)) {
          deps.push({ name, scope: scope as AffectedDependency['scope'], changeKind: 'added' });
        } else if (baseDeps.get(name) !== scope) {
          deps.push({ name, scope: scope as AffectedDependency['scope'], changeKind: 'modified' });
        }
      }

      // Find removed deps
      for (const [name, scope] of baseDeps) {
        if (!proposedDeps.has(name)) {
          deps.push({ name, scope: scope as AffectedDependency['scope'], changeKind: 'removed' });
        }
      }
    } catch {
      // If parsing fails, note the file was modified
      deps.push({ name: 'package.json', scope: 'unknown', changeKind: 'modified' });
    }

    return deps;
  }

  private parsePackageDeps(pkg: Record<string, unknown>): Map<string, string> {
    const deps = new Map<string, string>();

    const sections: Array<[string, AffectedDependency['scope']]> = [
      ['dependencies', 'production'],
      ['devDependencies', 'dev'],
      ['peerDependencies', 'peer'],
    ];

    for (const [section, scope] of sections) {
      const sectionDeps = pkg[section];
      if (sectionDeps && typeof sectionDeps === 'object') {
        for (const name of Object.keys(sectionDeps as Record<string, unknown>)) {
          deps.set(name, scope);
        }
      }
    }

    return deps;
  }

  private getFileUri(op: FileOperation): string {
    return op.kind === 'rename' || op.kind === 'move' ? op.targetUri : op.targetUri;
  }

  private findShadowModel(changeSetId: string, fileUri: string): ShadowModel | null {
    const models = this.shadowModelService.listByChangeSet(changeSetId);
    return models.find((m) => m.originalUri === fileUri) ?? null;
  }
}
