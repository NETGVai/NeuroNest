/**
 * Transactional Outbox Module
 *
 * Provides transactional outbox pattern for cross-process coordination
 * through versioned SQLite records and consumer checkpoints.
 *
 * Requirements: 15.7–15.8, 30.7, 31.2–31.5, 31.11–31.12, 35.14
 */

export {
  OutboxService,
  type OutboxRecord,
  type ConsumedOutboxRecord,
  type PublishResult,
  type CommitCheckpointResult,
} from './outbox-service.js';
