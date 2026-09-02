/**
 * Private Git-ref checkpoint backend (FUT-PKG-05-RECOVERY/T-003).
 *
 * Captures the pre-state anchored to an optional Git `baseRef` into one
 * content-addressed immutable artifact behind the CheckpointService. Crucially,
 * uncommitted user state is captured as a named ref/artifact BEFORE any ref or
 * worktree replacement, so a restore never needs an unrecoverable hard reset
 * (NN-CHECKPOINT-007): the captured bytes live in the immutable artifact and
 * the `baseRef` is recorded so a restore can re-anchor without destroying work.
 *
 * The adapter does NOT shell out to `git` — it records the base ref as metadata
 * and snapshots the working-tree bytes into the same content-addressed store as
 * the other backends. This keeps the checkpoint authority self-contained and
 * deterministic (no external process, no competing authority,
 * NN-CHECKPOINT-002) while preserving the base-ref anchor the record needs for
 * base-ref compatibility preflight (NN-CHECKPOINT-005).
 *
 * Design anchors: D-04, D-07, D-12/D-14, CD-003. Requirements:
 * NN-CHECKPOINT-002/005/007, NN-DATA-005/010.
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

const BACKEND_TYPE = 'git-ref' as const;
const BACKEND_VERSION = 1;

/** The private Git-ref adapter: base-ref-anchored working-tree snapshot. */
export class GitRefBackend implements CheckpointBackend {
  readonly backendType = BACKEND_TYPE;
  readonly backendVersion = BACKEND_VERSION;

  capture(request: BackendCaptureRequest): BackendArtifact {
    const manifest = buildManifest(request.targets);
    // The base ref is folded into the artifact identity (as a digest anchor, not
    // a manifest entry) so a checkpoint anchored to a different base is a
    // distinct, distinguishable artifact (NN-CHECKPOINT-005/007).
    const anchor = request.baseRef !== undefined ? { baseRef: request.baseRef } : undefined;
    const artifactDigest = computeArtifactDigest({
      backendType: BACKEND_TYPE,
      backendVersion: BACKEND_VERSION,
      manifest,
      ...(anchor ? { anchor } : {}),
    });
    const { artifactRef, artifactPath } = writeArtifact({
      artifactRoot: request.artifactRoot,
      backendType: BACKEND_TYPE,
      backendVersion: BACKEND_VERSION,
      rootPath: request.rootPath,
      targets: request.targets,
      manifest,
      artifactDigest,
      ...(anchor ? { anchor } : {}),
    });
    return {
      backendType: BACKEND_TYPE,
      backendVersion: BACKEND_VERSION,
      artifactRef,
      artifactPath,
      manifest,
      artifactDigest,
      ...(request.baseRef !== undefined ? { baseRef: request.baseRef } : {}),
    };
  }

  verify(input: {
    readonly artifactPath: string;
    readonly manifest: readonly CheckpointManifestEntry[];
    readonly artifactDigest: string;
  }): boolean {
    // The stored manifest.json already binds the base ref into artifactDigest;
    // verifyArtifact recomputes from the stored manifest, so passing the record
    // manifest here (without the synthetic base-ref entry) still validates the
    // stored blobs. Base-ref anchoring is verified via artifactDigest equality.
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
