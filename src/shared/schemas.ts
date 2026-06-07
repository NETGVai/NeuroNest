import { z } from 'zod';

// ─── Native Shell ───────────────────────────────────────────────

export const WindowConfigSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  minWidth: z.number().int().positive(),
  minHeight: z.number().int().positive(),
  titleBarStyle: z.enum(['hiddenInset', 'default']),
});

export const WindowStateSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  isMaximized: z.boolean(),
});

// ─── Model Backend (Pi_AI) ──────────────────────────────────────

export const TaskCategorySchema = z.enum([
  'code-generation',
  'code-review',
  'planning',
  'chat',
]);

export const ModelConfigSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});

export const ProviderTypeSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'mistral',
  'groq',
  'ollama',
  'llamacpp',
]);

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  type: ProviderTypeSchema,
  apiKeyRef: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()),
});

export const TokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimatedCost: z.number().nonnegative(),
});

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

export const ChatChunkSchema = z.object({
  type: z.enum(['text', 'tool_call', 'usage', 'done']),
  content: z.string().optional(),
  toolCall: ToolCallSchema.optional(),
  usage: TokenUsageSchema.optional(),
});

// ─── Tool System ────────────────────────────────────────────────

export const RiskLevelSchema = z.enum(['read-only', 'write', 'execute', 'destructive']);
export const PermissionModeSchema = z.enum(['prompt', 'auto-approve', 'plan-mode']);

export const ToolDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  riskLevel: RiskLevelSchema,
});

export const ToolContextSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  projectDir: z.string().optional(),
  permissionMode: PermissionModeSchema,
});

export const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.unknown(),
  error: z.string().optional(),
  tokenUsage: TokenUsageSchema.optional(),
});

// ─── Permission System ──────────────────────────────────────────

export const PermissionRequestSchema = z.object({
  toolId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.unknown(),
  riskLevel: RiskLevelSchema,
});

export const PermissionDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string(),
  requiresUserApproval: z.boolean(),
});

// ─── Session & Messages ─────────────────────────────────────────

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

export const MessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string(),
  toolCalls: z.array(ToolCallSchema).optional(),
  tokenUsage: TokenUsageSchema.optional(),
  createdAt: z.coerce.date(),
});

export const SessionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  projectDir: z.string().optional(),
  messages: z.array(MessageSchema),
  activeAgentIds: z.array(z.string()),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ─── SuperAgent & Identity ──────────────────────────────────────

export const AgentIdentityFilesSchema = z.object({
  soulMd: z.string(),
  identityMd: z.string(),
  toolsMd: z.string(),
  claudeMd: z.string(),
});

export const AgentTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  systemPrompt: z.string(),
  domain: z.string().optional(),
  modelPreference: ModelConfigSchema,
  toolPermissions: z.array(z.string()),
  identityFiles: AgentIdentityFilesSchema,
});

export const AgentIdentitySchema = z.object({
  soul: z.string(),
  identity: z.string(),
  tools: z.string(),
  claude: z.string(),
});

// ─── Orchestrator (CAO) ─────────────────────────────────────────

export const OrchestrationPatternSchema = z.enum(['handoff', 'assign', 'send_message']);
export const TaskNodeStatusSchema = z.enum(['pending', 'queued', 'running', 'completed', 'failed', 'skipped']);

export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  assignedAgent: z.string().optional(),
  status: TaskNodeStatusSchema,
  estimatedTokens: z.number().int().nonnegative().optional(),
  output: z.string().optional(),
});

export const TaskEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  pattern: OrchestrationPatternSchema,
  condition: z.string().optional(),
});

export const TaskGraphSchema = z.object({
  nodes: z.array(TaskNodeSchema),
  edges: z.array(TaskEdgeSchema),
});

export const FlowConfigSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  orchestratorTemplate: z.string().min(1),
  enabled: z.boolean(),
});

// ─── Workflow Builder ───────────────────────────────────────────

export const WorkflowNodeTypeSchema = z.enum(['task', 'conditional', 'human_approval', 'subworkflow']);
export const WorkflowNodeStatusSchema = z.enum(['pending', 'queued', 'running', 'completed', 'failed']);

export const WorkflowNodeSchema = z.object({
  id: z.string().min(1),
  type: WorkflowNodeTypeSchema,
  description: z.string(),
  assignedAgentId: z.string().optional(),
  estimatedTokenCost: z.number().nonnegative().optional(),
  position: z.object({ x: z.number(), y: z.number() }),
  status: WorkflowNodeStatusSchema.optional(),
});

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  pattern: OrchestrationPatternSchema,
  condition: z.string().optional(),
});

export const WorkflowMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const WorkflowDesignSchema = z.object({
  id: z.string().min(1),
  nodes: z.array(WorkflowNodeSchema),
  edges: z.array(WorkflowEdgeSchema),
  metadata: WorkflowMetadataSchema,
});

// ─── Plugin System ──────────────────────────────────────────────

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  author: z.string().min(1),
  dependencies: z.record(z.string(), z.string()),
  permissions: z.array(z.string()),
  entryPoint: z.string().min(1),
});

// ─── IDE Bridge ─────────────────────────────────────────────────

export const IDEMessageSchema = z.object({
  type: z.string().min(1),
  payload: z.unknown(),
  requestId: z.string().optional(),
});

// ─── Swarm (agent-swarm) ────────────────────────────────────────

export const SwarmStatusSchema = z.enum([
  'planning',
  'awaiting_approval',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const SwarmConfigSchema = z.object({
  task: z.string().min(1),
  workerAgentIds: z.array(z.string()),
  maxConcurrent: z.number().int().min(2).max(20),
  humanCheckpoints: z.array(z.string()).optional(),
  workflowTemplate: z.string().optional(),
});

// ─── Application Config ─────────────────────────────────────────

export const AppThemeSchema = z.enum(['light', 'dark', 'system']);

export const DockerSettingsSchema = z.object({
  socketPath: z.string().min(1),
  maxContainers: z.number().int().positive(),
});

export const FeatureFlagsSchema = z.object({
  hyperAgents: z.boolean(),
  agentSwarm: z.boolean(),
  cao: z.boolean(),
  promptOptimizer: z.boolean(),
});

export const GuardrailsConfigSchema = z.object({
  'sandbox-isolation': z.boolean(),
  'command-policy': z.boolean(),
  'cost-tracking': z.boolean(),
  'trace-recording': z.boolean(),
  'prompt-rewind': z.boolean(),
});

export const AppConfigSchema = z.object({
  theme: AppThemeSchema,
  fontSize: z.number().positive(),
  defaultModels: z.record(TaskCategorySchema, ModelConfigSchema),
  dockerSettings: DockerSettingsSchema,
  featureFlags: FeatureFlagsSchema,
  guardrails: GuardrailsConfigSchema.optional(),
  professionalMode: z.boolean(),
  proxyAuthToken: z.string().optional(),
  proxyEndpoint: z.string().min(1),
  lowBalanceThresholdUsd: z.number().nonnegative(),
  inputBudget: z.number().int().positive().nullable().optional(),
  teacherModel: z.string().nullable().optional(),
  teacherEndpointUrl: z.string().url().nullable().optional(),
});

// ─── Chat Request (composite) ───────────────────────────────────

export const ChatRequestSchema = z.object({
  model: ModelConfigSchema,
  messages: z.array(MessageSchema),
  tools: z.array(ToolDefinitionSchema).optional(),
  stream: z.boolean(),
  maxTokens: z.number().int().positive().optional(),
});
