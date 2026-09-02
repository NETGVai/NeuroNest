/**
 * File-delta checkpoint backend (FUT-PKG-05-RECOVERY/T-003).
 *
 * Captures the pre-state of exactly the touched targets (a per-file snapshot of
 * every target's bytes) into one content-addressed immutable artifact behind
 * the CheckpointService. This is the default backend for an AI write batch: the
 * batch's files are grouped into one checkpoint and new files are marked absent
 * (NN-CHECKPOINT-002/003). It authors no record — the service is the sole
 * writer (NN-INV-008).
 *
 * Design anchors: D-04, D-07, D-12/D-14. Requirements: NN-CHECKPOINT-002/003,
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

const BACKEND_TYPE = 'file-delta' as const;
const BACKEND_VERSION = 1;

/** The file-delta adapter: a per-file snapshot of the touched targets. */
export class FileDeltaBackend implements CheckpointBackend {
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
