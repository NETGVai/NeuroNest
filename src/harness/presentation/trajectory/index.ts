/**
 * Trajectory Module — Compact trajectory summaries and verified detail views.
 *
 * Exports:
 * - Schemas: All Zod schemas and types for trajectory domain
 * - TrajectoryProjector: Projects records into deduplicated keyed summaries
 * - TrajectoryDetailPortImpl: Facade coordinating projection, detail, logs, and cancellation
 *
 * Requirements: 42.1–42.14
 */

export * from './trajectory-schemas';
export {
  TrajectoryProjector,
  type RawTrajectoryRecord,
  type TrajectoryProjectorConfig,
} from './trajectory-projector';
export {
  TrajectoryDetailPortImpl,
  type TrajectoryDataSource,
  type TrajectoryAuthorityPort,
  type CancellationResult,
  type TrajectoryDetailPortConfig,
} from './trajectory-detail-port';
