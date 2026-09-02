/**
 * Full-workspace-snapshot checkpoint backend (FUT-PKG-05-RECOVERY/T-003).
 *
 * Captures the full scoped workspace root (every file the service enumerates
 * under the resolved root) into one content-addressed immutable artifact behind
 * the CheckpointService. Used when a whole-worktree pre-state is required rather
 * than a per-file delta (NN-CHECKPOINT-002). It authors no record — the service
 * is the sole writer (NN-INV-008).
 *
 * Mechanically identical to the file-delta store (same content-addressed blobs,
 * same hashed prior-existence manifest, same atomic promote + verify + staged
 * restore); the distinction is that the service enumerates the entire root as
 * targets for this backend rather than only the touched files.
 *
 * Design anchors: D-04, D-07, D-12/D-14. Requirements: NN-CHECKPOINT-002,
 * NN-DATA-005/010.
 */

import {
  buildManifest,
  computeArtifactDigest,
  stageRestoreArtifact,
  verifyArtifact,
  writeArtifact,
} from './artifact-store.js';
import type {
  BackendArtifact,
  BackendCaptureRequest,
  CheckpointBackend,
  CheckpointManifestEntry,
} from '../checkpoint-types.js';

const BACKEND_TYPE = 'full-snapshot' as const;
const BACKEND_VERSION = 1;

/** The full-workspace-snapshot adapter. */
export class FullSnapshotBackend implements CheckpointBackend {
  readonly backendType = BACKEND_TYPE;
  readonly backendVersion = BACKEND_VERSION;

  capture(request: BackendCaptureRequest): BackendArtifact {
    const manifest = buildManifest(request.targets);
    const artifactDigest = computeArtifactDigest({
      backendType: BACKEND_TYPE,
      backendVersion: BACKEND_VERSION,
      manifest,
    });
    const { artifactRef, artifactPath } = writeArtifact({
      artifactRoot: request.artifactRoot,
      backendType: BACKEND_TYPE,
      backendVersion: BACKEND_VERSION,
      rootPath: request.rootPath,
      targets: request.targets,
      manifest,
      artifactDigest,
    });
    return {
      backendType: BACKEND_TYPE,
      backendVersion: BACKEND_VERSION,
      artifactRef,
      artifactPath,
      manifest,
      artifactDigest,
    };
  }

  verify(input: {
    readonly artifactPath: string;
    readonly manifest: readonly CheckpointManifestEntry[];
    readonly artifactDigest: string;
  }): boolean {
    return verifyArtifact(input);
  }

  stageRestore(input: {
    readonly artifactPath: string;
    readonly manifest: readonly CheckpointManifestEntry[];
    readonly stagingRoot: string;
  }): { readonly staged: ReadonlyMap<string, string>; readonly deletions: readonly string[] } {
    return stageRestoreArtifact(input);
  }
}
