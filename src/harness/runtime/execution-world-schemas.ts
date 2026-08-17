/**
 * Execution World Schemas — Sandbox_Policy, Execution_World, and enforcement contracts.
 *
 * Defines the canonical types for Security_Authority-owned execution world policy:
 * - Sandbox_Policy: confinement, scope, filesystem, process, network, resource rules
 * - Execution_World: stable identity with shared policy across all surfaces
 * - Platform confinement: OS-native sandbox activation and verification
 * - Violation events: redacted security violation records
 * - Fail-closed/explicit-approval configuration
 *
 * Requirements: 9.1–9.9, 23.1, 23.5–23.8
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Execution Surface ──────────────────────────────────────────

/**
 * The closed set of execution surfaces that share one policy per Execution_World.
 * Requirement 9.6: Enforce same policy across all surfaces.
 */
export const ExecutionSurfaceSchema = z.enum([
  'filesystem',
  'process',
  'terminal',
  'language_service',
  'code_runtime',
  'web_retrieval',
]);

export type ExecutionSurface = z.infer<typeof ExecutionSurfaceSchema>;

/** All defined execution surfaces for iteration and enforcement. */
export const ALL_EXECUTION_SURFACES: readonly ExecutionSurface[] = [
  'filesystem',
  'process',
  'terminal',
  'language_service',
  'code_runtime',
  'web_retrieval',
] as const;

// ─── Platform Confinement ───────────────────────────────────────

/**
 * Supported platform confinement mechanisms (Requirements 9.2–9.5).
 */
export const PlatformConfinementKindSchema = z.enum([
  'macos_sandbox_profile',
  'linux_namespace',
  'linux_access_control',
  'windows_restricted_token',
  'windows_job_containment',
  'none',
]);

export type PlatformConfinementKind = z.infer<typeof PlatformConfinementKindSchema>;

/**
 * Platform confinement configuration per OS (Requirements 9.3–9.5).
 */
export const PlatformConfinementConfigSchema = z.object({
  /** The confinement mechanism to apply. */
  kind: PlatformConfinementKindSchema,
  /** Activation verified flag — set after OS confirms confinement active. */
  verified: z.boolean().default(false),
  /** Platform-specific profile or config identifier. */
  profileId: z.string().optional(),
  /** Additional platform-specific parameters (non-secret). */
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export type PlatformConfinementConfig = z.infer<typeof PlatformConfinementConfigSchema>;

// ─── Filesystem Policy ──────────────────────────────────────────

/**
 * Filesystem access rules within the sandbox (Requirement 9.1, 23.2–23.3).
 */
export const FilesystemPolicySchema = z.object({
  /** Allowed read paths (glob patterns). */
  allowedReadPaths: z.array(z.string()).default([]),
  /** Allowed write paths (glob patterns). */
  allowedWritePaths: z.array(z.string()).default([]),
  /** Explicitly denied paths (take precedence over allowed). */
  deniedPaths: z.array(z.string()).default([]),
  /** Whether symlink following is permitted. */
  allowSymlinks: z.boolean().default(false),
  /** Maximum single file size in bytes. */
  maxFileSizeBytes: z.number().int().positive().finite().optional(),
});

export type FilesystemPolicy = z.infer<typeof FilesystemPolicySchema>;

// ─── Process Policy ─────────────────────────────────────────────

/**
 * Process/subprocess policy within the sandbox (Requirement 23.4).
 */
export const ProcessPolicySchema = z.object({
  /** Allowed executable names or paths. */
  allowedExecutables: z.array(z.string()).default([]),
  /** Maximum managed process tree depth. */
  maxProcessTreeDepth: z.number().int().positive().finite().default(4),
  /** Maximum concurrent processes per world. */
  maxConcurrentProcesses: z.number().int().positive().finite().default(8),
  /** Environment variable policy: allowed variable names (whitelist). */
  allowedEnvVars: z.array(z.string()).optional(),
  /** Maximum process output in bytes before truncation. */
  maxOutputBytes: z.number().int().positive().finite().default(1_048_576),
  /** Deadline for process teardown in milliseconds. */
  teardownDeadlineMs: z.number().int().positive().finite().default(30_000),
});

export type ProcessPolicy = z.infer<typeof ProcessPolicySchema>;

// ─── Network Policy ─────────────────────────────────────────────

/**
 * Network access policy (Requirement 9.1, 24.1–24.8).
 */
export const NetworkPolicySchema = z.object({
  /** Allowed outbound schemes. */
  allowedSchemes: z.array(z.string()).default(['https']),
  /** Allowed hostnames or patterns. */
  allowedHosts: z.array(z.string()).default([]),
  /** Explicitly denied hosts. */
  deniedHosts: z.array(z.string()).default([]),
  /** Deny private/loopback/link-local addresses. */
  denyPrivateAddresses: z.boolean().default(true),
  /** Maximum redirects to follow. */
  maxRedirects: z.number().int().nonnegative().finite().default(5),
  /** Maximum response size in bytes. */
  maxResponseBytes: z.number().int().positive().finite().optional(),
});

export type NetworkPolicy = z.infer<typeof NetworkPolicySchema>;

// ─── Resource Limits ────────────────────────────────────────────

/**
 * Resource limit policy for code runtime (Requirements 11.3, 23.5).
 */
export const ResourceLimitsPolicySchema = z.object({
  /** Maximum execution time in milliseconds. */
  maxExecutionTimeMs: z.number().int().positive().finite().default(30_000),
  /** Maximum memory in bytes. */
  maxMemoryBytes: z.number().int().positive().finite().optional(),
  /** Maximum output bytes per channel. */
  maxOutputBytesPerChannel: z.number().int().positive().finite().default(524_288),
  /** Maximum number of continuation rounds. */
  maxContinuations: z.number().int().positive().finite().default(10),
  /** Maximum filesystem bytes writable during execution. */
  maxFsWriteBytes: z.number().int().positive().finite().optional(),
});

export type ResourceLimitsPolicy = z.infer<typeof ResourceLimitsPolicySchema>;

// ─── Unavailability Policy ──────────────────────────────────────

/**
 * Policy when confinement is unavailable (Requirement 9.8).
 *
 * - fail_closed: Deny all mutating/code-execution operations.
 * - explicit_approval: Require user/collaboration approval before proceeding.
 */
export const UnavailabilityPolicySchema = z.enum([
  'fail_closed',
  'explicit_approval',
]);

export type UnavailabilityPolicy = z.infer<typeof UnavailabilityPolicySchema>;

// ─── Sandbox Policy ─────────────────────────────────────────────

/**
 * Complete resolved Sandbox_Policy for an Execution_World (Requirement 9.1).
 *
 * One Sandbox_Policy is resolved per Execution_World from workspace, project,
 * session, and operation inputs by Security_Authority.
 */
export const SandboxPolicyV1Schema = z.object({
  /** Schema version for this policy record. */
  schemaVersion: z.literal(1),
  /** Unique policy identity. */
  policyId: IdentifierSchema,
  /** Scope context this policy was resolved from. */
  resolvedFromScope: ScopeDescriptorV1Schema,
  /** Platform confinement configuration. */
  platformConfinement: PlatformConfinementConfigSchema,
  /** Filesystem access policy. */
  filesystem: FilesystemPolicySchema,
  /** Process execution policy. */
  process: ProcessPolicySchema,
  /** Network access policy. */
  network: NetworkPolicySchema,
  /** Code runtime resource limits. */
  resourceLimits: ResourceLimitsPolicySchema,
  /** Behavior when platform confinement is unavailable. */
  unavailabilityPolicy: UnavailabilityPolicySchema.default('fail_closed'),
  /** Whether existing firewall checks are preserved at trust boundaries (Req 9.9). */
  preserveFirewallChecks: z.boolean().default(true),
  /** Timestamp when the policy was resolved. */
  resolvedAt: TimestampSchema,
});

export type SandboxPolicyV1 = z.infer<typeof SandboxPolicyV1Schema>;

// ─── Execution World ────────────────────────────────────────────

/**
 * A stable Execution_World identity and its active policy.
 * Requirement 23.1: One stable world identity for related operations.
 */
export const ExecutionWorldV1Schema = z.object({
  /** Schema version. */
  schemaVersion: z.literal(1),
  /** Stable world identity shared across all surfaces. */
  worldId: IdentifierSchema,
  /** The owning session or agent. */
  ownerId: IdentifierSchema,
  /** The scope descriptor for this world. */
  scope: ScopeDescriptorV1Schema,
  /** The resolved sandbox policy for this world. */
  policy: SandboxPolicyV1Schema,
  /** Active state of the world. */
  active: z.boolean().default(true),
  /** Creation timestamp. */
  createdAt: TimestampSchema,
});

export type ExecutionWorldV1 = z.infer<typeof ExecutionWorldV1Schema>;

// ─── Violation Event ────────────────────────────────────────────

/**
 * A redacted violation event when an operation exceeds Sandbox_Policy.
 * Requirement 9.7: Deny operation and append redacted violation event.
 */
export const ViolationEventV1Schema = z.object({
  /** Schema version. */
  schemaVersion: z.literal(1),
  /** The world where the violation occurred. */
  worldId: IdentifierSchema,
  /** Which execution surface was involved. */
  surface: ExecutionSurfaceSchema,
  /** The type of violation. */
  violationType: z.enum([
    'path_denied',
    'executable_denied',
    'network_denied',
    'resource_exceeded',
    'cross_world_access',
    'confinement_unavailable',
    'scope_mismatch',
  ]),
  /** Redacted description (no secrets, private paths, or specific values). */
  redactedDescription: z.string(),
  /** The policy rule that was violated (identifier only). */
  violatedRule: z.string(),
  /** Timestamp of the violation. */
  timestamp: TimestampSchema,
  /** Optional correlation ID for tracing. */
  correlationId: IdentifierSchema.optional(),
});

export type ViolationEventV1 = z.infer<typeof ViolationEventV1Schema>;

// ─── Operation Request ──────────────────────────────────────────

/**
 * An operation request that must be checked against Sandbox_Policy.
 */
export const OperationRequestSchema = z.object({
  /** The execution surface for this operation. */
  surface: ExecutionSurfaceSchema,
  /** The world ID where the operation should execute. */
  worldId: IdentifierSchema,
  /** The scope of the requester. */
  requesterScope: ScopeDescriptorV1Schema,
  /** The kind of operation (surface-specific). */
  operationKind: z.enum([
    'read',
    'write',
    'execute',
    'create',
    'delete',
    'connect',
    'query',
  ]),
  /** Target path, host, executable, or resource identifier. */
  target: z.string(),
  /** Whether this is a mutating operation (triggers confinement check). */
  mutating: z.boolean().default(false),
  /** Optional correlation ID. */
  correlationId: IdentifierSchema.optional(),
});

export type OperationRequest = z.infer<typeof OperationRequestSchema>;

// ─── Policy Decision ────────────────────────────────────────────

/**
 * The enforcement decision for an operation.
 */
export const WorldPolicyDecisionSchema = z.enum([
  'allow',
  'deny',
  'require_approval',
]);

export type WorldPolicyDecision = z.infer<typeof WorldPolicyDecisionSchema>;

/**
 * Result of enforcing Sandbox_Policy on an operation.
 */
export const EnforcementResultSchema = z.object({
  /** The decision made. */
  decision: WorldPolicyDecisionSchema,
  /** The world that was evaluated. */
  worldId: IdentifierSchema,
  /** The surface evaluated. */
  surface: ExecutionSurfaceSchema,
  /** If denied, the violation event to append. */
  violation: ViolationEventV1Schema.optional(),
  /** If approval required, a description of what needs approval. */
  approvalContext: z.string().optional(),
});

export type EnforcementResult = z.infer<typeof EnforcementResultSchema>;

// ─── Transfer Contract ──────────────────────────────────────────

/**
 * An authorized transfer contract for cross-world access (Requirement 23.8).
 */
export const TransferContractV1Schema = z.object({
  /** Schema version. */
  schemaVersion: z.literal(1),
  /** Source world. */
  sourceWorldId: IdentifierSchema,
  /** Destination world. */
  destinationWorldId: IdentifierSchema,
  /** Surfaces permitted for transfer. */
  permittedSurfaces: z.array(ExecutionSurfaceSchema),
  /** Operation kinds permitted. */
  permittedOperations: z.array(z.enum([
    'read',
    'write',
    'execute',
    'create',
    'delete',
    'connect',
    'query',
  ])),
  /** Authorizer identity. */
  authorizedBy: IdentifierSchema,
  /** Expiry timestamp. */
  expiresAt: TimestampSchema.optional(),
});

export type TransferContractV1 = z.infer<typeof TransferContractV1Schema>;
