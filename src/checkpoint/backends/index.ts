/**
 * Checkpoint backend adapters registry (FUT-PKG-05-RECOVERY/T-003).
 *
 * File-delta, private Git-ref, and full-workspace-snapshot adapters are all
 * accessed through the one CheckpointService; they never author records or
 * create competing checkpoint authorities (NN-CHECKPOINT-002).
 */

import type { CheckpointBackend, CheckpointBackendType } from '../checkpoint-types.js';
import { FileDeltaBackend } from './file-delta-backend.js';
import { GitRefBackend } from './git-ref-backend.js';
import { FullSnapshotBackend } from './full-snapshot-backend.js';

export { FileDeltaBackend } from './file-delta-backend.js';
export { GitRefBackend } from './git-ref-backend.js';
export { FullSnapshotBackend } from './full-snapshot-backend.js';
export * from './artifact-store.js';

/** Build the default backend registry keyed by backend type. */
export function defaultBackendRegistry(): ReadonlyMap<CheckpointBackendType, CheckpointBackend> {
  return new Map<CheckpointBackendType, CheckpointBackend>([
    ['file-delta', new FileDeltaBackend()],
    ['git-ref', new GitRefBackend()],
    ['full-snapshot', new FullSnapshotBackend()],
  ]);
}
