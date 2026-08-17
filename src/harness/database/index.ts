/**
 * Shared Database Module
 *
 * Provides bounded SQLite connection and transaction primitives for
 * the harness MCP processes. Extends the existing database authority
 * with WAL, foreign keys, configured busy timeout, prepared statements,
 * bounded transactions, and retry-classified contention errors.
 *
 * Also provides expand/contract migrations for the harness Shared_Database
 * and the MigrationRunner that applies them.
 *
 * Requirements: 3.1–3.7, 28.4, 30.8, 30.12, 31.1–31.12
 */

export { SharedDatabase, type SharedDatabaseConfig } from './shared-database.js';
export { PreparedStatementCache } from './prepared-statement-cache.js';
export {
  BoundedTransaction,
  BoundedStatementProxy,
  type BoundedExec,
  type TransactionBounds,
  type TransactionResult,
  type TransactionError,
} from './bounded-transaction.js';
export {
  classifyContentionError,
  isRetriableContention,
  type ContentionClass,
  type ContentionError,
} from './contention-errors.js';
export { MigrationRunner } from './migration-runner.js';
export type {
  MigrationPhase,
  MigrationState,
  MigrationRecord,
  MigrationFile,
  MigrationRunnerOptions,
} from './migration-runner.js';
export { FencedMigrationCoordinator } from './fenced-coordinator.js';
export type {
  LeaseResult,
  LeaseError,
  LeaseOutcome,
  CompatibilityDeclaration,
  CompatibilityCheckResult,
  MutationCheckResult,
  MigrationStepRecord,
  FencedCoordinatorOptions,
} from './fenced-coordinator.js';
