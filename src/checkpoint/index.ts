/**
 * Checkpoint recovery module barrel (FUT-PKG-05-RECOVERY/T-003).
 *
 * The CheckpointService is the single write owner for `Checkpoint@1`
 * (NN-INV-008); backend adapters and the legacy-artifact wrapper are accessed
 * through it and never author records.
 */

export * from './checkpoint-types.js';
export * from './checkpoint-service.js';
export * from './legacy-artifact-wrapper.js';
export * from './restore-service.js';
export * from './transcript-rewind.js';
export * from './recovery-exit-gate.js';
export { defaultBackendRegistry, FileDeltaBackend, GitRefBackend, FullSnapshotBackend } from './backends/index.js';
