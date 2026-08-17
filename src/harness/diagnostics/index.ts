/**
 * Diagnostics — Redacted health checks, invariant verification, teardown
 * diagnostics, and compatibility checks for harness MCP processes.
 *
 * The Diagnostics_Service exposes:
 * - Process/schema/migration/queue/owner/budget/bound health
 * - Exact reconstruction verification
 * - Call/result pairing verification
 * - Sequence linkage verification
 * - Schema consistency verification
 * - Teardown completeness for terminal owners
 * - Compatibility reporting
 * - Degradation tracking with remediation
 *
 * All output is fully redacted per Requirement 45.10.
 *
 * Requirements: 29.5–29.8, 30.11–30.12, 32.7, 34.1–34.7, 45.5, 45.10
 */

export * from './schemas';
export * from './diagnostics-service';
