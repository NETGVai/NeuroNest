/**
 * Bounded Operations Schemas — Zod contracts for code runtime, file, process,
 * terminal, and language-service operations.
 *
 * All operations are bound to an Execution_World and Scope_Descriptor. Resource
 * limits come from validated Settings_Service revisions (no hard-coded constants).
 *
 * Requirements: 11.1–11.8, 23.2–23.8
 */

import { z } from 'zod';
import {
  IdentifierSchema,
  TimestampSchema,
  ContractRefSchema,
} from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Shared Enumerations ────────────────────────────────────────

export const ExecutionOutcomeSchema = z.enum([
  'success',
  'timeout',
  'memory_exceeded',
  'output_exceeded',
  'process_limit_exceeded',
  'filesystem_denied',
  'network_denied',
  'continuation_exceeded',
  'uncaught_exception',
  'terminated',
]);

export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

// ─── Resource Limits ────────────────────────────────────────────

export const ResourceLimitsSchema = z.object({
  timeoutMs: z.number().finite().positive(),
  memoryBytes: z.number().finite().positive(),
  outputBytes: z.number().finite().positive(),
  processCount: z.number().int().finite().positive(),
  filesystemAccess: z.enum(['none', 'read_only', 'scoped_write']),
  networkAccess: z.enum(['none', 'scoped']),
  continuationCount: z.number().int().finite().positive(),
});

export type ResourceLimits = z.infer<typeof ResourceLimitsSchema>;

// ─── Typed Host Binding ─────────────────────────────────────────

export const HostBindingSchema = z.object({
  name: IdentifierSchema,
  contract: ContractRefSchema,
  approved: z.boolean(),
  approvedBy: IdentifierSchema.optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

export type HostBinding = z.infer<typeof HostBindingSchema>;

// ─── Code Runtime Schemas ───────────────────────────────────────

export const CodeExecutionRequestSchema = z.object({
  requestId: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  scope: ScopeDescriptorV1Schema,
  codeIdentity: IdentifierSchema,
  code: z.string(),
  language: z.string().min(1),
  bindings: z.array(HostBindingSchema),
  limits: ResourceLimitsSchema,
  correlationId: IdentifierSchema,
});

export type CodeExecutionRequest = z.infer<typeof CodeExecutionRequestSchema>;

export const BoundedOutputSchema = z.object({
  data: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncatedAt: z.number().int().nonnegative().optional(),
});

export type BoundedOutput = z.infer<typeof BoundedOutputSchema>;

export const CodeExecutionResultSchema = z.object({
  requestId: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  codeIdentity: IdentifierSchema,
  correlationId: IdentifierSchema,
  outcome: ExecutionOutcomeSchema,
  stdout: BoundedOutputSchema,
  stderr: BoundedOutputSchema,
  returnValue: z.unknown().optional(),
  diagnostics: z.array(z.object({
    severity: z.enum(['error', 'warning', 'info']),
    message: z.string(),
    location: z.string().optional(),
  })).optional(),
  durationMs: z.number().nonnegative(),
  bindingVersions: z.record(z.string(), z.string()),
  limitsApplied: ResourceLimitsSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  schemaVersion: z.literal(1),
});

export type CodeExecutionResult = z.infer<typeof CodeExecutionResultSchema>;

export const CodeExecutionErrorSchema = z.object({
  requestId: IdentifierSchema,
  correlationId: IdentifierSchema,
  outcome: ExecutionOutcomeSchema,
  message: z.string(),
  redacted: z.boolean(),
  stdout: BoundedOutputSchema.optional(),
  stderr: BoundedOutputSchema.optional(),
  schemaVersion: z.literal(1),
});

export type CodeExecutionError = z.infer<typeof CodeExecutionErrorSchema>;

// ─── Version-Guarded File Operations ────────────────────────────

export const FileVersionGuardSchema = z.object({
  path: z.string().min(1),
  expectedVersion: z.string().min(1),
  contentHash: z.string().optional(),
});

export type FileVersionGuard = z.infer<typeof FileVersionGuardSchema>;

export const VersionGuardedWriteRequestSchema = z.object({
  requestId: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  scope: ScopeDescriptorV1Schema,
  path: z.string().min(1),
  content: z.string(),
  versionGuard: FileVersionGuardSchema,
  atomic: z.boolean().default(true),
});

export type VersionGuardedWriteRequest = z.infer<typeof VersionGuardedWriteRequestSchema>;

export const VersionGuardedWriteResultSchema = z.object({
  requestId: IdentifierSchema,
  path: z.string(),
  outcome: z.enum(['written', 'conflict', 'denied']),
  newVersion: z.string().optional(),
  conflictVersion: z.string().optional(),
  bytesWritten: z.number().int().nonnegative().optional(),
  schemaVersion: z.literal(1),
});

export type VersionGuardedWriteResult = z.infer<typeof VersionGuardedWriteResultSchema>;

// ─── Managed Process Tree ───────────────────────────────────────

export const ProcessTreeConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  owner: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  scope: ScopeDescriptorV1Schema,
  deadlineMs: z.number().finite().positive(),
  outputBoundBytes: z.number().finite().positive(),
  environmentPolicy: z.enum(['inherit_filtered', 'explicit_only', 'none']),
  teardownBehavior: z.enum(['graceful_then_kill', 'immediate_kill', 'signal_only']),
});

export type ProcessTreeConfig = z.infer<typeof ProcessTreeConfigSchema>;

export const ManagedProcessSchema = z.object({
  processId: IdentifierSchema,
  parentProcessId: IdentifierSchema.optional(),
  owner: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  command: z.string(),
  state: z.enum(['running', 'stopping', 'terminated', 'failed']),
  pid: z.number().int().nonnegative().optional(),
  startedAt: TimestampSchema,
  terminatedAt: TimestampSchema.optional(),
  exitCode: z.number().int().optional(),
  stdout: BoundedOutputSchema.optional(),
  stderr: BoundedOutputSchema.optional(),
});

export type ManagedProcess = z.infer<typeof ManagedProcessSchema>;

export const ProcessTreeStatusSchema = z.object({
  rootProcessId: IdentifierSchema,
  owner: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  processes: z.array(ManagedProcessSchema),
  totalProcesses: z.number().int().nonnegative(),
  state: z.enum(['active', 'draining', 'terminated']),
  schemaVersion: z.literal(1),
});

export type ProcessTreeStatus = z.infer<typeof ProcessTreeStatusSchema>;

// ─── Owner/World-Scoped Pseudo-Terminals ────────────────────────

export const PtyConfigSchema = z.object({
  terminalId: IdentifierSchema,
  owner: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  scope: ScopeDescriptorV1Schema,
  shell: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  retainedOutputBound: z.number().finite().positive(),
  modelVisibleOutputBound: z.number().finite().positive(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export type PtyConfig = z.infer<typeof PtyConfigSchema>;

export const PtySessionSchema = z.object({
  terminalId: IdentifierSchema,
  owner: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  state: z.enum(['active', 'suspended', 'closing', 'closed']),
  retainedOutput: BoundedOutputSchema,
  modelVisibleOutput: BoundedOutputSchema,
  createdAt: TimestampSchema,
  closedAt: TimestampSchema.optional(),
  schemaVersion: z.literal(1),
});

export type PtySession = z.infer<typeof PtySessionSchema>;

// ─── Typed Semantic Language Operations ─────────────────────────

export const SemanticOperationKindSchema = z.enum([
  'diagnostics',
  'completions',
  'hover',
  'definition',
  'references',
  'rename',
  'code_actions',
  'formatting',
  'signature_help',
  'document_symbols',
]);

export type SemanticOperationKind = z.infer<typeof SemanticOperationKindSchema>;

export const SemanticOperationRequestSchema = z.object({
  requestId: IdentifierSchema,
  executionWorldId: IdentifierSchema,
  scope: ScopeDescriptorV1Schema,
  kind: SemanticOperationKindSchema,
  workspaceId: IdentifierSchema,
  language: z.string().min(1),
  filePath: z.string().min(1),
  position: z.object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  }).optional(),
  range: z.object({
    start: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
    end: z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() }),
  }).optional(),
  newName: z.string().optional(),
});

export type SemanticOperationRequest = z.infer<typeof SemanticOperationRequestSchema>;

export const SemanticOperationResultSchema = z.object({
  requestId: IdentifierSchema,
  kind: SemanticOperationKindSchema,
  status: z.enum(['completed', 'unavailable', 'timeout', 'error']),
  results: z.array(z.unknown()),
  schemaVersion: z.literal(1),
});

export type SemanticOperationResult = z.infer<typeof SemanticOperationResultSchema>;

// ─── Execution World Teardown ───────────────────────────────────

export const TeardownRequestSchema = z.object({
  executionWorldId: IdentifierSchema,
  owner: IdentifierSchema,
  deadlineMs: z.number().finite().positive(),
  reason: z.enum(['owner_teardown', 'session_end', 'timeout', 'manual']),
});

export type TeardownRequest = z.infer<typeof TeardownRequestSchema>;

export const TeardownResultSchema = z.object({
  executionWorldId: IdentifierSchema,
  owner: IdentifierSchema,
  terminalsClose: z.number().int().nonnegative(),
  processesTerminated: z.number().int().nonnegative(),
  watchersStopped: z.number().int().nonnegative(),
  languageRequestsCancelled: z.number().int().nonnegative(),
  temporaryResourcesCleaned: z.number().int().nonnegative(),
  completedWithinDeadline: z.boolean(),
  durationMs: z.number().nonnegative(),
  schemaVersion: z.literal(1),
});

export type TeardownResult = z.infer<typeof TeardownResultSchema>;
