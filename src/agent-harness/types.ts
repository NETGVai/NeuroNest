/**
 * Agent Harness Types
 *
 * Shared interfaces for the Multi-Agent Harness covering per-scope sandboxing,
 * background task scheduling, and configurable security postures.
 */

// ─────────────────────────────────────────────
// Scope Sandboxing
// ─────────────────────────────────────────────

/** Granularity levels for agent scope isolation. */
export type ScopeLevel = 'global' | 'workspace' | 'project' | 'agent';

/** Describes a specific scope boundary for an agent or resource. */
export interface ScopeDescriptor {
  level: ScopeLevel;
  workspaceId?: string;
  projectId?: string;
  agentId?: string;
}

/** A recorded attempt to access a resource outside the agent's assigned scope. */
export interface ScopeViolation {
  requestedScope: ScopeDescriptor;
  agentScope: ScopeDescriptor;
  resource: string;
  timestamp: number;
}

// ─────────────────────────────────────────────
// Background Task Scheduling
// ─────────────────────────────────────────────

/** A cron-based trigger for background tasks. */
export interface CronTrigger {
  type: 'cron';
  expression: string;
}

/** A file-watch-based trigger for background tasks. */
export interface WatchTrigger {
  type: 'watch';
  patterns: string[];
  debounceMs: number;
}

/** A scheduled background task managed by the background worker. */
export interface BackgroundTask {
  id: string;
  agentId: string;
  name: string;
  trigger: CronTrigger | WatchTrigger;
  lastRun: number | null;
  nextRun: number | null;
  status: 'idle' | 'running' | 'failed' | 'disabled';
  retryCount: number;
  maxRetries: number;
}

// ─────────────────────────────────────────────
// Security Posture
// ─────────────────────────────────────────────

/** Configurable enforcement levels controlling human approval requirements. */
export type SecurityPostureLevel = 'strict' | 'auto' | 'autonomous';

/** Configuration for the security posture system at workspace and project levels. */
export interface SecurityPostureConfig {
  workspaceLevel: SecurityPostureLevel;
  projectOverrides: Record<string, SecurityPostureLevel>;
  riskThreshold: number;
}
