/**
 * Data Retention and Cleanup module — public API.
 *
 * Exports the DataRetentionManager for use by IPC handlers and subsystem initialization.
 */

export {
  DataRetentionManager,
  type DataRetentionConfig,
  type StorageUsageSummary,
  type JobDeletionResult,
  type SourceRemovalResult,
} from './data-retention.js';
