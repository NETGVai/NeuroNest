/**
 * MCP Process Lifecycle Module
 *
 * Provides negotiated lifecycle, readiness, health, progress,
 * cancellation, and graceful drain for harness MCP processes.
 *
 * Requirements: 30.8–30.12, 32.1, 32.5–32.7
 */

export {
  ProcessLifecycleManager,
  type ProcessState,
  type ComponentHealth,
  type HealthStatus,
  type ReadinessReport,
  type ProcessLifecycleConfig,
  type AuthorityHealthChecker,
  type PendingOperation,
  type NegotiatedCapabilities,
  type DrainPolicy,
  type ProgressNotification,
  type ProgressListener,
  type OutboxFlusher,
} from './process-lifecycle-manager.js';
