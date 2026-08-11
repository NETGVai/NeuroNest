/**
 * Cloudflare OS Integration — Shared TypeScript interfaces.
 *
 * Defines all interfaces for the ten Cloudflare OS-inspired subsystems
 * integrated into NeuroNest: Gadget Engine, Blueprint Registry, Gatekeeper Layer,
 * Simulated Approval, Observation Tracker, Context Library, Deterministic Workflow
 * Engine, Code Mode Agent, RPC Generator, and Multi-Model Cost Router.
 *
 * Requirements: All (1–10)
 */

// ─── Gadget Engine ──────────────────────────────────────────────

/** Specification for creating a new Gadget */
export interface GadgetSpec {
  id: string;
  name: string;
  description: string;
  hasClient: boolean;
  hasServer: boolean;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
}

/** Handle to a running or stopped Gadget instance */
export interface GadgetHandle {
  id: string;
  pid: number;
  status: 'running' | 'stopped' | 'crashed' | 'creating';
  rpcInterface: RPCInterfaceDefinition;
  serverPort: number;
  clientUrl?: string;
}

/** Gadget Engine lifecycle management interface */
export interface GadgetEngine {
  create(spec: GadgetSpec): Promise<GadgetHandle>;
  start(gadgetId: string): Promise<GadgetHandle>;
  stop(gadgetId: string): Promise<void>;
  destroy(gadgetId: string): Promise<void>;
  modify(gadgetId: string, patch: CodePatch): Promise<GadgetHandle>;
  list(): GadgetHandle[];
  getState(gadgetId: string): GadgetPersistentState;
  restoreAll(): Promise<GadgetHandle[]>;
}

/** Code patch applied to modify a Gadget */
export interface CodePatch {
  filePath: string;
  content: string;
  operation: 'create' | 'update' | 'delete';
}

/** Persisted Gadget state for session restoration */
export interface GadgetPersistentState {
  id: string;
  name: string;
  description: string;
  status: 'running' | 'stopped' | 'crashed' | 'creating';
  sourceChecksum: string;
  capabilityIds: string[];
  dbPath: string;
  sourcePath: string;
}

// ─── Blueprint Registry ─────────────────────────────────────────

/** A shareable application template */
export interface Blueprint {
  id: string;
  name: string;
  description: string;
  author: string;
  version: number;
  createdAt: string;
  capabilityRequirements: string[];
  entryPoints: { server?: string; client?: string };
  checksum: string;
}

/** A specific version of a Blueprint */
export interface BlueprintVersion {
  blueprintId: string;
  version: number;
  sourceArchive: Buffer;
  manifest: BlueprintManifest;
  createdAt: string;
}

/** Manifest describing a Blueprint's structure */
export interface BlueprintManifest {
  name: string;
  description: string;
  entryPoints: { server?: string; client?: string };
  rpcInterface: RPCInterfaceDefinition;
  capabilities: string[];
  files: { path: string; checksum: string }[];
}

/** Metadata for publishing a Gadget as a Blueprint */
export interface BlueprintMetadata {
  name: string;
  description: string;
  author: string;
}

/** Result of a Blueprint validation check */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Blueprint Registry interface for managing templates */
export interface BlueprintRegistry {
  publish(gadgetId: string, metadata: BlueprintMetadata): Promise<Blueprint>;
  instantiate(blueprintId: string, version?: number): Promise<GadgetHandle>;
  rollback(blueprintId: string, targetVersion: number): Promise<Blueprint>;
  search(query: string): Blueprint[];
  export(blueprintId: string): Promise<Buffer>;
  import(archive: Buffer): Promise<Blueprint>;
  validate(archive: Buffer): ValidationResult;
  listVersions(blueprintId: string): BlueprintVersion[];
}

// ─── Gatekeeper Layer ───────────────────────────────────────────

/** An unforgeable, scoped capability reference for accessing external resources */
export interface CapabilityBinding {
  id: string;
  resourceId: string;
  resourceType: string;
  allowedOperations: string[];
  scopeConstraints: Record<string, string>;
  rateLimit?: { maxRequests: number; windowMs: number };
  expiresAt?: string;
  createdAt: string;
  grantedBy: string;
}

/** Audit log entry for operations executed through capabilities */
export interface AuditEntry {
  id: string;
  timestamp: string;
  actorId: string;
  actorType: 'agent' | 'gadget' | 'code_mode';
  resourceId: string;
  operation: string;
  parameters: Record<string, unknown>;
  resultStatus: 'success' | 'denied' | 'error';
  capabilityId: string;
}

/** Filter options for querying the audit log */
export interface AuditFilter {
  actorId?: string;
  resourceId?: string;
  startTime?: string;
  endTime?: string;
  resultStatus?: 'success' | 'denied' | 'error';
  limit?: number;
}

/** Resource definition for introducing a new resource to the Gatekeeper */
export interface ResourceDefinition {
  id: string;
  type: string;
  name: string;
  allowedOperations: string[];
  scopeConstraints?: Record<string, string>;
  rateLimit?: { maxRequests: number; windowMs: number };
  expiresAt?: string;
}

/** Decision returned when access is requested */
export interface AccessDecision {
  granted: boolean;
  binding?: CapabilityBinding;
  reason: string;
}

/** Gatekeeper Layer interface for capability-based security */
export interface GatekeeperLayer {
  introduceResource(resource: ResourceDefinition): Promise<CapabilityBinding>;
  revokeCapability(bindingId: string): void;
  execute(binding: CapabilityBinding, operation: string, params: unknown): Promise<unknown>;
  requestAccess(agentId: string, resourceType: string, scope: string): Promise<AccessDecision>;
  getAuditLog(filter?: AuditFilter): AuditEntry[];
  getPendingApprovals(): PendingAction[];
  approveAction(actionId: string): Promise<void>;
  rejectAction(actionId: string, reason: string): Promise<void>;
  bulkApprove(actionIds: string[]): Promise<void>;
}

// ─── Simulated Approval ─────────────────────────────────────────

/** A pending side-effecting action awaiting human review */
export interface PendingAction {
  id: string;
  agentId: string;
  capabilityId: string;
  operation: string;
  parameters: Record<string, unknown>;
  simulatedResult: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'rolled_back';
  dependsOn: string[];
  createdAt: string;
  resolvedAt?: string;
  rejectionReason?: string;
}

/** Result of executing an approved action */
export interface ExecutionResult {
  actionId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Result of rolling back a rejected action */
export interface RollbackResult {
  actionId: string;
  rolledBack: boolean;
  affectedDependents: string[];
}

/** Simulated Approval Engine interface */
export interface SimulatedApprovalEngine {
  simulate(binding: CapabilityBinding, operation: string, params: unknown): Promise<PendingAction>;
  getQueue(): PendingAction[];
  approve(actionId: string): Promise<ExecutionResult>;
  reject(actionId: string, reason: string): Promise<RollbackResult>;
  bulkApprove(actionIds: string[]): Promise<ExecutionResult[]>;
  bulkReject(actionIds: string[], reason: string): Promise<RollbackResult[]>;
  getDependencyGraph(actionId: string): PendingAction[];
  persistQueue(): void;
  restoreQueue(): PendingAction[];
}

// ─── Observation Tracker ────────────────────────────────────────

/** Record of a resource observation by an actor */
export interface Observation {
  id: string;
  actorId: string;
  actorType: 'agent' | 'gadget';
  resourceId: string;
  dataScope: string;
  accessLevel: 'public' | 'internal' | 'confidential' | 'restricted';
  timestamp: string;
  capabilityId: string;
}

/** Policy governing how data can flow between access levels */
export interface DataFlowPolicy {
  id: string;
  name: string;
  sourceAccessLevel: string;
  allowedDestinations: string[];
  blockedOperations: string[];
}

/** Result of checking access permissions against observations */
export interface AccessCheckResult {
  allowed: boolean;
  missingPermissions: string[];
  observedResources: string[];
  error?: string;
}

/** Decision from evaluating a data flow request */
export interface FlowDecision {
  allowed: boolean;
  reason: string;
  violatedPolicyId?: string;
}

/** Observation Tracker interface for data-flow policy enforcement */
export interface ObservationTracker {
  recordObservation(obs: Omit<Observation, 'id' | 'timestamp'>): Observation;
  getObservations(actorId: string): Observation[];
  checkAccess(userId: string, gadgetId: string): AccessCheckResult;
  evaluateDataFlow(actorId: string, destination: string, operation: string): FlowDecision;
  getMissingPermissions(userId: string, observations: Observation[]): string[];
  clearObservations(actorId: string): void;
}

// ─── Context Library ────────────────────────────────────────────

/** A curated context entry for enriching agent prompts */
export interface ContextEntry {
  id: string;
  name: string;
  scope: 'workspace' | 'project' | 'session';
  scopeId: string;
  content: string;
  tags: string[];
  priority: number;
  tokenCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Configuration for the Context Library */
export interface ContextLibraryConfig {
  maxTokenBudget: number;
  scopePrecedence: ('session' | 'project' | 'workspace')[];
}

/** Parameters for resolving context for a session */
export interface SessionResolveParams {
  workspacePath: string;
  projectId: string;
  sessionId: string;
  agentSpecialization?: string;
  taskType?: string;
}

/** Resolved context ready for injection into agent prompts */
export interface ResolvedContext {
  entries: ContextEntry[];
  totalTokens: number;
  truncated: boolean;
  injectedText: string;
}

/** A convention captured from agent output */
export interface CapturedConvention {
  name: string;
  content: string;
  scope: 'workspace' | 'project' | 'session';
  tags: string[];
}

/** Context Library interface for curated organizational knowledge */
export interface ContextLibrary {
  addEntry(entry: Omit<ContextEntry, 'id' | 'createdAt' | 'updatedAt' | 'tokenCount'>): ContextEntry;
  updateEntry(id: string, patch: Partial<ContextEntry>): ContextEntry;
  removeEntry(id: string): void;
  getEntries(scope: string, scopeId: string): ContextEntry[];
  resolveContext(sessionContext: SessionResolveParams): ResolvedContext;
  suggestCapture(agentOutput: string, conventions: string[]): CapturedConvention | null;
  previewInjection(sessionContext: SessionResolveParams): string;
}

// ─── Deterministic Workflow Engine ──────────────────────────────

/** A workflow definition with steps and triggers */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  projectId: string;
  steps: WorkflowStep[];
  triggers: WorkflowTrigger[];
  createdAt: string;
  updatedAt: string;
}

/** A single step in a workflow */
export interface WorkflowStep {
  id: string;
  name: string;
  type: 'code' | 'inference';
  code?: string;
  inferencePrompt?: string;
  modelOverride?: string;
  dependsOn: string[];
  timeout: number;
}

/** Trigger configuration for a workflow */
export interface WorkflowTrigger {
  type: 'manual' | 'cron' | 'file_watch';
  config: Record<string, string>;
}

/** Record of a workflow execution */
export interface WorkflowExecution {
  id: string;
  workflowId: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  startedAt: string;
  completedAt?: string;
  stepResults: Map<string, StepResult>;
  tokenUsage: { generation: number; execution: number };
}

/** Result of executing a single workflow step */
export interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped';
  output?: unknown;
  error?: string;
  durationMs: number;
  tokensUsed?: number;
}

/** Token usage report for a workflow */
export interface TokenReport {
  workflowId: string;
  totalGeneration: number;
  totalExecution: number;
  byStep: { stepId: string; tokens: number; type: 'code' | 'inference' }[];
}

/** Diagnosis result for a failed workflow step */
export interface DiagnosisResult {
  stepId: string;
  errorSummary: string;
  suggestedFix: string;
  confidence: number;
}

/** Workflow Engine interface for deterministic code pipelines */
export interface WorkflowEngine {
  create(description: string, projectId: string): Promise<WorkflowDefinition>;
  validate(workflow: WorkflowDefinition): ValidationResult;
  execute(workflowId: string, input?: Record<string, unknown>): Promise<WorkflowExecution>;
  pause(executionId: string): void;
  resume(executionId: string): Promise<WorkflowExecution>;
  getHistory(workflowId: string): WorkflowExecution[];
  getTokenReport(workflowId: string): TokenReport;
  diagnose(executionId: string, stepId: string): Promise<DiagnosisResult>;
}

// ─── Code Mode Agent ────────────────────────────────────────────

/** Context provided to Code Mode for execution */
export interface CodeModeContext {
  capabilities: CapabilityBinding[];
  gadgetApis: Map<string, RPCInterfaceDefinition>;
  sessionId: string;
  agentId: string;
}

/** A code snippet with execution metadata */
export interface CodeSnippet {
  id: string;
  code: string;
  language: 'typescript' | 'javascript';
  executedAt: string;
  duration: number;
  result?: unknown;
  error?: CodeModeError;
}

/** Error captured from Code Mode execution */
export interface CodeModeError {
  message: string;
  stack: string;
  line: number;
  column: number;
}

/** Resource limits for Code Mode execution */
export interface CodeModeLimits {
  executionTimeMs: number;
  memoryMb: number;
  maxSnippetsPerSession: number;
}

/** Proxy for calling a Gadget's RPC methods from Code Mode */
export interface GadgetRPCProxy {
  gadgetId: string;
  call(method: string, ...args: unknown[]): Promise<unknown>;
}

/** Code Mode Agent interface for agent-as-code-writer execution */
export interface CodeModeAgent {
  execute(code: string, context: CodeModeContext): Promise<CodeSnippet>;
  getHistory(sessionId: string): CodeSnippet[];
  getGadgetProxy(gadgetId: string, context: CodeModeContext): GadgetRPCProxy;
  setLimits(limits: Partial<CodeModeLimits>): void;
}

// ─── RPC Generator ──────────────────────────────────────────────

/** Definition of a Gadget's typed RPC interface */
export interface RPCInterfaceDefinition {
  gadgetId: string;
  version: number;
  methods: RPCMethod[];
  generatedAt: string;
  typeDefinitions: string;
}

/** A single RPC method definition */
export interface RPCMethod {
  name: string;
  parameters: RPCParameter[];
  returnType: string;
  description?: string;
}

/** Parameter definition for an RPC method */
export interface RPCParameter {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

/** Validation error for an RPC call */
export interface RPCValidationError {
  method: string;
  mismatches: { parameter: string; expected: string; received: string }[];
  missingParams: string[];
}

/** RPC Generator interface for automatic API generation */
export interface RPCGenerator {
  generate(gadgetId: string, sourceCode: string): RPCInterfaceDefinition;
  regenerate(gadgetId: string): Promise<RPCInterfaceDefinition>;
  validate(gadgetId: string, method: string, args: unknown[]): RPCValidationError | null;
  getTypeDefinitions(gadgetId: string): string;
}

// ─── Multi-Model Cost Router ────────────────────────────────────

/** Complexity tier for routing inference requests */
export interface ComplexityTier {
  name: 'simple' | 'moderate' | 'complex' | 'frontier';
  models: string[];
  maxCostPerRequest: number;
}

/** Cost budget configuration for a scope */
export interface CostBudget {
  scope: 'workspace' | 'project' | 'workflow';
  scopeId: string;
  dailyLimit: number;
  monthlyLimit: number;
  currentDaily: number;
  currentMonthly: number;
  warnThreshold: number;
  downgradeThreshold: number;
  abortThreshold: number;
}

/** Decision made by the Cost Router for a request */
export interface RoutingDecision {
  selectedModel: string;
  tier: string;
  reason: string;
  budgetStatus: 'normal' | 'warned' | 'downgraded' | 'exhausted';
  estimatedCost: number;
}

/** Options for routing an inference request */
export interface RoutingOptions {
  preferredModel?: string;
  maxCost?: number;
  taskHint?: string;
  workflowId?: string;
  projectId?: string;
}

/** Filter options for the cost dashboard */
export interface DashboardFilter {
  startDate?: string;
  endDate?: string;
  scope?: string;
  scopeId?: string;
}

/** Aggregated cost dashboard data */
export interface CostDashboard {
  byUser: { userId: string; cost: number }[];
  byAgent: { agentId: string; cost: number }[];
  byWorkflow: { workflowId: string; cost: number }[];
  byModel: { model: string; cost: number; requestCount: number }[];
  daily: { date: string; cost: number }[];
  monthly: { month: string; cost: number }[];
}

/** Cost Router interface for intelligent inference budgeting */
export interface CostRouter {
  classify(messages: ChatMessage[], taskHint?: string): ComplexityTier;
  route(messages: ChatMessage[], options?: RoutingOptions): RoutingDecision;
  getBudget(scope: string, scopeId: string): CostBudget;
  setBudget(budget: Omit<CostBudget, 'currentDaily' | 'currentMonthly'>): void;
  getDashboard(filter?: DashboardFilter): CostDashboard;
  notifyBudgetStatus(budget: CostBudget): void;
}

// ─── Re-export ChatMessage from provider-registry ───────────────

// ChatMessage is referenced in CostRouter. Import from provider-registry at implementation time.
// Re-declared here for self-containment of type definitions.
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}
