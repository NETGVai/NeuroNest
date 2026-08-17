/**
 * Diagnostics Schemas — Zod schemas for health, invariant verification,
 * teardown diagnostics, and compatibility checks.
 *
 * All output is redacted: secrets, private paths, protected prompt content,
 * unauthorized attachment/spill locators, and unredacted arguments are never
 * exposed through these schemas.
 *
 * Requirements: 29.5–29.8, 30.11–30.12, 32.7, 34.1–34.7, 45.5, 45.10
 */

import { z } from 'zod';

// ─── Component Health ───────────────────────────────────────────

export const ComponentHealthSchema = z.enum(['healthy', 'degraded', 'unavailable']);
export type ComponentHealth = z.infer<typeof ComponentHealthSchema>;

// ─── Health Check Schemas ───────────────────────────────────────

/**
 * Individual health dimension result.
 * Requirement 29.5: expose runtime health, readiness, schema compatibility,
 * migration state, queue depth, active owners, budget state, and structured
 * recent failures.
 */
export const HealthDimensionResultSchema = z.object({
  dimension: z.enum([
    'process',
    'schema',
    'migration',
    'queue',
    'owner',
    'budget',
    'bound',
    'database',
  ]),
  status: ComponentHealthSchema,
  message: z.string(),
  redacted: z.boolean().default(true),
  /** Affected server or session identifiers */
  affectedIds: z.array(z.string()).default([]),
  /** Structured remediation hint */
  remediation: z.string().optional(),
  checkedAt: z.string().datetime(),
});

export type HealthDimensionResult = z.infer<typeof HealthDimensionResultSchema>;

/**
 * Full health report aggregating all dimensions.
 * Requirement 30.11: report process version, protocol version, uptime,
 * draining state, and database connectivity/compatibility.
 */
export const HealthReportSchema = z.object({
  processVersion: z.string(),
  protocolVersion: z.string(),
  uptime: z.number().nonnegative(),
  draining: z.boolean(),
  databaseConnected: z.boolean(),
  databaseCompatible: z.boolean(),
  dimensions: z.array(HealthDimensionResultSchema),
  overall: ComponentHealthSchema,
  generatedAt: z.string().datetime(),
  schemaVersion: z.literal(1),
});

export type HealthReport = z.infer<typeof HealthReportSchema>;

// ─── Invariant Check Schemas ────────────────────────────────────

/**
 * The type of invariant being checked.
 * Requirement 29.6: verify exact request reconstruction, call/result pairing,
 * sequence monotonicity, and MCP schema consistency.
 */
export const InvariantKindSchema = z.enum([
  'reconstruction',
  'call_result_pairing',
  'sequence_linkage',
  'schema_consistency',
  'ownership_teardown',
]);

export type InvariantKind = z.infer<typeof InvariantKindSchema>;

/**
 * Result of a single invariant check.
 * Requirement 29.8: structured failure with affected identities and redacted evidence.
 */
export const InvariantCheckResultSchema = z.object({
  kind: InvariantKindSchema,
  passed: z.boolean(),
  /** Affected identities (session IDs, anchor IDs, owner IDs, etc.) */
  affectedIdentities: z.array(z.string()).default([]),
  /** Redacted evidence — never contains secrets, paths, or prompt content */
  redactedEvidence: z.string().optional(),
  /** Error code for programmatic handling */
  code: z.string().optional(),
  /** Remediation guidance */
  remediation: z.string().optional(),
  checkedAt: z.string().datetime(),
});

export type InvariantCheckResult = z.infer<typeof InvariantCheckResultSchema>;

/**
 * Full invariant verification report.
 * Requirement 34.7: mark affected server or session degraded with remediation.
 */
export const InvariantReportSchema = z.object({
  sessionId: z.string().optional(),
  serverId: z.string().optional(),
  results: z.array(InvariantCheckResultSchema),
  allPassed: z.boolean(),
  degraded: z.boolean(),
  degradedTargets: z.array(
    z.object({
      targetKind: z.enum(['server', 'session']),
      targetId: z.string(),
      reason: z.string(),
      remediation: z.string().optional(),
    }),
  ),
  generatedAt: z.string().datetime(),
  schemaVersion: z.literal(1),
});

export type InvariantReport = z.infer<typeof InvariantReportSchema>;

// ─── Teardown Diagnostics ───────────────────────────────────────

/**
 * Resource kind that must be fully terminated before an owner is clean.
 * Requirement 29.7: verify terminal owners have no dangling job, process tree,
 * pseudo-terminal, worker, timer, stream, or approval lease.
 */
export const OwnedResourceKindSchema = z.enum([
  'job',
  'process_tree',
  'pseudo_terminal',
  'worker',
  'timer',
  'stream',
  'approval_lease',
  'tool_call',
]);

export type OwnedResourceKind = z.infer<typeof OwnedResourceKindSchema>;

/**
 * A dangling resource found during teardown diagnostics.
 */
export const DanglingResourceSchema = z.object({
  kind: OwnedResourceKindSchema,
  resourceId: z.string(),
  ownerId: z.string(),
  /** Redacted description — no secrets or paths */
  description: z.string(),
  createdAt: z.string().datetime().optional(),
});

export type DanglingResource = z.infer<typeof DanglingResourceSchema>;

/**
 * Full teardown verification result for an owner.
 * Requirement 34.5: verify zero nonterminal owned resources.
 */
export const TeardownReportSchema = z.object({
  ownerId: z.string(),
  ownerTerminal: z.boolean(),
  clean: z.boolean(),
  danglingResources: z.array(DanglingResourceSchema),
  remediation: z.string().optional(),
  checkedAt: z.string().datetime(),
});

export type TeardownReport = z.infer<typeof TeardownReportSchema>;

// ─── Compatibility Diagnostics ──────────────────────────────────

/**
 * Schema compatibility check result.
 * Requirement 45.5: display process version, compatible schema range,
 * observed schema version, and Diagnostics_Service-supplied remediation.
 */
export const CompatibilityCheckSchema = z.object({
  processVersion: z.string(),
  observedSchemaVersion: z.number().int().nonnegative(),
  compatibleReadRange: z.tuple([z.number().int(), z.number().int()]),
  compatibleWriteRange: z.tuple([z.number().int(), z.number().int()]),
  compatible: z.boolean(),
  remediation: z.string().optional(),
  checkedAt: z.string().datetime(),
});

export type CompatibilityCheck = z.infer<typeof CompatibilityCheckSchema>;

// ─── Degradation Status ─────────────────────────────────────────

/**
 * Degradation record emitted when an invariant or health check fails.
 * Requirement 34.7: mark affected server/session degraded with remediation.
 */
export const DegradationRecordSchema = z.object({
  targetKind: z.enum(['server', 'session']),
  targetId: z.string(),
  reason: z.string(),
  invariantKind: InvariantKindSchema.optional(),
  severity: z.enum(['warning', 'critical']),
  remediation: z.string().optional(),
  occurredAt: z.string().datetime(),
});

export type DegradationRecord = z.infer<typeof DegradationRecordSchema>;

// ─── Redaction Policy ───────────────────────────────────────────

/**
 * Fields that must be redacted from diagnostic output.
 * Requirement 45.10: redact secrets, private paths, protected prompt content,
 * and unauthorized attachment or spill locators.
 */
export const REDACTED_FIELD_PATTERNS = [
  /secret/i,
  /password/i,
  /token/i,
  /key(?!Id)/i,
  /credential/i,
  /\/[a-z].*\//i, // absolute paths
  /locator/i,
  /content(?!Revision|Hash)/i,
] as const;

/**
 * Placeholder used when a value is redacted.
 */
export const REDACTION_PLACEHOLDER = '[REDACTED]' as const;
