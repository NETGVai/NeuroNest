// Core TypeScript interfaces and data models
// Matches the design document interfaces exactly

// ─── Native Shell ───────────────────────────────────────────────

export interface WindowConfig {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  titleBarStyle: 'hiddenInset' | 'default';
}

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

// ─── Model Backend (Pi_AI) ──────────────────────────────────────

export type TaskCategory = 'code-generation' | 'code-review' | 'planning' | 'chat';

export interface ModelConfig {
  providerId: string;
  model: string;
}

export interface ProviderConfig {
  id: string;
  type: 'openai' | 'anthropic' | 'gemini' | 'mistral' | 'groq' | 'ollama' | 'llamacpp' | 'nvidia';
  apiKeyRef?: string;
  baseUrl?: string;
  models: string[];
}

export interface ChatRequest {
  model: ModelConfig;
  messages: Message[];
  tools?: ToolDefinition[];
  stream: boolean;
  maxTokens?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatChunk {
  type: 'text' | 'tool_call' | 'usage' | 'done';
  content?: string;
  toolCall?: ToolCall;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

// ─── Tool System ────────────────────────────────────────────────

export type RiskLevel = 'read-only' | 'write' | 'execute' | 'destructive';
export type PermissionMode = 'prompt' | 'auto-approve' | 'plan-mode';

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: RiskLevel;
}

export interface ToolContext {
  agentId: string;
  sessionId: string;
  projectDir?: string;
  permissionMode: PermissionMode;
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
  tokenUsage?: TokenUsage;
}

// ─── Permission System ──────────────────────────────────────────

export interface PermissionRequest {
  toolId: string;
  agentId: string;
  input: unknown;
  riskLevel: RiskLevel;
}

export interface PermissionDecision {
  allowed: boolean;
  reason: string;
  requiresUserApproval: boolean;
}

// ─── Session & Messages ─────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCalls?: ToolCall[];
  tokenUsage?: TokenUsage;
  createdAt: Date;
}

export interface Session {
  id: string;
  name: string;
  projectDir?: string;
  messages: Message[];
  activeAgentIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

// ─── SuperAgent & Identity ──────────────────────────────────────

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  domain?: string;
  modelPreference: ModelConfig;
  toolPermissions: string[];
  identityFiles: AgentIdentityFiles;
}

export interface AgentIdentityFiles {
  soulMd: string;
  identityMd: string;
  toolsMd: string;
  claudeMd: string;
}

export interface AgentIdentity {
  soul: string;
  identity: string;
  tools: string;
  claude: string;
}

// ─── Orchestrator (CAO) ─────────────────────────────────────────

export type OrchestrationPattern = 'handoff' | 'assign' | 'send_message';
export type TaskNodeStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'skipped';

export interface TaskGraph {
  nodes: TaskNode[];
  edges: TaskEdge[];
}

export interface TaskNode {
  id: string;
  description: string;
  assignedAgent?: string;
  status: TaskNodeStatus;
  estimatedTokens?: number;
  output?: string;
}

export interface TaskEdge {
  from: string;
  to: string;
  pattern: OrchestrationPattern;
  condition?: string;
}

export interface FlowConfig {
  name: string;
  schedule: string;
  orchestratorTemplate: string;
  enabled: boolean;
}

// ─── Workflow Builder ───────────────────────────────────────────

export type WorkflowNodeType = 'task' | 'conditional' | 'human_approval' | 'subworkflow';
export type WorkflowNodeStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed';

export interface WorkflowDesign {
  id: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  metadata: WorkflowMetadata;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  description: string;
  assignedAgentId?: string;
  estimatedTokenCost?: number;
  position: { x: number; y: number };
  status?: WorkflowNodeStatus;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  pattern: OrchestrationPattern;
  condition?: string;
}

export interface WorkflowMetadata {
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Plugin System ──────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  dependencies: Record<string, string>;
  permissions: string[];
  entryPoint: string;
}

// ─── IDE Bridge ─────────────────────────────────────────────────

export interface IDEMessage {
  type: string;
  payload: unknown;
  requestId?: string;
}

// ─── Swarm (agent-swarm) ────────────────────────────────────────

export type SwarmStatus = 'planning' | 'awaiting_approval' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SwarmConfig {
  task: string;
  workerAgentIds: string[];
  maxConcurrent: number;
  humanCheckpoints?: string[];
  workflowTemplate?: string;
}

// ─── Application Config ─────────────────────────────────────────

export type AppTheme = 'light' | 'dark' | 'system';

export interface DockerSettings {
  socketPath: string;
  maxContainers: number;
}

export interface FeatureFlags {
  hyperAgents: boolean;
  agentSwarm: boolean;
  cao: boolean;
  promptOptimizer: boolean;
  agentSkillsAutoAssignment?: boolean;
  agentSkillsCompetencyTracking?: boolean;
  agentSkillsPerformanceTracking?: boolean;
  agentSkillsWebSocket?: boolean;
}

export interface GuardrailsConfig {
  'sandbox-isolation': boolean;
  'command-policy': boolean;
  'cost-tracking': boolean;
  'trace-recording': boolean;
  'prompt-rewind': boolean;
}

export interface AppConfig {
  theme: AppTheme;
  fontSize: number;
  defaultModels: Record<TaskCategory, ModelConfig>;
  dockerSettings: DockerSettings;
  featureFlags: FeatureFlags;
  guardrails?: GuardrailsConfig;
  // ─── Professional Mode (LLM Proxy) ──────────────────────────
  /** When true, all non-local provider requests route through the LLM proxy. */
  professionalMode: boolean;
  /** Bearer token for authenticating requests to the LLM proxy. */
  proxyAuthToken?: string;
  /** Base URL for the LLM proxy (e.g. `https://llm.neuronest.cc/v1`). */
  proxyEndpoint: string;
  /** Threshold (USD) at which the renderer surfaces a low-balance warning. */
  lowBalanceThresholdUsd: number;
}
