/**
 * DevOps Engine Types
 *
 * Shared interfaces for the DevOps Safety Layer covering argv-only execution,
 * fail-closed policy engine, capability grants, and audit chain.
 */

import type { SecurityPostureLevel } from '../agent-harness/types';

// ─────────────────────────────────────────────
// Command Execution
// ─────────────────────────────────────────────

/** A command execution request using argv-only semantics (no shell surface). */
export interface CommandRequest {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  targetContext?: string;
}

/** The result of a command execution attempt. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  denied?: { reason: string };
}

// ─────────────────────────────────────────────
// Policy Engine
// ─────────────────────────────────────────────

/** Actions a policy rule can prescribe. */
export type PolicyAction = 'allow' | 'deny' | 'escalate';

/** A single rule in the fail-closed policy engine. */
export interface PolicyRule {
  id: string;
  priority: number;
  action: PolicyAction;
  conditions: {
    toolName?: string | string[];
    agentId?: string | string[];
    targetContext?: string | string[];
    environment?: string;
    securityPosture?: SecurityPostureLevel;
  };
}

/** The result of evaluating a tool invocation against the policy engine. */
export interface PolicyEvaluation {
  decision: PolicyAction;
  matchedRule: string | null;
  correlationId: string;
  timestamp: number;
  reason: string;
}

// ─────────────────────────────────────────────
// Capability Grants
// ─────────────────────────────────────────────

/** Lifecycle status of a capability grant. */
export type GrantStatus = 'proposed' | 'approved' | 'active' | 'expired' | 'revoked' | 'exhausted';

/** A time-limited, scope-bound permission for dangerous operations. */
export interface CapabilityGrant {
  id: string;
  environment: string;
  capabilityType: string;
  targetSet: string[];
  reason: string;
  proposedBy: string;
  approvedBy: string | null;
  lifetime: number;
  maxExecutions: number;
  remainingExecutions: number;
  dryRunRequired: boolean;
  status: GrantStatus;
  createdAt: number;
  expiresAt: number;
  activatedAt: number | null;
}

// ─────────────────────────────────────────────
// Audit Chain
// ─────────────────────────────────────────────

/** A single event in the tamper-evident audit chain. */
export interface AuditEvent {
  id: string;
  sequenceNumber: number;
  timestamp: number;
  agentId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  duration: number;
  cost: number;
  previousHash: string;
  currentHash: string;
}

/** Result of verifying the structural integrity of the audit chain. */
export interface ChainIntegrityResult {
  valid: boolean;
  brokenAt?: number;
  nature?: string;
  totalEvents: number;
  verifiedEvents: number;
}
