/**
 * Runtime Namespace JSON-RPC Schemas
 *
 * Versioned request/response schemas for `neuronest.runtime.v1.*` methods.
 * These schemas define the wire format for the runtime MCP server.
 * Protocol-specific types (JSON-RPC envelopes) are NOT exposed here—
 * only the method params and results using canonical domain types.
 *
 * Requirements: 25.1, 30.4, 30.9, 32.3
 */

import { z } from 'zod';
import { IdentifierSchema, ContractRefSchema } from '../../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../../contracts/scope';
import { ActorRefSchema } from '../../contracts/actor';

// ─── Namespace ──────────────────────────────────────────────────

export const RUNTIME_NAMESPACE = 'neuronest.runtime.v1' as const;

// ─── capabilities.list ──────────────────────────────────────────

export const RuntimeCapabilitiesListParamsSchema = z.object({
  scope: ScopeDescriptorV1Schema.optional(),
  includeInactive: z.boolean().optional(),
});

export const RuntimeCapabilitiesListResultSchema = z.object({
  capabilities: z.array(z.object({
    name: IdentifierSchema,
    version: z.string().min(1),
    owner: IdentifierSchema,
    state: z.enum(['active', 'draining', 'inactive']),
    consumerCount: z.number().int().nonnegative(),
  }).passthrough()),
});

// ─── capabilities.resolve ───────────────────────────────────────

export const RuntimeCapabilitiesResolveParamsSchema = z.object({
  capability: IdentifierSchema,
  requiredVersion: z.string().optional(),
  scope: ScopeDescriptorV1Schema.optional(),
});

export const RuntimeCapabilitiesResolveResultSchema = z.object({
  resolved: z.boolean(),
  provider: z.object({
    name: IdentifierSchema,
    version: z.string().min(1),
    contract: ContractRefSchema,
  }).optional(),
  error: z.object({
    message: z.string(),
    availableVersions: z.array(z.string()),
  }).optional(),
});

// ─── prompts.assemble ───────────────────────────────────────────

export const RuntimePromptsAssembleParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  sections: z.array(z.object({
    name: IdentifierSchema,
    version: z.string().min(1),
    variables: z.record(z.string(), z.unknown()).optional(),
  })),
  tools: z.array(IdentifierSchema).optional(),
  routeId: IdentifierSchema.optional(),
  actor: ActorRefSchema,
});

export const RuntimePromptsAssembleResultSchema = z.object({
  fingerprint: z.string().min(1),
  sectionCount: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  cacheStable: z.boolean(),
});

// ─── prompts.reconstruct ────────────────────────────────────────

export const RuntimePromptsReconstructParamsSchema = z.object({
  fingerprint: z.string().min(1),
  sessionId: IdentifierSchema,
});

export const RuntimePromptsReconstructResultSchema = z.object({
  reconstructed: z.boolean(),
  fingerprint: z.string().min(1),
  compatible: z.boolean(),
  reason: z.string().optional(),
});

// ─── turns.submit ───────────────────────────────────────────────

export const RuntimeTurnsSubmitParamsSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  content: z.string(),
  contextItems: z.array(z.record(z.string(), z.unknown())).optional(),
  routeId: IdentifierSchema.optional(),
  profileId: IdentifierSchema.optional(),
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
  idempotencyKey: z.string(),
});

export const RuntimeTurnsSubmitResultSchema = z.object({
  commandId: IdentifierSchema,
  turnId: IdentifierSchema,
  status: z.enum(['pending', 'committed', 'rejected']),
  reason: z.string().optional(),
});

// ─── turns.cancel ───────────────────────────────────────────────

export const RuntimeTurnsCancelParamsSchema = z.object({
  turnId: IdentifierSchema,
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  reason: z.string().optional(),
});

export const RuntimeTurnsCancelResultSchema = z.object({
  turnId: IdentifierSchema,
  cancellationRequested: z.boolean(),
  currentState: z.string(),
});

// ─── queue.mutate ───────────────────────────────────────────────

export const RuntimeQueueMutateParamsSchema = z.object({
  sessionId: IdentifierSchema,
  operation: z.enum(['add', 'edit', 'remove', 'reorder', 'promote']),
  entryId: IdentifierSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  content: z.string().optional(),
  position: z.number().int().nonnegative().optional(),
  actor: ActorRefSchema,
});

export const RuntimeQueueMutateResultSchema = z.object({
  commandId: IdentifierSchema,
  status: z.enum(['pending', 'committed', 'rejected', 'stale']),
  entryId: IdentifierSchema.optional(),
  revision: z.number().int().optional(),
});

// ─── tools.describe ─────────────────────────────────────────────

export const RuntimeToolsDescribeParamsSchema = z.object({
  toolName: IdentifierSchema.optional(),
  scope: ScopeDescriptorV1Schema.optional(),
});

export const RuntimeToolsDescribeResultSchema = z.object({
  tools: z.array(z.object({
    name: IdentifierSchema,
    version: z.string().min(1),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    riskClass: z.string(),
    concurrencyClass: z.string(),
    idempotent: z.boolean(),
    owner: IdentifierSchema,
  }).passthrough()),
});

// ─── tools.execute ──────────────────────────────────────────────

export const RuntimeToolsExecuteParamsSchema = z.object({
  callId: IdentifierSchema,
  toolName: IdentifierSchema,
  toolVersion: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  sessionId: IdentifierSchema,
  turnId: IdentifierSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
});

export const RuntimeToolsExecuteResultSchema = z.object({
  callId: IdentifierSchema,
  status: z.enum(['completed', 'denied', 'cancelled', 'failed', 'synthetic']),
  canonicalValueId: IdentifierSchema.optional(),
  mediaType: z.string().optional(),
  valueDigest: z.string().optional(),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
  }).optional(),
});

// ─── tools.inspect ──────────────────────────────────────────────

export const RuntimeToolsInspectParamsSchema = z.object({
  callId: IdentifierSchema,
  sessionId: IdentifierSchema,
  includeArguments: z.boolean().optional(),
  includeOutput: z.boolean().optional(),
});

export const RuntimeToolsInspectResultSchema = z.object({
  callId: IdentifierSchema,
  toolName: IdentifierSchema,
  status: z.string(),
  duration: z.number().nonnegative().optional(),
  attempts: z.number().int().nonnegative(),
  riskClass: z.string().optional(),
  owner: IdentifierSchema.optional(),
  redactedArguments: z.record(z.string(), z.unknown()).optional(),
  redactedOutput: z.unknown().optional(),
});

// ─── providers.resolve ──────────────────────────────────────────

export const RuntimeProvidersResolveParamsSchema = z.object({
  sessionId: IdentifierSchema,
  routePreference: IdentifierSchema.optional(),
  requiredCapabilities: z.array(z.string()).optional(),
});

export const RuntimeProvidersResolveResultSchema = z.object({
  routeId: IdentifierSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  adapterVersion: z.string().min(1),
  contextCapacity: z.number().int().positive(),
  pinned: z.boolean(),
});

// ─── collaboration.decide ───────────────────────────────────────

export const RuntimeCollaborationDecideParamsSchema = z.object({
  questionId: IdentifierSchema,
  sessionId: IdentifierSchema,
  answer: z.unknown(),
  approvalDigest: z.string().optional(),
  actor: ActorRefSchema,
});

export const RuntimeCollaborationDecideResultSchema = z.object({
  questionId: IdentifierSchema,
  accepted: z.boolean(),
  reason: z.string().optional(),
  consumed: z.boolean(),
});

// ─── profiles.preview ───────────────────────────────────────────

export const RuntimeProfilesPreviewParamsSchema = z.object({
  profileId: IdentifierSchema,
  sessionId: IdentifierSchema,
});

export const RuntimeProfilesPreviewResultSchema = z.object({
  profileId: IdentifierSchema,
  effectiveDiff: z.record(z.string(), z.unknown()),
  compatible: z.boolean(),
  warnings: z.array(z.string()),
});

// ─── profiles.activate ──────────────────────────────────────────

export const RuntimeProfilesActivateParamsSchema = z.object({
  profileId: IdentifierSchema,
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
});

export const RuntimeProfilesActivateResultSchema = z.object({
  profileId: IdentifierSchema,
  activated: z.boolean(),
  appliedLayers: z.number().int().nonnegative(),
  reason: z.string().optional(),
});

// ─── execution.run ──────────────────────────────────────────────

export const RuntimeExecutionRunParamsSchema = z.object({
  worldId: IdentifierSchema,
  code: z.string(),
  language: z.string().min(1),
  bindings: z.array(IdentifierSchema).optional(),
  timeout: z.number().int().positive().optional(),
  scope: ScopeDescriptorV1Schema,
});

export const RuntimeExecutionRunResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  duration: z.number().nonnegative(),
  bounded: z.boolean(),
  returnValue: z.unknown().optional(),
});

// ─── turns.resume ───────────────────────────────────────────────

export const RuntimeTurnsResumeParamsSchema = z.object({
  turnId: IdentifierSchema,
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  fromCheckpoint: z.string().optional(),
  actor: ActorRefSchema,
  scope: ScopeDescriptorV1Schema,
});

export const RuntimeTurnsResumeResultSchema = z.object({
  turnId: IdentifierSchema,
  resumed: z.boolean(),
  currentState: z.string(),
  reason: z.string().optional(),
});

// ─── providers.stream ───────────────────────────────────────────

export const RuntimeProvidersStreamParamsSchema = z.object({
  sessionId: IdentifierSchema,
  turnId: IdentifierSchema,
  routeId: IdentifierSchema,
  fingerprint: z.string().min(1),
  abortSignal: z.boolean().optional(),
});

export const RuntimeProvidersStreamResultSchema = z.object({
  streamId: IdentifierSchema,
  status: z.enum(['streaming', 'completed', 'cancelled', 'failed']),
  blocksReceived: z.number().int().nonnegative(),
  completionAnchorId: IdentifierSchema.optional(),
  error: z.object({
    message: z.string(),
    code: z.string().optional(),
    retryable: z.boolean().optional(),
  }).optional(),
});

// ─── subagents.launch ───────────────────────────────────────────

export const RuntimeSubagentsLaunchParamsSchema = z.object({
  parentTurnId: IdentifierSchema,
  sessionId: IdentifierSchema,
  agentId: IdentifierSchema,
  task: z.string().min(1),
  profileId: IdentifierSchema.optional(),
  scope: ScopeDescriptorV1Schema,
  actor: ActorRefSchema,
  idempotencyKey: z.string(),
});

export const RuntimeSubagentsLaunchResultSchema = z.object({
  subagentId: IdentifierSchema,
  status: z.enum(['launched', 'rejected', 'duplicate']),
  reason: z.string().optional(),
});

// ─── subagents.cancel ───────────────────────────────────────────

export const RuntimeSubagentsCancelParamsSchema = z.object({
  subagentId: IdentifierSchema,
  sessionId: IdentifierSchema,
  actor: ActorRefSchema,
  reason: z.string().optional(),
});

export const RuntimeSubagentsCancelResultSchema = z.object({
  subagentId: IdentifierSchema,
  cancellationRequested: z.boolean(),
  currentState: z.string(),
});

// ─── subagents.status ───────────────────────────────────────────

export const RuntimeSubagentsStatusParamsSchema = z.object({
  subagentId: IdentifierSchema,
  sessionId: IdentifierSchema,
});

export const RuntimeSubagentsStatusResultSchema = z.object({
  subagentId: IdentifierSchema,
  agentId: IdentifierSchema,
  state: z.enum(['running', 'completed', 'cancelled', 'failed']),
  turnsCompleted: z.number().int().nonnegative(),
  parentTurnId: IdentifierSchema,
  resultInjected: z.boolean(),
});

// ─── workflows.start ────────────────────────────────────────────

export const RuntimeWorkflowsStartParamsSchema = z.object({
  workflowName: IdentifierSchema,
  version: z.string().min(1),
  sessionId: IdentifierSchema,
  input: z.record(z.string(), z.unknown()),
  scope: ScopeDescriptorV1Schema,
  actor: ActorRefSchema,
  idempotencyKey: z.string(),
});

export const RuntimeWorkflowsStartResultSchema = z.object({
  workflowId: IdentifierSchema,
  status: z.enum(['started', 'rejected', 'duplicate']),
  reason: z.string().optional(),
});

// ─── workflows.step ─────────────────────────────────────────────

export const RuntimeWorkflowsStepParamsSchema = z.object({
  workflowId: IdentifierSchema,
  stepId: IdentifierSchema.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  actor: ActorRefSchema,
});

export const RuntimeWorkflowsStepResultSchema = z.object({
  workflowId: IdentifierSchema,
  stepId: IdentifierSchema,
  status: z.enum(['completed', 'waiting', 'failed']),
  output: z.record(z.string(), z.unknown()).optional(),
});

// ─── workflows.cancel ───────────────────────────────────────────

export const RuntimeWorkflowsCancelParamsSchema = z.object({
  workflowId: IdentifierSchema,
  actor: ActorRefSchema,
  reason: z.string().optional(),
});

export const RuntimeWorkflowsCancelResultSchema = z.object({
  workflowId: IdentifierSchema,
  cancellationRequested: z.boolean(),
  currentState: z.string(),
});

// ─── workflows.status ───────────────────────────────────────────

export const RuntimeWorkflowsStatusParamsSchema = z.object({
  workflowId: IdentifierSchema,
});

export const RuntimeWorkflowsStatusResultSchema = z.object({
  workflowId: IdentifierSchema,
  workflowName: IdentifierSchema,
  state: z.enum(['running', 'completed', 'cancelled', 'failed', 'waiting']),
  stepsCompleted: z.number().int().nonnegative(),
  stepsTotal: z.number().int().nonnegative().optional(),
  currentStepId: IdentifierSchema.optional(),
});

// ─── jobs.submit ────────────────────────────────────────────────

export const RuntimeJobsSubmitParamsSchema = z.object({
  jobType: IdentifierSchema,
  sessionId: IdentifierSchema,
  input: z.record(z.string(), z.unknown()),
  priority: z.enum(['normal', 'high', 'low']).optional(),
  scope: ScopeDescriptorV1Schema,
  actor: ActorRefSchema,
  idempotencyKey: z.string(),
});

export const RuntimeJobsSubmitResultSchema = z.object({
  jobId: IdentifierSchema,
  status: z.enum(['queued', 'rejected', 'duplicate']),
  reason: z.string().optional(),
});

// ─── jobs.cancel ────────────────────────────────────────────────

export const RuntimeJobsCancelParamsSchema = z.object({
  jobId: IdentifierSchema,
  actor: ActorRefSchema,
  reason: z.string().optional(),
});

export const RuntimeJobsCancelResultSchema = z.object({
  jobId: IdentifierSchema,
  cancellationRequested: z.boolean(),
  currentState: z.string(),
});

// ─── jobs.status ────────────────────────────────────────────────

export const RuntimeJobsStatusParamsSchema = z.object({
  jobId: IdentifierSchema,
});

export const RuntimeJobsStatusResultSchema = z.object({
  jobId: IdentifierSchema,
  jobType: IdentifierSchema,
  state: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']),
  progress: z.number().nonnegative().optional(),
  roundsCompleted: z.number().int().nonnegative(),
  roundsLimit: z.number().int().positive().optional(),
  output: z.record(z.string(), z.unknown()).optional(),
});

// ─── diagnostics.health ─────────────────────────────────────────

export const RuntimeDiagnosticsHealthParamsSchema = z.object({}).optional();

export const RuntimeDiagnosticsHealthResultSchema = z.object({
  processVersion: z.string().min(1),
  protocolVersion: z.string().min(1),
  uptime: z.number().nonnegative(),
  draining: z.boolean(),
  databaseConnected: z.boolean(),
  databaseCompatible: z.boolean(),
  observedSchemaVersion: z.string().optional(),
  migrationState: z.enum(['idle', 'in_progress', 'failed']).optional(),
  requiredAuthoritiesAvailable: z.boolean(),
});

// ─── Method Registry ────────────────────────────────────────────

export const RUNTIME_METHODS = {
  'neuronest.runtime.v1.capabilities.list': {
    params: RuntimeCapabilitiesListParamsSchema,
    result: RuntimeCapabilitiesListResultSchema,
  },
  'neuronest.runtime.v1.capabilities.resolve': {
    params: RuntimeCapabilitiesResolveParamsSchema,
    result: RuntimeCapabilitiesResolveResultSchema,
  },
  'neuronest.runtime.v1.prompts.assemble': {
    params: RuntimePromptsAssembleParamsSchema,
    result: RuntimePromptsAssembleResultSchema,
  },
  'neuronest.runtime.v1.prompts.reconstruct': {
    params: RuntimePromptsReconstructParamsSchema,
    result: RuntimePromptsReconstructResultSchema,
  },
  'neuronest.runtime.v1.turns.submit': {
    params: RuntimeTurnsSubmitParamsSchema,
    result: RuntimeTurnsSubmitResultSchema,
  },
  'neuronest.runtime.v1.turns.cancel': {
    params: RuntimeTurnsCancelParamsSchema,
    result: RuntimeTurnsCancelResultSchema,
  },
  'neuronest.runtime.v1.queue.mutate': {
    params: RuntimeQueueMutateParamsSchema,
    result: RuntimeQueueMutateResultSchema,
  },
  'neuronest.runtime.v1.tools.describe': {
    params: RuntimeToolsDescribeParamsSchema,
    result: RuntimeToolsDescribeResultSchema,
  },
  'neuronest.runtime.v1.tools.execute': {
    params: RuntimeToolsExecuteParamsSchema,
    result: RuntimeToolsExecuteResultSchema,
  },
  'neuronest.runtime.v1.tools.inspect': {
    params: RuntimeToolsInspectParamsSchema,
    result: RuntimeToolsInspectResultSchema,
  },
  'neuronest.runtime.v1.providers.resolve': {
    params: RuntimeProvidersResolveParamsSchema,
    result: RuntimeProvidersResolveResultSchema,
  },
  'neuronest.runtime.v1.collaboration.decide': {
    params: RuntimeCollaborationDecideParamsSchema,
    result: RuntimeCollaborationDecideResultSchema,
  },
  'neuronest.runtime.v1.profiles.preview': {
    params: RuntimeProfilesPreviewParamsSchema,
    result: RuntimeProfilesPreviewResultSchema,
  },
  'neuronest.runtime.v1.profiles.activate': {
    params: RuntimeProfilesActivateParamsSchema,
    result: RuntimeProfilesActivateResultSchema,
  },
  'neuronest.runtime.v1.execution.run': {
    params: RuntimeExecutionRunParamsSchema,
    result: RuntimeExecutionRunResultSchema,
  },
  'neuronest.runtime.v1.turns.resume': {
    params: RuntimeTurnsResumeParamsSchema,
    result: RuntimeTurnsResumeResultSchema,
  },
  'neuronest.runtime.v1.providers.stream': {
    params: RuntimeProvidersStreamParamsSchema,
    result: RuntimeProvidersStreamResultSchema,
  },
  'neuronest.runtime.v1.subagents.launch': {
    params: RuntimeSubagentsLaunchParamsSchema,
    result: RuntimeSubagentsLaunchResultSchema,
  },
  'neuronest.runtime.v1.subagents.cancel': {
    params: RuntimeSubagentsCancelParamsSchema,
    result: RuntimeSubagentsCancelResultSchema,
  },
  'neuronest.runtime.v1.subagents.status': {
    params: RuntimeSubagentsStatusParamsSchema,
    result: RuntimeSubagentsStatusResultSchema,
  },
  'neuronest.runtime.v1.workflows.start': {
    params: RuntimeWorkflowsStartParamsSchema,
    result: RuntimeWorkflowsStartResultSchema,
  },
  'neuronest.runtime.v1.workflows.step': {
    params: RuntimeWorkflowsStepParamsSchema,
    result: RuntimeWorkflowsStepResultSchema,
  },
  'neuronest.runtime.v1.workflows.cancel': {
    params: RuntimeWorkflowsCancelParamsSchema,
    result: RuntimeWorkflowsCancelResultSchema,
  },
  'neuronest.runtime.v1.workflows.status': {
    params: RuntimeWorkflowsStatusParamsSchema,
    result: RuntimeWorkflowsStatusResultSchema,
  },
  'neuronest.runtime.v1.jobs.submit': {
    params: RuntimeJobsSubmitParamsSchema,
    result: RuntimeJobsSubmitResultSchema,
  },
  'neuronest.runtime.v1.jobs.cancel': {
    params: RuntimeJobsCancelParamsSchema,
    result: RuntimeJobsCancelResultSchema,
  },
  'neuronest.runtime.v1.jobs.status': {
    params: RuntimeJobsStatusParamsSchema,
    result: RuntimeJobsStatusResultSchema,
  },
  'neuronest.runtime.v1.diagnostics.health': {
    params: RuntimeDiagnosticsHealthParamsSchema,
    result: RuntimeDiagnosticsHealthResultSchema,
  },
} as const;

export type RuntimeMethodName = keyof typeof RUNTIME_METHODS;
