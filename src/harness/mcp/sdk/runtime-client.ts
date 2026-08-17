/**
 * RuntimeMcpClient — Typed Client SDK for neuronest.runtime.v1.*
 *
 * Provides typed methods for all runtime MCP surfaces. Each method maps
 * to a JSON-RPC call over stdio. The client uses canonical domain types
 * and does NOT expose protocol-specific types (JSON-RPC envelopes,
 * transport details).
 *
 * Requirements: 25.1, 30.9–30.10, 32.1, 32.3
 */

import { z } from 'zod';
import { StdioTransport } from './stdio-transport';
import {
  RUNTIME_NAMESPACE,
  RuntimeCapabilitiesListResultSchema,
  RuntimeCapabilitiesResolveResultSchema,
  RuntimePromptsAssembleResultSchema,
  RuntimePromptsReconstructResultSchema,
  RuntimeTurnsSubmitResultSchema,
  RuntimeTurnsCancelResultSchema,
  RuntimeTurnsResumeResultSchema,
  RuntimeQueueMutateResultSchema,
  RuntimeToolsDescribeResultSchema,
  RuntimeToolsExecuteResultSchema,
  RuntimeToolsInspectResultSchema,
  RuntimeProvidersResolveResultSchema,
  RuntimeProvidersStreamResultSchema,
  RuntimeCollaborationDecideResultSchema,
  RuntimeSubagentsLaunchResultSchema,
  RuntimeSubagentsCancelResultSchema,
  RuntimeSubagentsStatusResultSchema,
  RuntimeWorkflowsStartResultSchema,
  RuntimeWorkflowsStepResultSchema,
  RuntimeWorkflowsCancelResultSchema,
  RuntimeWorkflowsStatusResultSchema,
  RuntimeJobsSubmitResultSchema,
  RuntimeJobsCancelResultSchema,
  RuntimeJobsStatusResultSchema,
  RuntimeProfilesPreviewResultSchema,
  RuntimeProfilesActivateResultSchema,
  RuntimeExecutionRunResultSchema,
  RuntimeDiagnosticsHealthResultSchema,
} from './runtime-schemas';
import type { ScopeDescriptorV1 } from '../../contracts/scope';
import type { ActorRef } from '../../contracts/actor';
import type { ContractRef } from '../../contracts/primitives';

// ─── Public Domain Types (no protocol leakage) ──────────────────

export interface CapabilitiesListParams {
  scope?: ScopeDescriptorV1;
  includeInactive?: boolean;
}

export interface CapabilityEntry {
  name: string;
  version: string;
  owner: string;
  state: 'active' | 'draining' | 'inactive';
  consumerCount: number;
}

export interface CapabilitiesListResult {
  capabilities: CapabilityEntry[];
}

export interface CapabilityResolveParams {
  capability: string;
  requiredVersion?: string | undefined;
  scope?: ScopeDescriptorV1 | undefined;
}

export interface CapabilityResolveResult {
  resolved: boolean;
  provider?: {
    name: string;
    version: string;
    contract: ContractRef;
  } | undefined;
  error?: {
    message: string;
    availableVersions: string[];
  } | undefined;
}

export interface PromptsAssembleParams {
  sessionId: string;
  branchId: string;
  sections: Array<{
    name: string;
    version: string;
    variables?: Record<string, unknown>;
  }>;
  tools?: string[];
  routeId?: string;
  actor: ActorRef;
}

export interface PromptsAssembleResult {
  fingerprint: string;
  sectionCount: number;
  toolCount: number;
  estimatedTokens: number;
  cacheStable: boolean;
}

export interface PromptsReconstructParams {
  fingerprint: string;
  sessionId: string;
}

export interface PromptsReconstructResult {
  reconstructed: boolean;
  fingerprint: string;
  compatible: boolean;
  reason?: string | undefined;
}

export interface TurnsSubmitParams {
  sessionId: string;
  branchId: string;
  content: string;
  contextItems?: Record<string, unknown>[];
  routeId?: string;
  profileId?: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
  idempotencyKey: string;
}

export interface TurnsSubmitResult {
  commandId: string;
  turnId: string;
  status: 'pending' | 'committed' | 'rejected';
  reason?: string | undefined;
}

export interface TurnsCancelParams {
  turnId: string;
  sessionId: string;
  actor: ActorRef;
  reason?: string;
}

export interface TurnsCancelResult {
  turnId: string;
  cancellationRequested: boolean;
  currentState: string;
}

export interface TurnsResumeParams {
  turnId: string;
  sessionId: string;
  branchId: string;
  fromCheckpoint?: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

export interface TurnsResumeResult {
  turnId: string;
  resumed: boolean;
  currentState: string;
  reason?: string | undefined;
}

export interface QueueMutateParams {
  sessionId: string;
  operation: 'add' | 'edit' | 'remove' | 'reorder' | 'promote';
  entryId?: string;
  expectedRevision?: number;
  content?: string;
  position?: number;
  actor: ActorRef;
}

export interface QueueMutateResult {
  commandId: string;
  status: 'pending' | 'committed' | 'rejected' | 'stale';
  entryId?: string | undefined;
  revision?: number | undefined;
}

export interface ToolsDescribeParams {
  toolName?: string;
  scope?: ScopeDescriptorV1;
}

export interface ToolDescriptor {
  name: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  riskClass: string;
  concurrencyClass: string;
  idempotent: boolean;
  owner: string;
}

export interface ToolsDescribeResult {
  tools: ToolDescriptor[];
}

export interface ToolsExecuteParams {
  callId: string;
  toolName: string;
  toolVersion: string;
  arguments: Record<string, unknown>;
  sessionId: string;
  turnId: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

export interface ToolsExecuteResult {
  callId: string;
  status: 'completed' | 'denied' | 'cancelled' | 'failed' | 'synthetic';
  canonicalValueId?: string | undefined;
  mediaType?: string | undefined;
  valueDigest?: string | undefined;
  error?: {
    message: string;
    code?: string | undefined;
  } | undefined;
}

export interface ToolsInspectParams {
  callId: string;
  sessionId: string;
  includeArguments?: boolean;
  includeOutput?: boolean;
}

export interface ToolsInspectResult {
  callId: string;
  toolName: string;
  status: string;
  duration?: number | undefined;
  attempts: number;
  riskClass?: string | undefined;
  owner?: string | undefined;
  redactedArguments?: Record<string, unknown> | undefined;
  redactedOutput?: unknown | undefined;
}

export interface ProvidersResolveParams {
  sessionId: string;
  routePreference?: string;
  requiredCapabilities?: string[];
}

export interface ProvidersResolveResult {
  routeId: string;
  provider: string;
  model: string;
  adapterVersion: string;
  contextCapacity: number;
  pinned: boolean;
}

export interface ProvidersStreamParams {
  sessionId: string;
  turnId: string;
  routeId: string;
  fingerprint: string;
  abortSignal?: boolean;
}

export interface ProvidersStreamResult {
  streamId: string;
  status: 'streaming' | 'completed' | 'cancelled' | 'failed';
  blocksReceived: number;
  completionAnchorId?: string | undefined;
  error?: {
    message: string;
    code?: string | undefined;
    retryable?: boolean | undefined;
  } | undefined;
}

export interface CollaborationDecideParams {
  questionId: string;
  sessionId: string;
  answer: unknown;
  approvalDigest?: string;
  actor: ActorRef;
}

export interface CollaborationDecideResult {
  questionId: string;
  accepted: boolean;
  reason?: string | undefined;
  consumed: boolean;
}

export interface SubagentsLaunchParams {
  parentTurnId: string;
  sessionId: string;
  agentId: string;
  task: string;
  profileId?: string;
  scope: ScopeDescriptorV1;
  actor: ActorRef;
  idempotencyKey: string;
}

export interface SubagentsLaunchResult {
  subagentId: string;
  status: 'launched' | 'rejected' | 'duplicate';
  reason?: string | undefined;
}

export interface SubagentsCancelParams {
  subagentId: string;
  sessionId: string;
  actor: ActorRef;
  reason?: string | undefined;
}

export interface SubagentsCancelResult {
  subagentId: string;
  cancellationRequested: boolean;
  currentState: string;
}

export interface SubagentsStatusParams {
  subagentId: string;
  sessionId: string;
}

export interface SubagentsStatusResult {
  subagentId: string;
  agentId: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed';
  turnsCompleted: number;
  parentTurnId: string;
  resultInjected: boolean;
}

export interface WorkflowsStartParams {
  workflowName: string;
  version: string;
  sessionId: string;
  input: Record<string, unknown>;
  scope: ScopeDescriptorV1;
  actor: ActorRef;
  idempotencyKey: string;
}

export interface WorkflowsStartResult {
  workflowId: string;
  status: 'started' | 'rejected' | 'duplicate';
  reason?: string | undefined;
}

export interface WorkflowsStepParams {
  workflowId: string;
  stepId?: string | undefined;
  input?: Record<string, unknown> | undefined;
  actor: ActorRef;
}

export interface WorkflowsStepResult {
  workflowId: string;
  stepId: string;
  status: 'completed' | 'waiting' | 'failed';
  output?: Record<string, unknown> | undefined;
}

export interface WorkflowsCancelParams {
  workflowId: string;
  actor: ActorRef;
  reason?: string | undefined;
}

export interface WorkflowsCancelResult {
  workflowId: string;
  cancellationRequested: boolean;
  currentState: string;
}

export interface WorkflowsStatusParams {
  workflowId: string;
}

export interface WorkflowsStatusResult {
  workflowId: string;
  workflowName: string;
  state: 'running' | 'completed' | 'cancelled' | 'failed' | 'waiting';
  stepsCompleted: number;
  stepsTotal?: number | undefined;
  currentStepId?: string | undefined;
}

export interface JobsSubmitParams {
  jobType: string;
  sessionId: string;
  input: Record<string, unknown>;
  priority?: 'normal' | 'high' | 'low';
  scope: ScopeDescriptorV1;
  actor: ActorRef;
  idempotencyKey: string;
}

export interface JobsSubmitResult {
  jobId: string;
  status: 'queued' | 'rejected' | 'duplicate';
  reason?: string | undefined;
}

export interface JobsCancelParams {
  jobId: string;
  actor: ActorRef;
  reason?: string | undefined;
}

export interface JobsCancelResult {
  jobId: string;
  cancellationRequested: boolean;
  currentState: string;
}

export interface JobsStatusParams {
  jobId: string;
}

export interface JobsStatusResult {
  jobId: string;
  jobType: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  progress?: number | undefined;
  roundsCompleted: number;
  roundsLimit?: number | undefined;
  output?: Record<string, unknown> | undefined;
}

export interface ProfilesPreviewParams {
  profileId: string;
  sessionId: string;
}

export interface ProfilesPreviewResult {
  profileId: string;
  effectiveDiff: Record<string, unknown>;
  compatible: boolean;
  warnings: string[];
}

export interface ProfilesActivateParams {
  profileId: string;
  sessionId: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

export interface ProfilesActivateResult {
  profileId: string;
  activated: boolean;
  appliedLayers: number;
  reason?: string | undefined;
}

export interface ExecutionRunParams {
  worldId: string;
  code: string;
  language: string;
  bindings?: string[];
  timeout?: number;
  scope: ScopeDescriptorV1;
}

export interface ExecutionRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  bounded: boolean;
  returnValue?: unknown;
}

export interface RuntimeHealthResult {
  processVersion: string;
  protocolVersion: string;
  uptime: number;
  draining: boolean;
  databaseConnected: boolean;
  databaseCompatible: boolean;
  observedSchemaVersion?: string | undefined;
  migrationState?: 'idle' | 'in_progress' | 'failed' | undefined;
  requiredAuthoritiesAvailable: boolean;
}

// ─── Client Implementation ──────────────────────────────────────

export class RuntimeMcpClient {
  private transport: StdioTransport;

  constructor(transport: StdioTransport) {
    this.transport = transport;
  }

  private method(name: string): string {
    return `${RUNTIME_NAMESPACE}.${name}`;
  }

  private async rpc<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const raw = await this.transport.call(this.method(method), params);
    return schema.parse(raw);
  }

  // ─── Capabilities ───────────────────────────────────────────

  async listCapabilities(params: CapabilitiesListParams = {}): Promise<CapabilitiesListResult> {
    return this.rpc('capabilities.list', params as unknown as Record<string, unknown>, RuntimeCapabilitiesListResultSchema);
  }

  async resolveCapability(params: CapabilityResolveParams): Promise<CapabilityResolveResult> {
    return this.rpc('capabilities.resolve', params as unknown as Record<string, unknown>, RuntimeCapabilitiesResolveResultSchema);
  }

  // ─── Prompts ────────────────────────────────────────────────

  async assemblePrompt(params: PromptsAssembleParams): Promise<PromptsAssembleResult> {
    return this.rpc('prompts.assemble', params as unknown as Record<string, unknown>, RuntimePromptsAssembleResultSchema);
  }

  async reconstructPrompt(params: PromptsReconstructParams): Promise<PromptsReconstructResult> {
    return this.rpc('prompts.reconstruct', params as unknown as Record<string, unknown>, RuntimePromptsReconstructResultSchema);
  }

  // ─── Turns ──────────────────────────────────────────────────

  async submitTurn(params: TurnsSubmitParams): Promise<TurnsSubmitResult> {
    return this.rpc('turns.submit', params as unknown as Record<string, unknown>, RuntimeTurnsSubmitResultSchema);
  }

  async cancelTurn(params: TurnsCancelParams): Promise<TurnsCancelResult> {
    return this.rpc('turns.cancel', params as unknown as Record<string, unknown>, RuntimeTurnsCancelResultSchema);
  }

  async resumeTurn(params: TurnsResumeParams): Promise<TurnsResumeResult> {
    return this.rpc('turns.resume', params as unknown as Record<string, unknown>, RuntimeTurnsResumeResultSchema);
  }

  // ─── Queue ──────────────────────────────────────────────────

  async mutateQueue(params: QueueMutateParams): Promise<QueueMutateResult> {
    return this.rpc('queue.mutate', params as unknown as Record<string, unknown>, RuntimeQueueMutateResultSchema);
  }

  // ─── Tools ──────────────────────────────────────────────────

  async describeTools(params: ToolsDescribeParams = {}): Promise<ToolsDescribeResult> {
    return this.rpc('tools.describe', params as unknown as Record<string, unknown>, RuntimeToolsDescribeResultSchema);
  }

  async executeTool(params: ToolsExecuteParams): Promise<ToolsExecuteResult> {
    return this.rpc('tools.execute', params as unknown as Record<string, unknown>, RuntimeToolsExecuteResultSchema);
  }

  async inspectTool(params: ToolsInspectParams): Promise<ToolsInspectResult> {
    return this.rpc('tools.inspect', params as unknown as Record<string, unknown>, RuntimeToolsInspectResultSchema);
  }

  // ─── Providers ──────────────────────────────────────────────

  async resolveProvider(params: ProvidersResolveParams): Promise<ProvidersResolveResult> {
    return this.rpc('providers.resolve', params as unknown as Record<string, unknown>, RuntimeProvidersResolveResultSchema);
  }

  async streamProvider(params: ProvidersStreamParams): Promise<ProvidersStreamResult> {
    return this.rpc('providers.stream', params as unknown as Record<string, unknown>, RuntimeProvidersStreamResultSchema);
  }

  // ─── Collaboration ──────────────────────────────────────────

  async decide(params: CollaborationDecideParams): Promise<CollaborationDecideResult> {
    return this.rpc('collaboration.decide', params as unknown as Record<string, unknown>, RuntimeCollaborationDecideResultSchema);
  }

  // ─── Subagents ──────────────────────────────────────────────

  async launchSubagent(params: SubagentsLaunchParams): Promise<SubagentsLaunchResult> {
    return this.rpc('subagents.launch', params as unknown as Record<string, unknown>, RuntimeSubagentsLaunchResultSchema);
  }

  async cancelSubagent(params: SubagentsCancelParams): Promise<SubagentsCancelResult> {
    return this.rpc('subagents.cancel', params as unknown as Record<string, unknown>, RuntimeSubagentsCancelResultSchema);
  }

  async getSubagentStatus(params: SubagentsStatusParams): Promise<SubagentsStatusResult> {
    return this.rpc('subagents.status', params as unknown as Record<string, unknown>, RuntimeSubagentsStatusResultSchema);
  }

  // ─── Workflows ──────────────────────────────────────────────

  async startWorkflow(params: WorkflowsStartParams): Promise<WorkflowsStartResult> {
    return this.rpc('workflows.start', params as unknown as Record<string, unknown>, RuntimeWorkflowsStartResultSchema);
  }

  async stepWorkflow(params: WorkflowsStepParams): Promise<WorkflowsStepResult> {
    return this.rpc('workflows.step', params as unknown as Record<string, unknown>, RuntimeWorkflowsStepResultSchema);
  }

  async cancelWorkflow(params: WorkflowsCancelParams): Promise<WorkflowsCancelResult> {
    return this.rpc('workflows.cancel', params as unknown as Record<string, unknown>, RuntimeWorkflowsCancelResultSchema);
  }

  async getWorkflowStatus(params: WorkflowsStatusParams): Promise<WorkflowsStatusResult> {
    return this.rpc('workflows.status', params as unknown as Record<string, unknown>, RuntimeWorkflowsStatusResultSchema);
  }

  // ─── Jobs ───────────────────────────────────────────────────

  async submitJob(params: JobsSubmitParams): Promise<JobsSubmitResult> {
    return this.rpc('jobs.submit', params as unknown as Record<string, unknown>, RuntimeJobsSubmitResultSchema);
  }

  async cancelJob(params: JobsCancelParams): Promise<JobsCancelResult> {
    return this.rpc('jobs.cancel', params as unknown as Record<string, unknown>, RuntimeJobsCancelResultSchema);
  }

  async getJobStatus(params: JobsStatusParams): Promise<JobsStatusResult> {
    return this.rpc('jobs.status', params as unknown as Record<string, unknown>, RuntimeJobsStatusResultSchema);
  }

  // ─── Profiles ───────────────────────────────────────────────

  async previewProfile(params: ProfilesPreviewParams): Promise<ProfilesPreviewResult> {
    return this.rpc('profiles.preview', params as unknown as Record<string, unknown>, RuntimeProfilesPreviewResultSchema);
  }

  async activateProfile(params: ProfilesActivateParams): Promise<ProfilesActivateResult> {
    return this.rpc('profiles.activate', params as unknown as Record<string, unknown>, RuntimeProfilesActivateResultSchema);
  }

  // ─── Execution ──────────────────────────────────────────────

  async runExecution(params: ExecutionRunParams): Promise<ExecutionRunResult> {
    return this.rpc('execution.run', params as unknown as Record<string, unknown>, RuntimeExecutionRunResultSchema);
  }

  // ─── Diagnostics ────────────────────────────────────────────

  async getHealth(): Promise<RuntimeHealthResult> {
    return this.rpc('diagnostics.health', {}, RuntimeDiagnosticsHealthResultSchema);
  }
}
