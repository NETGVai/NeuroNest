/**
 * Extension Schemas — Zod schemas for ExtensionDescriptor, ExtensionApproval, and AuditEvent.
 *
 * These schemas define the canonical shapes for controlled introspection and
 * staged extension lifecycle management.
 *
 * Requirements: 27.1–27.8
 */

import { z } from 'zod';

// ─── Extension Descriptor ───────────────────────────────────────

/**
 * Describes a staged extension's identity, contracts, and resource requirements.
 */
export const ExtensionDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  /** Unique stable identity for the extension */
  extensionId: z.string().min(1),
  /** Human-readable name */
  name: z.string().min(1),
  /** Semver-compatible version */
  version: z.string().min(1),
  /** Extension author or owner identity */
  owner: z.string().min(1),
  /** Declared capabilities this extension requires */
  declaredCapabilities: z.array(z.string()),
  /** Declared permissions this extension requests */
  declaredPermissions: z.array(z.string()),
  /** Content digest for exact-content approval */
  contentDigest: z.string().min(1),
  /** Resource limits for isolated testing */
  resourceLimits: z.object({
    timeoutMs: z.number().positive().finite(),
    memoryLimitBytes: z.number().positive().finite(),
    outputLimitBytes: z.number().positive().finite(),
    processLimit: z.number().positive().finite().int(),
    networkAccess: z.boolean(),
    filesystemAccess: z.boolean(),
  }),
  /** Metadata for removal/rollback */
  removalMetadata: z.object({
    reversible: z.boolean(),
    cleanupSteps: z.array(z.string()),
  }),
  /** Import declarations — validated for host-escape patterns */
  imports: z.array(z.string()),
  /** Optional test definitions for isolated bounded testing */
  tests: z.array(z.object({
    testId: z.string().min(1),
    description: z.string(),
    timeoutMs: z.number().positive().finite(),
  })).optional(),
  /** When the descriptor was created */
  createdAt: z.string().datetime(),
});

export type ExtensionDescriptor = z.infer<typeof ExtensionDescriptorSchema>;

// ─── Extension Approval ─────────────────────────────────────────

/**
 * Binds approval to exact staged content digest and requested capabilities.
 */
export const ExtensionApprovalSchema = z.object({
  schemaVersion: z.literal(1),
  /** The extension being approved */
  extensionId: z.string().min(1),
  /** Must match the staged extension's content digest exactly */
  approvedContentDigest: z.string().min(1),
  /** Approved capabilities — must match declared capabilities */
  approvedCapabilities: z.array(z.string()),
  /** Actor who approved */
  approvedBy: z.string().min(1),
  /** When approval was granted */
  approvedAt: z.string().datetime(),
  /** Optional expiry for time-bounded approvals */
  expiresAt: z.string().datetime().optional(),
});

export type ExtensionApproval = z.infer<typeof ExtensionApprovalSchema>;

// ─── Audit Event ────────────────────────────────────────────────

/**
 * Lifecycle event types for extension audit trail.
 */
export const AuditEventTypeSchema = z.enum([
  'extension_staged',
  'extension_validated',
  'extension_test_passed',
  'extension_test_failed',
  'extension_approval_requested',
  'extension_approved',
  'extension_activated',
  'extension_deactivated',
  'extension_removed',
  'extension_rejected',
  'host_escape_rejected',
]);

export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

/**
 * Auditable lifecycle event emitted for all extension state transitions.
 */
export const AuditEventSchema = z.object({
  schemaVersion: z.literal(1),
  /** Unique event identity */
  eventId: z.string().min(1),
  /** The event type */
  type: AuditEventTypeSchema,
  /** Extension identity */
  extensionId: z.string().min(1),
  /** Actor performing the action */
  actor: z.string().min(1),
  /** Timestamp of the event */
  timestamp: z.string().datetime(),
  /** Additional context (redacted — no secrets) */
  details: z.record(z.string(), z.unknown()).optional(),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ─── Extension State ────────────────────────────────────────────

/**
 * Possible states for a staged extension.
 */
export const ExtensionStateSchema = z.enum([
  'disabled',
  'staged',
  'validating',
  'testing',
  'awaiting_approval',
  'approved',
  'active',
  'removed',
  'rejected',
]);

export type ExtensionState = z.infer<typeof ExtensionStateSchema>;

// ─── Introspection Types ────────────────────────────────────────

/**
 * Secret-free capability info exposed through introspection.
 */
export const CapabilityInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  owner: z.string(),
  state: z.enum(['active', 'inactive', 'draining']),
  consumerCount: z.number().int().nonnegative(),
});

export type CapabilityInfo = z.infer<typeof CapabilityInfoSchema>;

/**
 * Secret-free profile info exposed through introspection.
 */
export const ProfileInfoSchema = z.object({
  profileId: z.string(),
  name: z.string(),
  active: z.boolean(),
  source: z.string(),
});

export type ProfileInfo = z.infer<typeof ProfileInfoSchema>;

/**
 * Secret-free policy class info exposed through introspection.
 */
export const PolicyInfoSchema = z.object({
  policyClass: z.string(),
  state: z.enum(['enforcing', 'permissive', 'disabled']),
  lastUpdated: z.string().datetime().optional(),
});

export type PolicyInfo = z.infer<typeof PolicyInfoSchema>;

/**
 * Health status info exposed through introspection.
 */
export const HealthInfoSchema = z.object({
  component: z.string(),
  status: z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']),
  lastChecked: z.string().datetime().optional(),
});

export type HealthInfo = z.infer<typeof HealthInfoSchema>;

/**
 * Aggregate introspection result — secret-free.
 */
export const IntrospectionResultSchema = z.object({
  capabilities: z.array(CapabilityInfoSchema),
  profiles: z.array(ProfileInfoSchema),
  policies: z.array(PolicyInfoSchema),
  health: z.array(HealthInfoSchema),
  timestamp: z.string().datetime(),
});

export type IntrospectionResult = z.infer<typeof IntrospectionResultSchema>;
