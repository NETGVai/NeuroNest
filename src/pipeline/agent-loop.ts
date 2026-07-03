/**
 * Agent Loop Controller — Iterative tool-use loop connecting LLM responses to real tool execution.
 *
 * Implements the standard agentic pattern:
 * 1. Send conversation (system prompt + history + user message) to LLM
 * 2. If response contains `tool_calls` → execute each via ToolSystem, append results as `tool` role messages
 * 3. Send updated conversation back to LLM
 * 4. Repeat until no more tool calls or maxIterations reached
 *
 * Requirements: 1.1, 7.1, 7.5, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 14.1
 */

import type { ToolSystem } from '../tools/tool-system.js';
import type { ToolContext, ToolResult, TokenUsage, ToolDefinition } from '../shared/types.js';
import type { TaskClassification, ParameterProfile, BenchmarkRun, ArtifactType } from '../shared/feature-integration-types.js';
import { AGENT_REGISTRY } from '../agents/agent-registry.js';
import type { AgentTask } from './orchestrator-planner.js';
import { loadAIRules } from './simple-responder.js';
import { SmartContextSelector } from './smart-context.js';
import type { SmartContextResult } from './smart-context.js';
import type { LLMClient } from './llm-client';
import type { CallbackEngine } from './callback-engine.js';
import type { AutoTuner } from '../benchmark/auto-tuner.js';
import type { ExecutionTraceService } from '../infrastructure/execution-trace-service.js';
import type { ArtifactService } from '../artifacts/artifact-service.js';
import type { VisionAnalyzerService } from '../vision/vision-analyzer-service.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import { DriftMonitor } from '../drift/drift-monitor.js';
import type { DriftConfig } from '../drift/drift-config.js';
import { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { FeatureGateFlags } from '../feature-gate/feature-gate-config.js';
import type { SuperagentConfig } from '../feature-gate/superagent-config.js';
import { CostTrackingService } from '../observability/cost-tracking-service.js';
import { CheckpointService } from '../durability/checkpoint-service.js';
import type { CheckpointData } from '../durability/checkpoint-service.js';
import { SpecialistRoleLoader } from '../orchestration/specialist-role-loader.js';
import { VulnerabilityBlocker } from '../security/vulnerability-blocker.js';
import { SupplyChainDetector } from '../security/supply-chain-detector.js';
import { DependencyGroundingService } from '../intelligence/dependency-grounding.js';
import { MemoryStore } from '../intelligence/memory-store.js';
import { LSPBridge } from '../intelligence/lsp-bridge.js';
import { CredentialVault } from '../security/credential-vault.js';
import { ModelRouter } from '../routing/model-router.js';
import { BehavioralRulesEngine } from '../intelligence/behavioral-rules-engine.js';
import { WorktreeIsolation } from '../orchestration/worktree-isolation.js';
import { ASTLockManager } from '../orchestration/ast-lock-manager.js';
import { ProviderFailover } from '../routing/provider-failover.js';
import { ParallelAgentExecutor } from '../orchestration/parallel-agent-executor.js';
import { CompletionCouncil } from '../orchestration/completion-council.js';
import { ContainerSandbox } from '../security/container-sandbox.js';
import { TraceVisualizationService } from '../observability/trace-visualization-service.js';
import { HeadlessMode } from '../durability/headless-mode.js';
import { SchedulerService } from '../durability/scheduler-service.js';
import { KanbanStateManager } from '../devex/kanban-state-manager.js';
import { ProvenanceTracker } from '../devex/provenance-tracker.js';
import { SkillExtractor } from '../devex/skill-extractor.js';
import { RemoteAccessBridge } from '../devex/remote-access-bridge.js';
import { VoiceIOService } from '../devex/voice-io-service.js';
import { RepoReadinessScanner } from '../intelligence/repo-readiness-scanner.js';
import { ComplianceGateRunner } from '../devex/compliance-gate-runner.js';
import { WasmSandbox } from '../security/wasm-sandbox.js';
import { BrowserAutomation } from '../devex/browser-automation.js';
import { BackpropagationEngine } from '../intelligence/backpropagation-engine.js';
import { ActionFirstDetector, DEFAULT_MAX_RE_PROMPT_ATTEMPTS } from './action-first-detector.js';
import { buildEnhancedSystemPrompt, DEFAULT_CODE_QUALITY_DIRECTIVES, DEFAULT_ACTION_FIRST_DIRECTIVES } from './system-prompt-builder.js';
import type { CodeQualityDirectives, ActionFirstDirectives, SystemPromptConfig } from './system-prompt-builder.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Interfaces ─────────────────────────────────────────────────

/** A single step in an execution plan */
export interface PlanStep {
  order: number;
  description: string;
  toolId: string;
  estimatedInput: Record<string, unknown>;
}

/** An execution plan generated in Plan Mode */
export interface ExecutionPlan {
  id: string;
  steps: PlanStep[];
  estimatedToolCalls: number;
  filesAffected: string[];
  status: 'pending' | 'approved' | 'rejected' | 'modified';
}

/** Result of plan approval callback */
export type PlanApprovalResult = 'approved' | 'rejected' | { feedback: string };

// ─── Orchestrator Plan Validation Types ─────────────────────────

/** Shape of the plan produced by OrchestratorPlanner for validation */
export interface OrchestratorPlan {
  agents: AgentTask[];
  topology: string;
  reasoning?: string;
}

/** Validation outcome from AgentLoopController.validatePlan() */
export type PlanValidationResult =
  | { status: 'approved'; plan: OrchestratorPlan }
  | { status: 'rejected'; reason: string; affectedSteps: string[] }
  | { status: 'refined'; plan: OrchestratorPlan; refinements: string[] };

/** Configuration for the Smart Context subsystem within the Agent Loop */
export interface SmartContextLoopConfig {
  lightModel: LLMClient;
  maxFiles?: number;
  maxTokenBudget?: number;
}

/** Configuration for the AutoTuner integration within the Agent Loop */
export interface AutoTunerLoopConfig {
  /** AutoTuner instance for task classification and parameter recommendation */
  autoTuner: AutoTuner;
  /** Optional historical benchmark runs to refine parameter recommendations */
  getBenchmarkHistory?: (taskType: string) => Promise<BenchmarkRun[]>;
  /**
   * Callback invoked before execution starts, presenting the user with the
   * auto-selected parameters and allowing override. If not provided, parameters
   * are applied without user interaction.
   * Return null/undefined to accept the recommended profile, or a modified profile to override.
   */
  onParameterOverride?: (params: AutoTunerResult) => Promise<ParameterProfile | null | undefined>;
}

/** Result of auto-tuning classification passed to the user override callback */
export interface AutoTunerResult {
  /** The classified task type */
  classification: TaskClassification;
  /** The recommended parameter profile (possibly refined from benchmarks) */
  recommendedParams: ParameterProfile;
  /** Whether benchmark history was used to refine the recommendation */
  refinedFromBenchmarks: boolean;
}

/** Configuration for the Agent Loop Controller */
export interface AgentLoopConfig {
  llmClient: AgentLLMClient;
  toolSystem: ToolSystem;
  projectDir: string;
  sessionId: string;
  maxIterations: number;
  planMode: boolean;
  turboEditsEnabled: boolean;
  smartContextEnabled: boolean;
  smartContextConfig?: SmartContextLoopConfig;
  /** Optional AutoTuner configuration for automatic parameter tuning (Req 16.1-16.4) */
  autoTunerConfig?: AutoTunerLoopConfig;
  /** Optional ExecutionTraceService for structured trace capture (Req 14.1) */
  executionTraceService?: ExecutionTraceService;
  /** Optional ArtifactService for auto-storing structured outputs (Req 1.1) */
  artifactService?: ArtifactService;
  /** Optional VisionAnalyzerService for screenshot analysis (Req 7.1, 7.5) */
  visionAnalyzer?: VisionAnalyzerService;
  /** Optional multimodal LLM client for vision fallback when ONNX unavailable (Req 7.5) */
  multimodalLLMClient?: MultimodalLLMClient;
  callbackEngine?: CallbackEngineEmitter;
  /** Optional IPC send function for communicating with the renderer process */
  ipcSend?: (channel: string, data: unknown) => void;
  /** Optional drift management configuration (all drift features are opt-in) */
  driftConfig?: DriftConfig;
  /** Optional Superagent configuration — enables feature gate system and subsystems (Req 0.1-0.6) */
  superagentConfig?: SuperagentConfig;
  onProgress?: (update: LoopProgress) => void;
  onPlanReady?: (plan: ExecutionPlan) => Promise<PlanApprovalResult>;
  /** Optional callback invoked when budget is exceeded — returns true to continue, false to stop (Req 1.4) */
  onBudgetExceeded?: (info: { sessionCostUsd: number; dailyCostUsd: number; limitUsd: number; message: string }) => Promise<boolean>;
  /** Minimum iterations before the loop can self-terminate. Default: 25 (Req 1.4) */
  minMaxIterations?: number;
  /** Enable action-first re-prompting when LLM produces text-only responses (Req 2.3, 2.5) */
  actionFirstEnabled?: boolean;
  /** Maximum re-prompt attempts for text-only responses before accepting. Default: 3 (Req 2.3) */
  maxRePromptAttempts?: number;
  /** Steering file content to prepend before instructions (Req 16.4) */
  steeringContent?: string;
  /** Power context appended to system prompt when a power is activated (Req 19.2, 19.4) */
  powerContext?: string;
  /** Code quality enforcement directives (Req 3.1–3.5). Uses defaults when omitted. */
  codeQualityDirectives?: CodeQualityDirectives;
  /** Action-first behavior directives (Req 2.1, 2.2, 2.4). Uses defaults when omitted. */
  actionFirstDirectives?: ActionFirstDirectives;
}

/** Progress update emitted on each iteration */
export interface LoopProgress {
  iteration: number;
  maxIterations: number;
  lastToolCall?: string;
  status: 'thinking' | 'tool_executing' | 'awaiting_approval' | 'complete';
  /** Auto-tuning information when available (emitted on first iteration) */
  autoTuning?: AutoTunerResult;
  /** Current drift confidence (only when drift is active) */
  driftConfidence?: number;
}

/** Result returned when the loop completes */
export interface AgentLoopResult {
  response: string;
  toolCallsExecuted: number;
  iterations: number;
  tokenUsage: TokenUsage;
  filesModified: string[];
  /** The auto-tuning result that was applied (if auto-tuning was active) */
  autoTuning?: AutoTunerResult;
  /** The execution trace ID if trace capture was active (Req 14.1) */
  traceId?: string;
  /** Artifact IDs of any auto-stored outputs (Req 1.1) */
  artifactIds?: string[];
  /** Final drift confidence score if drift was active */
  driftConfidence?: number;
  /** Count of drift signals emitted during execution */
  driftSignalCount?: number;
  /** Indicates the task was not fully completed (max iterations reached). (Req 1.3) */
  incomplete?: boolean;
  /** Summary of work performed when task is incomplete. (Req 1.3) */
  workSummary?: string;
}

/** OpenAI-compatible tool call structure in LLM responses */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Message format used within the agent loop conversation */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

/** Response from the LLM client that supports tool calling */
export interface AgentLLMResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** OpenAI-compatible function definition for tool registration */
export interface FunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * LLM client interface that supports tool calling (OpenAI function calling format).
 * This abstracts the underlying LLM provider to support tool_calls in responses.
 */
export interface AgentLLMClient {
  chatWithTools(
    messages: AgentMessage[],
    tools: FunctionDefinition[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<AgentLLMResponse>;
}

/**
 * Multimodal LLM client interface for vision fallback.
 * Used when the ONNX vision model is unavailable to analyze screenshots
 * by sending the raw image to a multimodal LLM provider.
 * Requirements: 7.5
 */
export interface MultimodalLLMClient {
  /** Analyze an image buffer with a text prompt and return the LLM's text response */
  analyzeImage(image: Buffer, prompt: string): Promise<string>;
}

// CallbackEngine is imported from ./callback-engine.ts
// Re-export for backward compatibility with tests that import it from here
export type { CallbackEngine } from './callback-engine.js';

// Re-export SystemPromptBuilder types for consumers
export { buildEnhancedSystemPrompt, DEFAULT_CODE_QUALITY_DIRECTIVES, DEFAULT_ACTION_FIRST_DIRECTIVES } from './system-prompt-builder.js';
export type { SystemPromptConfig, CodeQualityDirectives, ActionFirstDirectives } from './system-prompt-builder.js';

/**
 * Minimal interface for what the agent loop needs from a callback engine.
 * This allows passing the full CallbackEngine instance or a simple mock with just emit().
 */
export type CallbackEngineEmitter = Pick<CallbackEngine, 'emit'>;

// ─── Helper: Build OpenAI function definitions from ToolSystem ──

/**
 * Convert ToolSystem definitions to OpenAI-compatible function definitions.
 */
export function buildToolDefinitions(toolSystem: ToolSystem): FunctionDefinition[] {
  const tools = toolSystem.list();
  return tools.map((tool: ToolDefinition) => ({
    type: 'function' as const,
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

// ─── Helper: Build system prompt ────────────────────────────────

/**
 * Build the system prompt with project context and available tool descriptions.
 * Optionally prepends project-specific AI rules content and relevant file context.
 */
export function buildSystemPrompt(projectDir: string, tools: FunctionDefinition[], rulesContent?: string, relevantContext?: string): string {
  const toolDescriptions = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join('\n');

  const rulesSection = rulesContent ? `## Project Rules\n${rulesContent}\n\n` : '';
  const contextSection = relevantContext ? `## Relevant Context\n${relevantContext}\n\n` : '';

  return `${rulesSection}${contextSection}You are NeuroNest, an AI coding assistant with access to tools for reading, writing, and executing operations on the user's project.

## Project Directory
${projectDir}

## Available Tools
${toolDescriptions}

## Instructions
- ALWAYS use tools to accomplish the user's request. Do NOT just describe what you would do — actually do it by calling the available tools.
- Start by reading existing files to understand the project structure, then create/modify files as needed.
- When asked to build something, immediately begin creating files and running commands. Do not ask for permission or present a plan first.
- Read files before making edits to understand current state
- When a tool call fails, analyze the error and try an alternative approach
- Provide brief explanations of what you're doing between tool calls
- When you're done, provide a final summary of all changes made
- NEVER respond with only text when the user asked you to build, create, or implement something. Use your tools.`;
}

// ─── Helper: Build Plan Mode system prompt ──────────────────────

/**
 * Build the system prompt for Plan Mode, instructing the LLM to generate a plan
 * (describe tool calls) without executing them.
 */
export function buildPlanModeSystemPrompt(projectDir: string, tools: FunctionDefinition[], rulesContent?: string, relevantContext?: string): string {
  const toolDescriptions = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join('\n');

  const rulesSection = rulesContent ? `## Project Rules\n${rulesContent}\n\n` : '';
  const contextSection = relevantContext ? `## Relevant Context\n${relevantContext}\n\n` : '';

  return `${rulesSection}${contextSection}You are NeuroNest, an AI coding assistant operating in PLAN MODE.

## Project Directory
${projectDir}

## Available Tools
${toolDescriptions}

## Plan Mode Instructions
You are in Plan Mode. Instead of executing tool calls immediately, generate a plan by returning the tool calls you WOULD make. Each tool call in your response represents a planned step. The user will review and approve the plan before any execution occurs.

- Return all planned tool calls in a single response
- Each tool call represents one step of the plan
- Order the tool calls in the sequence they should be executed
- Include appropriate arguments for each tool call
- The user will approve, reject, or request modifications to the plan`;
}

// ─── Helper: Get project file index ─────────────────────────────

/** Directories to exclude when building the project file index */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__']);

/**
 * Recursively list all files in the project directory, excluding common ignored directories.
 * Returns relative paths from the project root.
 */
export async function getProjectFileIndex(projectDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true }) as unknown as import('fs').Dirent[];
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name as string)) continue;

      const fullPath = path.join(dir, entry.name as string);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = path.relative(projectDir, fullPath);
        files.push(relativePath);
      }
    }
  }

  await walk(projectDir);
  return files;
}

/**
 * Format SmartContextResult into a string suitable for injection into the system prompt.
 * Each file is presented with its path and content.
 */
export function formatSmartContextForPrompt(result: SmartContextResult): string {
  if (!result.selectedFiles || result.selectedFiles.length === 0) {
    return '';
  }

  const sections = result.selectedFiles.map((file) => {
    return `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``;
  });

  return sections.join('\n\n');
}

/**
 * Run Smart Context selection if enabled and configured.
 * Returns the formatted context string to inject into the system prompt, or empty string.
 */
export async function runSmartContextSelection(
  message: string,
  projectDir: string,
  smartContextEnabled: boolean,
  smartContextConfig?: SmartContextLoopConfig,
): Promise<string> {
  if (!smartContextEnabled || !smartContextConfig) {
    return '';
  }

  try {
    const fileIndex = await getProjectFileIndex(projectDir);
    if (fileIndex.length === 0) {
      return '';
    }

    const selector = new SmartContextSelector({
      projectDir,
      lightModel: smartContextConfig.lightModel,
      maxFiles: smartContextConfig.maxFiles,
      maxTokenBudget: smartContextConfig.maxTokenBudget,
    });

    const result = await selector.selectContext(message, fileIndex);
    return formatSmartContextForPrompt(result);
  } catch (error) {
    // Graceful degradation: if Smart Context fails, proceed without it
    console.error('[AgentLoop] Smart Context selection failed:', error);
    return '';
  }
}

// ─── Plan Validation Helpers ────────────────────────────────────

/**
 * Detect cycles in a directed graph of agent dependencies using DFS back-edge detection.
 * Returns an array of agent IDs that participate in cycles (deduplicated).
 *
 * Requirements: 2.3
 */
export function detectCycles(agents: AgentTask[]): string[] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const agentMap = new Map(agents.map(a => [a.id, a]));
  const cycleNodes: string[] = [];

  for (const agent of agents) color.set(agent.id, WHITE);

  function dfs(nodeId: string, path: string[]): boolean {
    color.set(nodeId, GRAY);
    path.push(nodeId);
    const node = agentMap.get(nodeId);
    if (node) {
      for (const dep of node.dependsOn) {
        if (color.get(dep) === GRAY) {
          // Back edge — cycle found
          const cycleStart = path.indexOf(dep);
          cycleNodes.push(...path.slice(cycleStart));
          return true;
        }
        if (color.get(dep) === WHITE) {
          if (dfs(dep, path)) return true;
        }
      }
    }
    path.pop();
    color.set(nodeId, BLACK);
    return false;
  }

  for (const agent of agents) {
    if (color.get(agent.id) === WHITE) {
      dfs(agent.id, []);
    }
  }
  return [...new Set(cycleNodes)];
}

/**
 * Check topology feasibility for an execution plan.
 * Returns null if feasible, or an object describing the issue.
 *
 * Topology constraints:
 * - 'star': requires exactly one root node (no dependencies), all others depend on the root
 * - 'sequential': requires a linear chain (each node has at most one dependency, and at most one dependent)
 * - Other topologies ('hierarchical', 'mesh', 'swarm'): always feasible
 *
 * Requirements: 2.4
 */
export function checkFeasibility(
  agents: AgentTask[],
  topology: string,
): { reason: string; affectedSteps: string[] } | null {
  if (agents.length === 0) {
    return { reason: 'Plan contains no agent tasks', affectedSteps: [] };
  }

  const roots = agents.filter(a => a.dependsOn.length === 0);

  if (topology === 'star') {
    // Star topology requires exactly one root node
    if (roots.length !== 1) {
      return {
        reason: `Star topology requires exactly one root node, but found ${roots.length}`,
        affectedSteps: roots.map(r => r.id),
      };
    }
    // All non-root nodes must depend on the root
    const rootId = roots[0].id;
    const nonRootAgents = agents.filter(a => a.id !== rootId);
    const invalidDeps = nonRootAgents.filter(
      a => a.dependsOn.length !== 1 || !a.dependsOn.includes(rootId),
    );
    if (invalidDeps.length > 0) {
      return {
        reason: `Star topology requires all non-root nodes to depend only on the root (${rootId})`,
        affectedSteps: invalidDeps.map(a => a.id),
      };
    }
  }

  if (topology === 'sequential') {
    // Sequential topology requires a linear chain
    if (roots.length !== 1) {
      return {
        reason: `Sequential topology requires exactly one root node, but found ${roots.length}`,
        affectedSteps: roots.map(r => r.id),
      };
    }

    // Each node can have at most one dependency
    const multiDep = agents.filter(a => a.dependsOn.length > 1);
    if (multiDep.length > 0) {
      return {
        reason: 'Sequential topology requires each node to have at most one dependency',
        affectedSteps: multiDep.map(a => a.id),
      };
    }

    // Each node can have at most one dependent (linear chain check)
    const dependentCount = new Map<string, number>();
    for (const agent of agents) {
      for (const dep of agent.dependsOn) {
        dependentCount.set(dep, (dependentCount.get(dep) || 0) + 1);
      }
    }
    const fanOut = [...dependentCount.entries()].filter(([, count]) => count > 1);
    if (fanOut.length > 0) {
      return {
        reason: 'Sequential topology requires a linear chain with no fan-out',
        affectedSteps: fanOut.map(([id]) => id),
      };
    }
  }

  // Capability matching: verify each agent's task references a valid capability
  // from the registry. We check that the agent exists (already validated upstream)
  // and that it belongs to a department that can execute work.
  for (const agent of agents) {
    const registryEntry = AGENT_REGISTRY.find(r => r.id === agent.id);
    if (registryEntry && !registryEntry.specialty) {
      return {
        reason: `Agent ${agent.id} has no declared specialty and cannot execute tasks`,
        affectedSteps: [agent.id],
      };
    }
  }

  return null;
}

// ─── Agent Loop Controller ──────────────────────────────────────

export class AgentLoopController {
  private config: AgentLoopConfig;
  /** Feature gate system — null when no superagentConfig is provided (zero-overhead path, Req 0.2, 0.6) */
  private featureGate: FeatureGateSystem | null = null;
  /** Cost tracking service — null when cost_tracking feature gate is disabled (Req 1.1, 1.6) */
  private costTrackingService: CostTrackingService | null = null;
  /** Checkpoint service — null when checkpoint feature gate is disabled (Req 2.1, 2.5, 2.6, 2.7) */
  private checkpointService: CheckpointService | null = null;
  /** Specialist role loader — null when specialist_roles feature gate is disabled (Req 15.1, 15.6) */
  private specialistRoleLoader: SpecialistRoleLoader | null = null;
  /** Vulnerability blocker — null when vulnerability_blocking feature gate is disabled (Req 3.1, 3.7) */
  private vulnerabilityBlocker: VulnerabilityBlocker | null = null;
  /** Supply chain detector — null when supply_chain_detection feature gate is disabled (Req 14.1, 14.6) */
  private supplyChainDetector: SupplyChainDetector | null = null;
  /** Dependency grounding service — null when dependency_grounding feature gate is disabled (Req 4.1, 4.6) */
  private dependencyGroundingService: DependencyGroundingService | null = null;
  /** Memory store — null when memory_persistence feature gate is disabled (Req 5.1, 5.7) */
  private memoryStore: MemoryStore | null = null;
  /** LSP bridge — null when lsp_intelligence feature gate is disabled (Req 6.1, 6.6) */
  private lspBridge: LSPBridge | null = null;
  /** Credential vault — null when credential_vault feature gate is disabled (Req 9.1, 9.7) */
  private credentialVault: CredentialVault | null = null;
  /** Model router — null when model_routing feature gate is disabled (Req 10.1, 10.6) */
  private modelRouter: ModelRouter | null = null;
  /** Behavioral rules engine — null when self_improvement feature gate is disabled (Req 11.1, 11.6) */
  private behavioralRulesEngine: BehavioralRulesEngine | null = null;
  /** Worktree isolation — null when worktree_isolation feature gate is disabled (Req 7.1, 7.6) */
  private worktreeIsolation: WorktreeIsolation | null = null;
  /** AST lock manager — null when ast_locking feature gate is disabled (Req 8.1, 8.7, 8.8) */
  private astLockManager: ASTLockManager | null = null;
  /** Provider failover — null when provider_failover feature gate is disabled (Req 17.1, 17.6) */
  private providerFailover: ProviderFailover | null = null;
  /** Parallel agent executor — null when parallel_agents feature gate is disabled (Req 13.1, 13.7) */
  private parallelAgentExecutor: ParallelAgentExecutor | null = null;
  /** Completion council — null when completion_council feature gate is disabled (Req 16.1, 16.6) */
  private completionCouncil: CompletionCouncil | null = null;
  /** Container sandbox — null when sandbox feature gate is disabled (Req 18.1, 18.7) */
  private containerSandbox: ContainerSandbox | null = null;
  /** Trace visualization service — null when trace_visualization feature gate is disabled (Req 12.1, 12.7) */
  private traceVisualizationService: TraceVisualizationService | null = null;
  /** Headless mode — null when headless_mode feature gate is disabled (Req 19.1, 19.6) */
  private headlessMode: typeof HeadlessMode | null = null;
  /** Scheduler service — null when scheduled_tasks feature gate is disabled (Req 22.1, 22.6) */
  private schedulerService: SchedulerService | null = null;
  /** Kanban state manager — null when kanban_board feature gate is disabled (Req 25.1, 25.6) */
  private kanbanStateManager: KanbanStateManager | null = null;
  /** Provenance tracker — null when provenance_tracking feature gate is disabled (Req 20.1, 20.6) */
  private provenanceTracker: ProvenanceTracker | null = null;
  /** Skill extractor — null when skill_creation feature gate is disabled (Req 21.1, 21.6) */
  private skillExtractor: SkillExtractor | null = null;
  /** Remote access bridge — null when remote_access feature gate is disabled (Req 23.1, 23.6) */
  private remoteAccessBridge: RemoteAccessBridge | null = null;
  /** Voice IO service — null when voice_io feature gate is disabled (Req 24.1, 24.6) */
  private voiceIOService: VoiceIOService | null = null;
  /** Repo readiness scanner — null when repo_readiness feature gate is disabled (Req 26.1, 26.6) */
  private repoReadinessScanner: RepoReadinessScanner | null = null;
  /** Compliance gate runner — null when compliance_gates feature gate is disabled (Req 27.1, 27.6) */
  private complianceGateRunner: ComplianceGateRunner | null = null;
  /** WASM sandbox — null when wasm_sandbox feature gate is disabled (Req 28.1, 28.6) */
  private wasmSandbox: WasmSandbox | null = null;
  /** Browser automation — null when browser_automation feature gate is disabled (Req 29.1, 29.6) */
  private browserAutomation: BrowserAutomation | null = null;
  /** Backpropagation engine — null when backpropagation feature gate is disabled (Req 30.1, 30.6) */
  private backpropagationEngine: BackpropagationEngine | null = null;

  constructor(config: AgentLoopConfig) {
    this.config = {
      ...config,
      maxIterations: config.maxIterations ?? config.minMaxIterations ?? 25,
      minMaxIterations: config.minMaxIterations ?? 25,
    };

    // ─── Feature Gate: instantiate only when superagentConfig is present (Req 0.2, 0.6) ───
    // When superagentConfig is absent, featureGate remains null and all gate checks
    // short-circuit via null-check with zero overhead.
    if (config.superagentConfig) {
      try {
        this.featureGate = new FeatureGateSystem(config.superagentConfig.flags ?? {});
        this.featureGate.resolve();
      } catch (err) {
        // If configuration resolution fails (invalid combos), log and leave gate null
        // This preserves backward compatibility — the loop operates without gates
        console.error('[FeatureGate] Configuration resolution failed:', err);
        this.featureGate = null;
      }
    }

    // ─── Cost Tracking: instantiate when cost_tracking feature gate is enabled (Req 1.1, 1.6) ───
    if (this.isFeatureEnabled('cost_tracking')) {
      const costConfig = config.superagentConfig?.costTracking;
      this.costTrackingService = new CostTrackingService(
        costConfig?.pricingTablePath ?? null,
        {
          sessionLimitUsd: costConfig?.sessionLimitUsd ?? 10.0,
          dailyLimitUsd: costConfig?.dailyLimitUsd ?? 50.0,
          warningThreshold: costConfig?.warningThreshold ?? 0.8,
        },
        (config.callbackEngine as import('../pipeline/callback-engine.js').CallbackEngine) ?? null,
        config.executionTraceService ?? null,
      );
    }

    // ─── Checkpoint: instantiate when checkpoint feature gate is enabled (Req 2.1, 2.5, 2.6, 2.7) ───
    if (this.isFeatureEnabled('checkpoint')) {
      const ckptConfig = config.superagentConfig?.checkpoint;
      this.checkpointService = new CheckpointService({
        directory: ckptConfig?.directory ?? '.neuronest/checkpoints',
        maxDiskUsageMb: ckptConfig?.maxDiskUsageMb ?? 500,
        currentSchemaVersion: 3,
      });
    }

    // ─── Specialist Roles: instantiate when specialist_roles feature gate is enabled (Req 15.1, 15.4, 15.6) ───
    if (this.isFeatureEnabled('specialist_roles')) {
      const rolesConfig = config.superagentConfig?.specialistRoles;
      const customRoles = rolesConfig?.customRoles ?? [];
      this.specialistRoleLoader = new SpecialistRoleLoader(customRoles);
    }

    // ─── Vulnerability Blocker: instantiate when vulnerability_blocking feature gate is enabled (Req 3.1, 3.7) ───
    if (this.isFeatureEnabled('vulnerability_blocking')) {
      const vulnConfig = config.superagentConfig?.vulnerabilityBlocking;
      const vulnBlockerOptions: import('../security/vulnerability-blocker.js').VulnBlockerConfig = {
        primaryApiUrl: 'https://api.osv.dev/v1/query',
        cacheTtlHours: vulnConfig?.cacheTtlHours ?? 24,
        cacheDir: path.join(config.projectDir, '.neuronest', 'vuln-cache'),
      };
      if (vulnConfig?.fallbackDatabaseUrl) {
        vulnBlockerOptions.fallbackApiUrl = vulnConfig.fallbackDatabaseUrl;
      }
      this.vulnerabilityBlocker = new VulnerabilityBlocker(vulnBlockerOptions);
    }

    // ─── Supply Chain Detector: instantiate when supply_chain_detection feature gate is enabled (Req 14.1, 14.6) ───
    if (this.isFeatureEnabled('supply_chain_detection')) {
      this.supplyChainDetector = new SupplyChainDetector({
        allowlistPath: path.join(config.projectDir, '.neuronest', 'package-allowlist.json'),
        popularPackagesPath: path.join(config.projectDir, '.neuronest', 'popular-packages.json'),
        editDistanceThreshold: 2,
      });
    }

    // ─── Dependency Grounding: instantiate when dependency_grounding feature gate is enabled (Req 4.1, 4.6) ───
    if (this.isFeatureEnabled('dependency_grounding')) {
      const groundingConfig = config.superagentConfig?.dependencyGrounding;
      this.dependencyGroundingService = new DependencyGroundingService({
        cacheDir: path.join(config.projectDir, '.neuronest', 'doc-cache'),
        cacheTtlDays: groundingConfig?.cacheTtlDays ?? 7,
        maxCacheSizeMb: groundingConfig?.maxCacheSizeMb ?? 200,
      });
    }

    // ─── Memory Store: instantiate when memory_persistence feature gate is enabled (Req 5.1, 5.7) ───
    if (this.isFeatureEnabled('memory_persistence')) {
      const memConfig = config.superagentConfig?.memoryPersistence;
      this.memoryStore = new MemoryStore({
        directory: memConfig?.directory ?? path.join(config.projectDir, '.neuronest', 'memory'),
        maxFileSizeKb: memConfig?.maxFileSizeKb ?? 50,
        totalBudgetMb: memConfig?.totalDiskBudgetMb ?? 10,
      });
    }

    // ─── LSP Bridge: instantiate when lsp_intelligence feature gate is enabled (Req 6.1, 6.6) ───
    if (this.isFeatureEnabled('lsp_intelligence')) {
      this.lspBridge = new LSPBridge(config.projectDir);
    }

    // ─── Credential Vault: instantiate when credential_vault feature gate is enabled (Req 9.1, 9.7) ───
    if (this.isFeatureEnabled('credential_vault')) {
      const vaultConfig = config.superagentConfig?.credentialVault;
      this.credentialVault = new CredentialVault({
        storePath: path.join(config.projectDir, '.neuronest', 'vault'),
        keyDerivation: vaultConfig?.keySource ?? 'os-keychain',
        encryption: 'aes-256-gcm',
      });
    }

    // ─── Model Router: instantiate when model_routing feature gate is enabled (Req 10.1, 10.6) ───
    if (this.isFeatureEnabled('model_routing')) {
      const routingConfig = config.superagentConfig?.modelRouting;
      type RT = import('../routing/model-router.js').RoutingTable;
      type RTE = import('../routing/model-router.js').RoutingTableEntry;
      const entries: RTE[] = [];
      // Build routing table from user config if available
      if (routingConfig?.routingTable) {
        for (const [taskType, providers] of Object.entries(routingConfig.routingTable)) {
          entries.push({
            taskType: taskType as import('../routing/model-router.js').TaskType,
            providers: providers.map((p, idx) => ({
              providerId: p.provider,
              model: p.model,
              priority: idx,
            })),
          });
        }
      }
      const defaultTable: RT = {
        entries,
        defaultProvider: { providerId: 'default', model: 'default' },
      };
      this.modelRouter = new ModelRouter(defaultTable);
    }

    // ─── Behavioral Rules Engine: instantiate when self_improvement feature gate is enabled (Req 11.1, 11.6) ───
    if (this.isFeatureEnabled('self_improvement')) {
      const rulesConfig = config.superagentConfig?.selfImprovement;
      this.behavioralRulesEngine = new BehavioralRulesEngine(
        rulesConfig?.rulesFilePath ?? path.join(config.projectDir, '.neuronest', 'behavioral-rules.md'),
        config.executionTraceService ?? null,
      );
    }

    // ─── Worktree Isolation: instantiate when worktree_isolation feature gate is enabled (Req 7.1, 7.6) ───
    if (this.isFeatureEnabled('worktree_isolation')) {
      this.worktreeIsolation = new WorktreeIsolation(config.projectDir);
    }

    // ─── AST Lock Manager: instantiate when ast_locking feature gate is enabled (Req 8.1, 8.7, 8.8) ───
    if (this.isFeatureEnabled('ast_locking')) {
      const lockConfig = config.superagentConfig?.astLocking;
      const parallelEnabled = this.isFeatureEnabled('parallel_agents') || this.isFeatureEnabled('worktree_isolation');
      this.astLockManager = new ASTLockManager(
        (lockConfig?.lockTimeoutSeconds ?? 300) * 1000,
        parallelEnabled,
      );
    }

    // ─── Provider Failover: instantiate when provider_failover feature gate is enabled (Req 17.1, 17.6) ───
    if (this.isFeatureEnabled('provider_failover')) {
      const failoverConfig = config.superagentConfig?.providerFailover;
      this.providerFailover = new ProviderFailover(
        {
          initialBackoffMs: failoverConfig?.initialBackoffMs ?? 1000,
          maxBackoffMs: failoverConfig?.maxBackoffMs ?? 30000,
          backoffFactor: failoverConfig?.backoffFactor ?? 2,
        },
        (config.callbackEngine as import('../pipeline/callback-engine.js').CallbackEngine) ?? null,
        this.modelRouter,
      );
    }

    // ─── Parallel Agent Executor: instantiate when parallel_agents feature gate is enabled (Req 13.1, 13.7) ───
    if (this.isFeatureEnabled('parallel_agents') && this.worktreeIsolation) {
      const parallelConfig = config.superagentConfig?.parallelAgents;
      this.parallelAgentExecutor = new ParallelAgentExecutor(
        this.worktreeIsolation,
        this.astLockManager,
        parallelConfig?.maxConcurrent ?? 4,
      );
    }

    // ─── Completion Council: instantiate when completion_council feature gate is enabled (Req 16.1, 16.6) ───
    if (this.isFeatureEnabled('completion_council')) {
      this.completionCouncil = new CompletionCouncil(
        this.specialistRoleLoader,
      );
    }

    // ─── Container Sandbox: instantiate when sandbox feature gate is enabled (Req 18.1, 18.7) ───
    if (this.isFeatureEnabled('sandbox')) {
      const sandboxConfig = config.superagentConfig?.sandbox;
      this.containerSandbox = new ContainerSandbox({
        cpuTimeMs: sandboxConfig?.cpuLimitMs ?? 30000,
        memoryMb: sandboxConfig?.memoryLimitMb ?? 512,
        diskMb: sandboxConfig?.diskLimitMb ?? 100,
        networkPolicy: sandboxConfig?.networkPolicy === 'allowlist'
          ? { allowlist: sandboxConfig?.allowedDomains ?? [] }
          : 'deny-all',
      });
    }

    // ─── Trace Visualization: instantiate when trace_visualization feature gate is enabled (Req 12.1, 12.7) ───
    // Note: TraceVisualizationService requires a database instance — deferred to runtime
    // when the ExecutionTraceService's DB is accessible. The field remains null until
    // initialized via initTraceVisualization().

    // ─── Headless Mode: reference available when headless_mode feature gate is enabled (Req 19.1, 19.6) ───
    if (this.isFeatureEnabled('headless_mode')) {
      this.headlessMode = HeadlessMode;
    }

    // ─── Kanban State Manager: instantiate when kanban_board feature gate is enabled (Req 25.1, 25.6) ───
    if (this.isFeatureEnabled('kanban_board')) {
      this.kanbanStateManager = new KanbanStateManager(
        { completionCouncilEnabled: this.isFeatureEnabled('completion_council') },
        config.ipcSend ?? undefined,
      );
    }
  }

  /**
   * Check if a feature is enabled. Returns false when featureGate is null (zero-overhead path).
   * This is the single guard method used by all subsystem integrations.
   */
  isFeatureEnabled(feature: keyof FeatureGateFlags): boolean {
    return this.featureGate !== null && this.featureGate.isEnabled(feature);
  }

  /**
   * Execute a feature-gated subsystem action with graceful degradation.
   * If the action throws, the feature is disabled at runtime and the error is logged.
   * The loop continues normal operation (Req 0.4).
   *
   * @param feature - The feature flag to check and potentially disable on error
   * @param action - The async action to execute if the feature is enabled
   * @param context - Optional context string for logging
   * @returns The result of the action, or undefined if the feature is disabled or errored
   */
  async executeFeatureGuarded<T>(
    feature: keyof FeatureGateFlags,
    action: () => T | Promise<T>,
    context?: string,
  ): Promise<T | undefined> {
    // Null-check short-circuit: zero overhead when gate is null or feature disabled
    if (!this.featureGate || !this.featureGate.isEnabled(feature)) {
      return undefined;
    }

    try {
      return await action();
    } catch (err) {
      // Graceful degradation: disable feature, log, continue (Req 0.4)
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.featureGate.disableAtRuntime(feature, errorMessage);
      console.error(
        `[FeatureGate] Subsystem '${feature}' disabled due to unhandled error${context ? ` (${context})` : ''}: ${errorMessage}`,
      );
      return undefined;
    }
  }

  /**
   * Get the underlying FeatureGateSystem instance (for subsystem initialization).
   * Returns null when no superagentConfig was provided.
   */
  getFeatureGate(): FeatureGateSystem | null {
    return this.featureGate;
  }

  /**
   * Get the CostTrackingService instance (for external integration/testing).
   * Returns null when cost_tracking feature gate is disabled (Req 1.6).
   */
  getCostTrackingService(): CostTrackingService | null {
    return this.costTrackingService;
  }

  /**
   * Get the CheckpointService instance (for external integration/testing).
   * Returns null when checkpoint feature gate is disabled (Req 2.7).
   */
  getCheckpointService(): CheckpointService | null {
    return this.checkpointService;
  }

  /**
   * Get the SpecialistRoleLoader instance (for external integration/testing).
   * Returns null when specialist_roles feature gate is disabled (Req 15.6).
   */
  getSpecialistRoleLoader(): SpecialistRoleLoader | null {
    return this.specialistRoleLoader;
  }

  /**
   * Get the VulnerabilityBlocker instance (for ToolSystem interceptor integration).
   * Returns null when vulnerability_blocking feature gate is disabled (Req 3.7).
   */
  getVulnerabilityBlocker(): VulnerabilityBlocker | null {
    return this.vulnerabilityBlocker;
  }

  /**
   * Get the SupplyChainDetector instance (for ToolSystem interceptor integration).
   * Returns null when supply_chain_detection feature gate is disabled (Req 14.6).
   */
  getSupplyChainDetector(): SupplyChainDetector | null {
    return this.supplyChainDetector;
  }

  /**
   * Get the DependencyGroundingService instance.
   * Returns null when dependency_grounding feature gate is disabled (Req 4.6).
   */
  getDependencyGroundingService(): DependencyGroundingService | null {
    return this.dependencyGroundingService;
  }

  /**
   * Get the MemoryStore instance.
   * Returns null when memory_persistence feature gate is disabled (Req 5.7).
   */
  getMemoryStore(): MemoryStore | null {
    return this.memoryStore;
  }

  /**
   * Get the LSPBridge instance.
   * Returns null when lsp_intelligence feature gate is disabled (Req 6.6).
   */
  getLSPBridge(): LSPBridge | null {
    return this.lspBridge;
  }

  /**
   * Get the CredentialVault instance.
   * Returns null when credential_vault feature gate is disabled (Req 9.7).
   */
  getCredentialVault(): CredentialVault | null {
    return this.credentialVault;
  }

  /**
   * Get the ModelRouter instance.
   * Returns null when model_routing feature gate is disabled (Req 10.6).
   */
  getModelRouter(): ModelRouter | null {
    return this.modelRouter;
  }

  /**
   * Get the BehavioralRulesEngine instance.
   * Returns null when self_improvement feature gate is disabled (Req 11.6).
   */
  getBehavioralRulesEngine(): BehavioralRulesEngine | null {
    return this.behavioralRulesEngine;
  }

  /**
   * Get the WorktreeIsolation instance.
   * Returns null when worktree_isolation feature gate is disabled (Req 7.6).
   */
  getWorktreeIsolation(): WorktreeIsolation | null {
    return this.worktreeIsolation;
  }

  /**
   * Get the ASTLockManager instance.
   * Returns null when ast_locking feature gate is disabled (Req 8.7).
   */
  getASTLockManager(): ASTLockManager | null {
    return this.astLockManager;
  }

  /**
   * Get the ProviderFailover instance.
   * Returns null when provider_failover feature gate is disabled (Req 17.6).
   */
  getProviderFailover(): ProviderFailover | null {
    return this.providerFailover;
  }

  /**
   * Get the ParallelAgentExecutor instance.
   * Returns null when parallel_agents feature gate is disabled (Req 13.7).
   */
  getParallelAgentExecutor(): ParallelAgentExecutor | null {
    return this.parallelAgentExecutor;
  }

  /**
   * Get the CompletionCouncil instance.
   * Returns null when completion_council feature gate is disabled (Req 16.6).
   */
  getCompletionCouncil(): CompletionCouncil | null {
    return this.completionCouncil;
  }

  /**
   * Get the ContainerSandbox instance.
   * Returns null when sandbox feature gate is disabled (Req 18.7).
   */
  getContainerSandbox(): ContainerSandbox | null {
    return this.containerSandbox;
  }

  /**
   * Get the TraceVisualizationService instance.
   * Returns null when trace_visualization feature gate is disabled (Req 12.7).
   */
  getTraceVisualizationService(): TraceVisualizationService | null {
    return this.traceVisualizationService;
  }

  /**
   * Get the HeadlessMode class reference.
   * Returns null when headless_mode feature gate is disabled (Req 19.6).
   */
  getHeadlessMode(): typeof HeadlessMode | null {
    return this.headlessMode;
  }

  /**
   * Get the SchedulerService instance.
   * Returns null when scheduled_tasks feature gate is disabled (Req 22.6).
   */
  getSchedulerService(): SchedulerService | null {
    return this.schedulerService;
  }

  /**
   * Get the KanbanStateManager instance.
   * Returns null when kanban_board feature gate is disabled (Req 25.6).
   */
  getKanbanStateManager(): KanbanStateManager | null {
    return this.kanbanStateManager;
  }

  /**
   * Get the ProvenanceTracker instance.
   * Returns null when provenance_tracking feature gate is disabled (Req 20.6).
   */
  getProvenanceTracker(): ProvenanceTracker | null {
    return this.provenanceTracker;
  }

  /**
   * Get the SkillExtractor instance.
   * Returns null when skill_creation feature gate is disabled (Req 21.6).
   */
  getSkillExtractor(): SkillExtractor | null {
    return this.skillExtractor;
  }

  /**
   * Get the RemoteAccessBridge instance.
   * Returns null when remote_access feature gate is disabled (Req 23.6).
   */
  getRemoteAccessBridge(): RemoteAccessBridge | null {
    return this.remoteAccessBridge;
  }

  /**
   * Get the VoiceIOService instance.
   * Returns null when voice_io feature gate is disabled (Req 24.6).
   */
  getVoiceIOService(): VoiceIOService | null {
    return this.voiceIOService;
  }

  /**
   * Get the RepoReadinessScanner instance.
   * Returns null when repo_readiness feature gate is disabled (Req 26.6).
   */
  getRepoReadinessScanner(): RepoReadinessScanner | null {
    return this.repoReadinessScanner;
  }

  /**
   * Get the ComplianceGateRunner instance.
   * Returns null when compliance_gates feature gate is disabled (Req 27.6).
   */
  getComplianceGateRunner(): ComplianceGateRunner | null {
    return this.complianceGateRunner;
  }

  /**
   * Get the WasmSandbox instance.
   * Returns null when wasm_sandbox feature gate is disabled (Req 28.6).
   */
  getWasmSandbox(): WasmSandbox | null {
    return this.wasmSandbox;
  }

  /**
   * Get the BrowserAutomation instance.
   * Returns null when browser_automation feature gate is disabled (Req 29.6).
   */
  getBrowserAutomation(): BrowserAutomation | null {
    return this.browserAutomation;
  }

  /**
   * Get the BackpropagationEngine instance.
   * Returns null when backpropagation feature gate is disabled (Req 30.6).
   */
  getBackpropagationEngine(): BackpropagationEngine | null {
    return this.backpropagationEngine;
  }

  // ─── Plan Validation ──────────────────────────────────────────

  /**
   * Validate an execution plan before swarm dispatch.
   * Lightweight synchronous check — no LLM calls, no I/O.
   * Must complete within 500ms for plans up to 20 tasks.
   *
   * Performs three checks:
   * 1. Agent ID validation against AGENT_REGISTRY
   * 2. Cycle detection via DFS back-edge detection on dependsOn edges
   * 3. Topology feasibility check
   *
   * Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
   */
  validatePlan(plan: OrchestratorPlan): PlanValidationResult {
    // 1. Validate agent IDs — every AgentTask.id must exist in AGENT_REGISTRY
    const invalidAgents = plan.agents
      .filter(a => !AGENT_REGISTRY.find(r => r.id === a.id))
      .map(a => a.id);
    if (invalidAgents.length > 0) {
      return {
        status: 'rejected',
        reason: `Invalid agent IDs: ${invalidAgents.join(', ')}`,
        affectedSteps: invalidAgents,
      };
    }

    // 2. Detect cycles in dependency graph
    const cycleNodes = detectCycles(plan.agents);
    if (cycleNodes.length > 0) {
      return {
        status: 'rejected',
        reason: `Dependency cycle detected among: ${cycleNodes.join(' → ')}`,
        affectedSteps: cycleNodes,
      };
    }

    // 3. Feasibility check — topology constraints and capability matching
    const feasibilityIssue = checkFeasibility(plan.agents, plan.topology);
    if (feasibilityIssue) {
      return {
        status: 'rejected',
        reason: feasibilityIssue.reason,
        affectedSteps: feasibilityIssue.affectedSteps,
      };
    }

    return { status: 'approved', plan };
  }

  /**
   * Gracefully suspend (sleep) the agent session by writing a final checkpoint.
   * Persists the full agent state including conversation history, plan progress,
   * file changes, and iteration count so the session can be resumed later.
   *
   * Returns the checkpoint file path if successful, null if checkpoint is disabled or fails.
   *
   * Requirements: 2.5, 2.6
   */
  async suspend(state: {
    conversationHistory: AgentMessage[];
    planProgress: { completedSteps: number[]; pendingSteps: number[] };
    filesModified: string[];
    iterationCount: number;
  }): Promise<string | null> {
    if (!this.checkpointService || !this.isFeatureEnabled('checkpoint')) {
      return null;
    }

    const result = await this.executeFeatureGuarded('checkpoint', async () => {
      const data: CheckpointData = {
        schemaVersion: 3,
        sessionId: this.config.sessionId,
        timestamp: new Date().toISOString(),
        conversationHistory: state.conversationHistory,
        planProgress: state.planProgress,
        fileChangeManifest: state.filesModified,
        iterationCount: state.iterationCount,
        customState: { suspended: true },
      };
      const filePath = await this.checkpointService!.save(data);
      await this.checkpointService!.enforceQuota();
      return filePath;
    }, 'checkpoint-suspend');

    return result ?? null;
  }

  /**
   * Resume (wake) a previously suspended session by loading the latest checkpoint.
   * Restores conversation history, plan progress, file changes, and iteration count
   * so execution can continue from the next pending step.
   *
   * Returns the restored checkpoint data if successful, null if not found or disabled.
   *
   * Requirements: 2.2, 2.6
   */
  async resume(sessionId: string): Promise<{
    conversationHistory: unknown[];
    planProgress: { completedSteps: number[]; pendingSteps: number[] };
    filesModified: string[];
    iterationCount: number;
  } | null> {
    if (!this.checkpointService || !this.isFeatureEnabled('checkpoint')) {
      return null;
    }

    const result = await this.executeFeatureGuarded('checkpoint', async () => {
      const data = await this.checkpointService!.restore(sessionId);
      if (!data) {
        return null;
      }
      return {
        conversationHistory: data.conversationHistory,
        planProgress: data.planProgress,
        filesModified: data.fileChangeManifest,
        iterationCount: data.iterationCount,
      };
    }, 'checkpoint-resume');

    return result ?? null;
  }

  /**
   * Run the agent loop for a given user message.
   * If planMode is enabled, uses a two-pass approach:
   * 1. First pass: LLM generates a plan (tool calls described but not executed)
   * 2. Plan sent to user for approval via onPlanReady callback
   * 3. On approval: execute plan steps sequentially
   * 4. On rejection: return rejection message
   * 5. On modification: regenerate plan with user feedback
   *
   * Otherwise iterates until the LLM produces a final response with no tool calls,
   * or maxIterations is reached.
   */
  async run(message: string): Promise<AgentLoopResult> {
    const { planMode, onPlanReady } = this.config;

    if (planMode && onPlanReady) {
      return this.runPlanMode(message);
    }

    return this.runStandardLoop(message);
  }

  /**
   * Plan Mode: Two-pass approach.
   * First pass generates a plan from LLM tool calls, sends to user for approval,
   * then executes or regenerates based on user response.
   */
  private async runPlanMode(message: string): Promise<AgentLoopResult> {
    const { llmClient, toolSystem, projectDir, sessionId, maxIterations, smartContextEnabled, smartContextConfig, callbackEngine, onProgress, onPlanReady } = this.config;

    const toolDefs = buildToolDefinitions(toolSystem);
    const aiRules = loadAIRules(projectDir);
    const rulesContent = aiRules?.content ?? undefined;

    // ─── AutoTuner: classify task and resolve parameters (Req 16.1-16.4) ───
    const autoTuningResult = await this.resolveAutoTuning(message);
    const llmOptions = autoTuningResult
      ? { temperature: autoTuningResult.recommendedParams.temperature, maxTokens: autoTuningResult.recommendedParams.maxTokens }
      : undefined;

    // Run Smart Context selection if enabled (requirement 11.3)
    const relevantContext = await runSmartContextSelection(message, projectDir, smartContextEnabled, smartContextConfig);

    const systemPrompt = buildPlanModeSystemPrompt(projectDir, toolDefs, rulesContent, relevantContext || undefined);

    // Initialize conversation
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];

    const tokenUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    // Allow up to 3 plan regeneration attempts (initial + 2 modifications)
    const maxPlanAttempts = 3;
    let planAttempt = 0;

    while (planAttempt < maxPlanAttempts) {
      planAttempt++;

      // Emit progress: thinking (generating plan)
      onProgress?.({
        iteration: planAttempt,
        maxIterations,
        status: 'thinking',
      });

      // First pass: ask LLM to generate a plan
      let response: AgentLLMResponse;
      try {
        if (callbackEngine) {
          await callbackEngine.emit({ event: 'before-llm-call', sessionId, iteration: planAttempt });
        }

        response = await llmClient.chatWithTools(messages, toolDefs, llmOptions);

        if (callbackEngine) {
          await callbackEngine.emit({ event: 'after-llm-call', sessionId, iteration: planAttempt, output: response });
        }
      } catch (error) {
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'on-error',
            error: error instanceof Error ? error : new Error(String(error)),
            sessionId,
            iteration: planAttempt,
          });
        }
        return {
          response: `Error calling LLM: ${error instanceof Error ? error.message : String(error)}`,
          toolCallsExecuted: 0,
          iterations: planAttempt,
          tokenUsage,
          filesModified: [],
        };
      }

      // Accumulate token usage
      if (response.usage) {
        tokenUsage.promptTokens += response.usage.promptTokens;
        tokenUsage.completionTokens += response.usage.completionTokens;
        tokenUsage.totalTokens += response.usage.totalTokens;
      }

      // Parse plan from LLM response (tool_calls represent planned steps)
      const plan = this.buildPlanFromResponse(response);

      if (plan.steps.length === 0) {
        // LLM didn't produce tool calls — return the response directly
        onProgress?.({ iteration: planAttempt, maxIterations, status: 'complete' });
        return {
          response: response.content || 'No plan generated — the task may not require tool calls.',
          toolCallsExecuted: 0,
          iterations: planAttempt,
          tokenUsage,
          filesModified: [],
        };
      }

      // Send plan to user for approval
      onProgress?.({
        iteration: planAttempt,
        maxIterations,
        status: 'awaiting_approval',
      });

      const approval = await onPlanReady!(plan);

      if (approval === 'approved') {
        // Execute the plan steps sequentially using the normal loop
        plan.status = 'approved';
        return this.executePlan(plan, message, tokenUsage, planAttempt);
      } else if (approval === 'rejected') {
        // Return rejection message
        plan.status = 'rejected';
        onProgress?.({ iteration: planAttempt, maxIterations, status: 'complete' });

        if (callbackEngine) {
          await callbackEngine.emit({ event: 'on-task-complete', sessionId, iteration: planAttempt });
        }

        return {
          response: 'Plan rejected. Please provide guidance on how you would like to proceed.',
          toolCallsExecuted: 0,
          iterations: planAttempt,
          tokenUsage,
          filesModified: [],
        };
      } else {
        // Modification requested: regenerate with feedback
        plan.status = 'modified';
        const feedback = approval.feedback;
        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.tool_calls,
        });
        messages.push({
          role: 'user',
          content: `The plan was not approved. Please revise the plan based on this feedback: ${feedback}`,
        });
        // Continue loop to regenerate
      }
    }

    // Exhausted plan attempts
    onProgress?.({ iteration: planAttempt, maxIterations, status: 'complete' });
    return {
      response: 'Unable to produce an approved plan after multiple attempts. Please try rephrasing your request.',
      toolCallsExecuted: 0,
      iterations: planAttempt,
      tokenUsage,
      filesModified: [],
    };
  }

  /**
   * Build an ExecutionPlan from the LLM response's tool_calls.
   */
  private buildPlanFromResponse(response: AgentLLMResponse): ExecutionPlan {
    const steps: PlanStep[] = (response.tool_calls || []).map((tc, idx) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = { _raw: tc.function.arguments };
      }

      return {
        order: idx + 1,
        description: `Call ${tc.function.name}`,
        toolId: tc.function.name,
        estimatedInput: parsedArgs,
      };
    });

    // Extract affected files from tool inputs
    const filesAffected: string[] = [];
    for (const step of steps) {
      const filePath = step.estimatedInput?.path;
      if (typeof filePath === 'string' && !filesAffected.includes(filePath)) {
        filesAffected.push(filePath);
      }
    }

    return {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      steps,
      estimatedToolCalls: steps.length,
      filesAffected,
      status: 'pending',
    };
  }

  /**
   * Execute an approved plan by running each step through the ToolSystem.
   */
  private async executePlan(
    plan: ExecutionPlan,
    originalMessage: string,
    accumulatedTokenUsage: TokenUsage,
    startIteration: number,
  ): Promise<AgentLoopResult> {
    const { llmClient, toolSystem, projectDir, sessionId, maxIterations, callbackEngine, onProgress } = this.config;

    const toolDefs = buildToolDefinitions(toolSystem);
    const filesModified: string[] = [];
    let toolCallsExecuted = 0;
    let iteration = startIteration;

    // Build context for LLM after execution
    const aiRules = loadAIRules(projectDir);
    const rulesContent = aiRules?.content ?? undefined;
    const systemPrompt = buildSystemPrompt(projectDir, toolDefs, rulesContent);
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: originalMessage },
    ];

    // Execute each plan step
    for (const step of plan.steps) {
      iteration++;
      onProgress?.({
        iteration,
        maxIterations,
        lastToolCall: step.toolId,
        status: 'tool_executing',
      });

      const toolContext: ToolContext = {
        agentId: 'agent-loop',
        sessionId,
        projectDir,
        permissionMode: 'auto-approve',
      };

      if (callbackEngine) {
        await callbackEngine.emit({
          event: 'before-tool-call',
          toolName: step.toolId,
          input: step.estimatedInput,
          sessionId,
          iteration,
        });
      }

      let toolResult: ToolResult;
      try {
        toolResult = await toolSystem.execute(step.toolId, step.estimatedInput, toolContext);
      } catch (error) {
        toolResult = {
          success: false,
          output: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (callbackEngine) {
        await callbackEngine.emit({
          event: 'after-tool-call',
          toolName: step.toolId,
          input: step.estimatedInput,
          output: toolResult,
          error: toolResult.success ? undefined : new Error(toolResult.error || 'Tool failed'),
          sessionId,
          iteration,
        });
      }

      // Track file modifications
      if (toolResult.success && (step.toolId === 'file-write' || step.toolId === 'file-edit')) {
        const filePath = step.estimatedInput?.path;
        if (typeof filePath === 'string' && !filesModified.includes(filePath)) {
          filesModified.push(filePath);
        }
      }

      // Append tool call and result to messages for final summary
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: `plan_call_${step.order}`,
          type: 'function',
          function: {
            name: step.toolId,
            arguments: JSON.stringify(step.estimatedInput),
          },
        }],
      });
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          success: toolResult.success,
          output: toolResult.output,
          ...(toolResult.error ? { error: toolResult.error } : {}),
        }),
        tool_call_id: `plan_call_${step.order}`,
      });

      toolCallsExecuted++;
    }

    // Final LLM call to generate summary
    iteration++;
    onProgress?.({ iteration, maxIterations, status: 'thinking' });

    let finalResponse: string;
    try {
      if (callbackEngine) {
        await callbackEngine.emit({ event: 'before-llm-call', sessionId, iteration });
      }

      const summaryResponse = await llmClient.chatWithTools(messages, toolDefs);

      if (callbackEngine) {
        await callbackEngine.emit({ event: 'after-llm-call', sessionId, iteration, output: summaryResponse });
      }

      if (summaryResponse.usage) {
        accumulatedTokenUsage.promptTokens += summaryResponse.usage.promptTokens;
        accumulatedTokenUsage.completionTokens += summaryResponse.usage.completionTokens;
        accumulatedTokenUsage.totalTokens += summaryResponse.usage.totalTokens;
      }

      finalResponse = summaryResponse.content || 'Plan executed successfully.';
    } catch {
      finalResponse = 'Plan steps executed successfully but failed to generate summary.';
    }

    onProgress?.({ iteration, maxIterations, status: 'complete' });

    if (callbackEngine) {
      await callbackEngine.emit({ event: 'on-task-complete', sessionId, iteration });
    }

    return {
      response: finalResponse,
      toolCallsExecuted,
      iterations: iteration,
      tokenUsage: accumulatedTokenUsage,
      filesModified,
    };
  }

  /**
   * Standard loop execution (non-plan mode).
   * Integrates execution trace capture, vision analysis for screenshot inputs,
   * multimodal LLM fallback, and automatic artifact storage.
   *
   * Requirements: 1.1, 7.1, 7.5, 14.1
   */
  private async runStandardLoop(message: string): Promise<AgentLoopResult> {
    const { llmClient, toolSystem, projectDir, sessionId, maxIterations, smartContextEnabled, smartContextConfig, callbackEngine, onProgress, executionTraceService } = this.config;

    // ─── Execution Trace: start trace on task start (Req 14.1) ───
    let traceId: string | undefined;
    if (executionTraceService) {
      const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      traceId = executionTraceService.startTrace(sessionId, messageId);
    }

    // ─── Vision Analysis: detect screenshot input and invoke analyzer (Req 7.1, 7.5) ───
    let visionContext = '';
    const screenshotData = this.extractScreenshotData(message);
    if (screenshotData) {
      visionContext = await this.processScreenshotInput(screenshotData, traceId);
    }

    // ─── AutoTuner: classify task and resolve parameters (Req 16.1-16.4) ───
    const autoTuningResult = await this.resolveAutoTuning(message);
    const llmOptions = autoTuningResult
      ? { temperature: autoTuningResult.recommendedParams.temperature, maxTokens: autoTuningResult.recommendedParams.maxTokens }
      : undefined;

    // ─── DriftMonitor: initialize if drift config is enabled (Req 1.5, 9.1, 9.2) ───
    let driftMonitor: DriftMonitor | null = null;
    let driftDisabled = false;

    if (this.config.driftConfig?.enabled) {
      try {
        const registeredToolNames = toolSystem.list().map((t: ToolDefinition) => t.id);
        driftMonitor = new DriftMonitor(this.config.driftConfig, {
          callbackEngine: (callbackEngine as CallbackEngine | undefined) ?? null,
          ipcSend: this.config.ipcSend,
          registeredTools: registeredToolNames,
        });
        if (autoTuningResult) {
          driftMonitor.initialize(autoTuningResult.classification, message);
        } else {
          // Default classification when AutoTuner is not configured
          driftMonitor.initialize({ type: 'code-generation', confidence: 0.5 }, message);
        }
      } catch (err) {
        console.warn('[DriftMonitor] Initialization failed, drift disabled:', err);
        driftMonitor = null;
        driftDisabled = true;
      }
    }

    // Build tool definitions for the LLM
    const toolDefs = buildToolDefinitions(toolSystem);

    // Load AI rules (reload per message — requirement 5.5)
    const aiRules = loadAIRules(projectDir);
    const rulesContent = aiRules?.content ?? undefined;

    // Run Smart Context selection if enabled (requirement 11.3)
    const relevantContext = await runSmartContextSelection(message, projectDir, smartContextEnabled, smartContextConfig);

    // Build the system prompt (with injected context if available, including vision context)
    const combinedContext = [relevantContext, visionContext].filter(Boolean).join('\n\n') || undefined;

    // Use enhanced system prompt when production UX directives are enabled (Req 2.1, 2.2, 2.4, 3.1–3.5)
    const useCodeQuality = this.isFeatureEnabled('production_ux_code_quality');
    const useActionFirst = this.isFeatureEnabled('production_ux_action_first');

    let systemPrompt: string;
    if (useCodeQuality || useActionFirst) {
      const promptConfig: SystemPromptConfig = {
        projectDir,
        tools: toolDefs,
        rulesContent,
        relevantContext: combinedContext,
        steeringContent: this.config.steeringContent,
        powerContext: this.config.powerContext,
        codeQualityDirectives: useCodeQuality
          ? this.config.codeQualityDirectives ?? DEFAULT_CODE_QUALITY_DIRECTIVES
          : { enforceErrorHandling: false, enforceTypeSafety: false, enforceConventionFollowing: false, enforceVerification: false, verificationTools: [] },
        actionFirstDirectives: useActionFirst
          ? this.config.actionFirstDirectives ?? DEFAULT_ACTION_FIRST_DIRECTIVES
          : { prohibitPlanOnlyResponses: false, requireToolUsageForFileOps: false, requireToolUsageForExecution: false },
      };
      systemPrompt = buildEnhancedSystemPrompt(promptConfig);
    } else {
      systemPrompt = buildSystemPrompt(projectDir, toolDefs, rulesContent, combinedContext);
    }

    // Initialize conversation
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];

    // Track state
    let iteration = 0;
    let toolCallsExecuted = 0;
    const filesModified: string[] = [];
    const artifactIds: string[] = [];
    const tokenUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };
    const loopStartTime = Date.now();

    // ─── Action-First Detection: initialize re-prompt tracking (Req 2.3, 2.5) ───
    const actionFirstDetector = new ActionFirstDetector();
    let rePromptAttempts = 0;
    const maxRePromptAttemptsResolved = this.config.maxRePromptAttempts ?? DEFAULT_MAX_RE_PROMPT_ATTEMPTS;

    // Iteration loop
    while (iteration < maxIterations) {
      iteration++;

      // ─── DriftMonitor: per-iteration confidence evaluation (Req 2.7, 12.1) ───
      if (driftMonitor && !driftDisabled) {
        try {
          const elapsedMs = Date.now() - loopStartTime;
          const driftResult = driftMonitor.evaluateConfidence(iteration, elapsedMs);
          if (driftResult.paused && this.config.driftConfig?.driftPauseOnCritical) {
            // Pause execution: emit progress with paused state and break
            onProgress?.({
              iteration,
              maxIterations,
              status: 'complete',
              driftConfidence: driftResult.confidence,
            });
            break;
          }
        } catch (err) {
          console.warn('[DriftMonitor] Confidence evaluation failed, disabling drift:', err);
          driftDisabled = true;
        }
      }

      // Emit progress: thinking (include autoTuning info on first iteration)
      onProgress?.({
        iteration,
        maxIterations,
        status: 'thinking',
        ...(iteration === 1 && autoTuningResult ? { autoTuning: autoTuningResult } : {}),
        ...(driftMonitor && !driftDisabled ? { driftConfidence: driftMonitor.getState().confidence } : {}),
      });

      // Call LLM with tools (apply auto-tuned parameters)
      let response: AgentLLMResponse;
      const llmStartTime = Date.now();
      try {
        // Emit before-llm-call hook
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'before-llm-call',
            sessionId,
            iteration,
          });
        }

        response = await llmClient.chatWithTools(messages, toolDefs, llmOptions);

        // Emit after-llm-call hook
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'after-llm-call',
            sessionId,
            iteration,
            output: response,
          });
        }

        // ─── Execution Trace: record LLM request (Req 14.1) ───
        if (executionTraceService && traceId) {
          executionTraceService.addEntry(traceId, {
            timestamp: new Date().toISOString(),
            type: 'llm-request',
            tokenCount: response.usage?.totalTokens,
            durationMs: Date.now() - llmStartTime,
          });
        }
      } catch (error) {
        // LLM call failed — emit error hook and stop
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'on-error',
            error: error instanceof Error ? error : new Error(String(error)),
            sessionId,
            iteration,
          });
        }

        // ─── Execution Trace: record error entry ───
        if (executionTraceService && traceId) {
          executionTraceService.addEntry(traceId, {
            timestamp: new Date().toISOString(),
            type: 'error',
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - llmStartTime,
          });
          await executionTraceService.completeTrace(traceId);
        }

        // Return partial results with error message
        return {
          response: `Error calling LLM: ${error instanceof Error ? error.message : String(error)}`,
          toolCallsExecuted,
          iterations: iteration,
          tokenUsage,
          filesModified,
          autoTuning: autoTuningResult ?? undefined,
          traceId,
          artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
          ...(driftMonitor ? { driftConfidence: driftMonitor.getState().confidence, driftSignalCount: driftMonitor.getState().signals.length } : {}),
        };
      }

      // Accumulate token usage
      if (response.usage) {
        tokenUsage.promptTokens += response.usage.promptTokens;
        tokenUsage.completionTokens += response.usage.completionTokens;
        tokenUsage.totalTokens += response.usage.totalTokens;
      }

      // ─── Cost Tracking: record usage after each LLM call (Req 1.1, 1.6) ───
      if (response.usage && this.costTrackingService) {
        const costResult = await this.executeFeatureGuarded('cost_tracking', () => {
          const result = this.costTrackingService!.recordUsage(
            { promptTokens: response.usage!.promptTokens, completionTokens: response.usage!.completionTokens, totalTokens: response.usage!.totalTokens, estimatedCost: 0 },
            'unknown', // model is not directly available here; consumers should pass it
            'unknown', // provider is not directly available here
          );
          // Update estimated cost on the token usage
          tokenUsage.estimatedCost = this.costTrackingService!.getSessionCost();
          return result;
        }, 'cost-tracking-after-llm-call');

        // ─── Budget Exceeded: pause execution and request user confirmation (Req 1.4) ───
        if (costResult?.budgetExceeded && this.config.onBudgetExceeded) {
          const sessionCost = this.costTrackingService.getSessionCost();
          const dailyCost = this.costTrackingService.getDailyCost();
          const limitUsd = costResult.dailyBudgetExceeded
            ? this.config.superagentConfig?.costTracking?.dailyLimitUsd ?? 50.0
            : this.config.superagentConfig?.costTracking?.sessionLimitUsd ?? 10.0;
          const message = costResult.dailyBudgetExceeded
            ? `Daily budget limit ($${limitUsd.toFixed(2)}) reached. Current daily cost: $${dailyCost.toFixed(4)}.`
            : `Session budget limit ($${limitUsd.toFixed(2)}) reached. Current session cost: $${sessionCost.toFixed(4)}.`;

          const shouldContinue = await this.config.onBudgetExceeded({
            sessionCostUsd: sessionCost,
            dailyCostUsd: dailyCost,
            limitUsd,
            message,
          });

          if (!shouldContinue) {
            // User declined to continue — return current results
            onProgress?.({ iteration, maxIterations, status: 'complete' });
            if (executionTraceService && traceId) {
              executionTraceService.addEntry(traceId, {
                timestamp: new Date().toISOString(),
                type: 'result',
                result: { budgetExceeded: true, userDeclinedContinuation: true },
              });
              await executionTraceService.completeTrace(traceId);
            }
            return {
              response: `⚠️ Budget limit reached ($${limitUsd.toFixed(2)}). Execution paused by user.\n\n${response.content || ''}`,
              toolCallsExecuted,
              iterations: iteration,
              tokenUsage,
              filesModified,
              autoTuning: autoTuningResult ?? undefined,
              traceId,
              artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
              ...(driftMonitor ? { driftConfidence: driftMonitor.getState().confidence, driftSignalCount: driftMonitor.getState().signals.length } : {}),
            };
          }
        }
      }

      // Check if response contains tool calls
      if (!response.tool_calls || response.tool_calls.length === 0) {
        // ─── Action-First Re-prompting: detect text-only when tools expected (Req 2.3, 2.5) ───
        // Only re-prompt if:
        // 1. Feature gate is enabled
        // 2. actionFirstEnabled config is not explicitly false
        // 3. Re-prompt attempts haven't been exhausted
        // 4. The LLM hasn't already used tools in this session (toolCallsExecuted === 0)
        // 5. The user message implies tool usage
        if (
          this.isFeatureEnabled('production_ux_action_first') &&
          this.config.actionFirstEnabled !== false &&
          rePromptAttempts < maxRePromptAttemptsResolved &&
          toolCallsExecuted === 0 &&
          actionFirstDetector.isTextOnlyWhenToolsExpected(response, message)
        ) {
          // Text-only response when tools were expected — re-prompt the LLM
          rePromptAttempts++;
          const rePromptMsg = actionFirstDetector.buildRePromptMessage(response.content || '');
          messages.push({ role: 'assistant', content: response.content || '' });
          messages.push({ role: 'user', content: rePromptMsg });
          // Continue the loop to re-invoke the LLM
          continue;
        }

        // No tool calls — LLM produced a final answer
        onProgress?.({
          iteration,
          maxIterations,
          status: 'complete',
        });

        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'on-task-complete',
            sessionId,
            iteration,
          });
        }

        // ─── Auto-store structured outputs as artifacts (Req 1.1) ───
        const storedArtifactId = await this.autoStoreArtifact(response.content || '', filesModified);
        if (storedArtifactId) {
          artifactIds.push(storedArtifactId);
        }

        // ─── Execution Trace: complete trace on finish (Req 14.1) ───
        if (executionTraceService && traceId) {
          executionTraceService.addEntry(traceId, {
            timestamp: new Date().toISOString(),
            type: 'result',
            result: { response: (response.content || '').slice(0, 500), toolCallsExecuted },
          });
          await executionTraceService.completeTrace(traceId);
        }

        return {
          response: response.content || '',
          toolCallsExecuted,
          iterations: iteration,
          tokenUsage,
          filesModified,
          autoTuning: autoTuningResult ?? undefined,
          traceId,
          artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
          ...(driftMonitor ? { driftConfidence: driftMonitor.getState().confidence, driftSignalCount: driftMonitor.getState().signals.length } : {}),
        };
      }

      // Append assistant message with tool calls to conversation
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      });

      // Execute each tool call
      for (const toolCall of response.tool_calls) {
        const toolName = toolCall.function.name;

        // Emit progress: tool executing
        onProgress?.({
          iteration,
          maxIterations,
          lastToolCall: toolName,
          status: 'tool_executing',
        });

        // Parse tool arguments
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          // If arguments can't be parsed, report error as tool result
          const errorResult = JSON.stringify({
            success: false,
            error: `Failed to parse tool arguments: ${toolCall.function.arguments}`,
          });
          messages.push({
            role: 'tool',
            content: errorResult,
            tool_call_id: toolCall.id,
          });
          toolCallsExecuted++;
          continue;
        }

        // Build tool context
        const toolContext: ToolContext = {
          agentId: 'agent-loop',
          sessionId,
          projectDir,
          permissionMode: 'auto-approve',
        };

        // Emit before-tool-call hook
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'before-tool-call',
            toolName,
            input: parsedArgs,
            sessionId,
            iteration,
          });
        }

        // ─── DriftMonitor: scope validation before tool call (Req 4.2, 12.2) ───
        if (driftMonitor && !driftDisabled) {
          try {
            const filePath = (parsedArgs as Record<string, unknown>)?.path as string | undefined;
            const scopeResult = driftMonitor.validateScope(toolName, filePath);
            if (scopeResult.blocked) {
              // Scope violation in block mode — return error to LLM instead of executing
              const blockedResult = JSON.stringify({
                success: false,
                error: scopeResult.error || `Tool call "${toolName}" blocked by drift scope envelope.`,
              });
              messages.push({
                role: 'tool',
                content: blockedResult,
                tool_call_id: toolCall.id,
              });
              toolCallsExecuted++;
              driftMonitor.recordToolResult(toolName, false);
              continue;
            }
          } catch (err) {
            console.warn('[DriftMonitor] Scope validation failed, allowing tool call:', err);
          }
        }

        // Execute the tool
        const toolStartTime = Date.now();
        let toolResult: ToolResult;
        try {
          toolResult = await toolSystem.execute(toolName, parsedArgs, toolContext);
        } catch (error) {
          // Tool execution threw — wrap as a failed result
          toolResult = {
            success: false,
            output: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        const toolDurationMs = Date.now() - toolStartTime;

        // ─── Execution Trace: record tool call entry (Req 14.1) ───
        if (executionTraceService && traceId) {
          executionTraceService.addEntry(traceId, {
            timestamp: new Date().toISOString(),
            type: 'tool-call',
            toolName,
            parameters: parsedArgs as Record<string, unknown>,
            durationMs: toolDurationMs,
            result: toolResult.success ? toolResult.output : undefined,
            error: toolResult.error,
          });
        }

        // Emit after-tool-call hook
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'after-tool-call',
            toolName,
            input: parsedArgs,
            output: toolResult,
            error: toolResult.success ? undefined : new Error(toolResult.error || 'Tool failed'),
            sessionId,
            iteration,
          });
        }

        // ─── DriftMonitor: record tool result for failure tracking (Req 2.3, 2.4) ───
        if (driftMonitor && !driftDisabled) {
          driftMonitor.recordToolResult(toolName, toolResult.success);
        }

        // Track file modifications (heuristic: tools that write files)
        if (toolResult.success && (toolName === 'file-write' || toolName === 'file-edit')) {
          const filePath = (parsedArgs as Record<string, unknown>)?.path;
          if (typeof filePath === 'string' && !filesModified.includes(filePath)) {
            filesModified.push(filePath);
          }
        }

        // Append tool result as a 'tool' role message
        // Include both success and failure results so LLM can reason about errors
        const resultContent = JSON.stringify({
          success: toolResult.success,
          output: toolResult.output,
          ...(toolResult.error ? { error: toolResult.error } : {}),
        });

        messages.push({
          role: 'tool',
          content: resultContent,
          tool_call_id: toolCall.id,
        });

        toolCallsExecuted++;
      }

      // ─── Checkpoint: save state after each tool execution cycle (Req 2.1, 2.5, 2.7) ───
      await this.executeFeatureGuarded('checkpoint', () => {
        return this.checkpointService!.save({
          schemaVersion: 3,
          sessionId,
          timestamp: new Date().toISOString(),
          conversationHistory: messages,
          planProgress: { completedSteps: Array.from({ length: toolCallsExecuted }, (_, i) => i), pendingSteps: [] },
          fileChangeManifest: filesModified,
          iterationCount: iteration,
          customState: {},
        });
      }, 'checkpoint-after-tool-cycle');
    }

    // Max iterations reached — return partial results
    onProgress?.({
      iteration,
      maxIterations,
      status: 'complete',
    });

    if (callbackEngine) {
      await callbackEngine.emit({
        event: 'on-task-complete',
        sessionId,
        iteration,
      });
    }

    // ─── Execution Trace: complete trace on max iterations (Req 14.1) ───
    if (executionTraceService && traceId) {
      executionTraceService.addEntry(traceId, {
        timestamp: new Date().toISOString(),
        type: 'result',
        result: { maxIterationsReached: true, toolCallsExecuted },
      });
      await executionTraceService.completeTrace(traceId);
    }

    // Gather the last assistant content as the response
    const lastAssistantMsg = messages
      .filter((m) => m.role === 'assistant')
      .pop();

    // ─── Iteration Persistence: build work summary and incomplete indicator (Req 1.3) ───
    const iterationPersistenceEnabled = this.isFeatureEnabled('production_ux_iteration_persistence');
    const workSummary = iterationPersistenceEnabled
      ? this.buildWorkSummary(toolCallsExecuted, filesModified, iteration, maxIterations)
      : undefined;

    return {
      response:
        (lastAssistantMsg?.content || '') +
        `\n\n⚠️ Maximum iteration limit (${maxIterations}) reached. The task may be incomplete.` +
        (workSummary ? `\n\n📋 Work Summary:\n${workSummary}` : ''),
      toolCallsExecuted,
      iterations: iteration,
      tokenUsage,
      filesModified,
      autoTuning: autoTuningResult ?? undefined,
      traceId,
      artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
      ...(driftMonitor ? { driftConfidence: driftMonitor.getState().confidence, driftSignalCount: driftMonitor.getState().signals.length } : {}),
      ...(iterationPersistenceEnabled ? { incomplete: true, workSummary } : {}),
    };
  }

  // ─── Iteration Persistence: Work Summary Builder (Req 1.3) ──

  /**
   * Build a human-readable summary of work performed during the loop.
   * Used when the loop terminates due to max iterations being reached.
   */
  private buildWorkSummary(
    toolCallsExecuted: number,
    filesModified: string[],
    iterations: number,
    maxIterations: number,
  ): string {
    const lines: string[] = [];
    lines.push(`- Iterations completed: ${iterations}/${maxIterations}`);
    lines.push(`- Tool calls executed: ${toolCallsExecuted}`);
    if (filesModified.length > 0) {
      lines.push(`- Files modified (${filesModified.length}): ${filesModified.join(', ')}`);
    } else {
      lines.push('- Files modified: none');
    }
    return lines.join('\n');
  }

  // ─── AutoTuner Integration ──────────────────────────────────

  /**
   * Resolve auto-tuning parameters for the given user message.
   * Classifies the task, optionally refines from benchmark history,
   * and allows user override via the configured callback.
   *
   * Returns null if auto-tuning is not configured.
   *
   * Requirements: 16.1, 16.2, 16.3, 16.4
   */
  private async resolveAutoTuning(message: string): Promise<AutoTunerResult | null> {
    const { autoTunerConfig } = this.config;
    if (!autoTunerConfig) {
      return null;
    }

    const { autoTuner, getBenchmarkHistory, onParameterOverride } = autoTunerConfig;

    // Step 1: Classify the task type (Req 16.1)
    const classification = await autoTuner.classifyTaskAsync(message);

    // Step 2: Get recommended parameters for the task type (Req 16.2)
    let recommendedParams = autoTuner.getRecommendedParams(classification.type);
    let refinedFromBenchmarks = false;

    // Step 3: Refine from benchmark history if available (Req 16.4)
    if (getBenchmarkHistory) {
      try {
        const history = await getBenchmarkHistory(classification.type);
        if (history && history.length > 0) {
          recommendedParams = autoTuner.refineFromBenchmarks(classification.type, history);
          refinedFromBenchmarks = true;
        }
      } catch {
        // Graceful degradation: continue with base parameters if benchmark lookup fails
      }
    }

    const result: AutoTunerResult = {
      classification,
      recommendedParams,
      refinedFromBenchmarks,
    };

    // Step 4: Allow user override via UI callback (Req 16.3)
    if (onParameterOverride) {
      try {
        const overrideProfile = await onParameterOverride(result);
        if (overrideProfile) {
          result.recommendedParams = overrideProfile;
        }
      } catch {
        // Graceful degradation: continue with recommended params if override callback fails
      }
    }

    return result;
  }

  // ─── Vision & Artifact Integration ──────────────────────────

  /**
   * Detect if the user message contains screenshot/image data.
   * Looks for base64-encoded image data markers or known image content patterns.
   *
   * Requirements: 7.1
   */
  private extractScreenshotData(message: string): Buffer | null {
    // Check for base64-encoded image data in the message (data URI pattern)
    const dataUriMatch = message.match(/data:image\/(?:png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)/);
    if (dataUriMatch && dataUriMatch[1]) {
      try {
        return Buffer.from(dataUriMatch[1], 'base64');
      } catch {
        return null;
      }
    }

    // Check for raw base64 image markers (common in multimodal LLM payloads)
    const base64Match = message.match(/\[screenshot:base64\]([A-Za-z0-9+/=]+)\[\/screenshot\]/);
    if (base64Match && base64Match[1]) {
      try {
        return Buffer.from(base64Match[1], 'base64');
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Process screenshot input: invoke VisionAnalyzer or fall back to multimodal LLM.
   *
   * - If ONNX model is available, analyzes the screenshot locally for component detection
   * - If ONNX model is unavailable, falls back to multimodal LLM vision input
   *
   * Returns a context string describing the detected components to inject into the system prompt.
   *
   * Requirements: 7.1, 7.5
   */
  private async processScreenshotInput(imageBuffer: Buffer, traceId?: string): Promise<string> {
    const { visionAnalyzer, multimodalLLMClient, executionTraceService } = this.config;

    // If no vision services are available, skip
    if (!visionAnalyzer && !multimodalLLMClient) {
      return '';
    }

    const startTime = Date.now();

    try {
      // Attempt ONNX-based vision analysis (Req 7.1)
      if (visionAnalyzer && visionAnalyzer.isModelAvailable()) {
        // Estimate dimensions from buffer (assume RGBA, use a reasonable default)
        // In practice, the caller would decode the image; here we provide a conservative size
        const estimatedWidth = 1920;
        const estimatedHeight = 1080;

        const analysisResult = await visionAnalyzer.analyzeScreenshot(
          imageBuffer,
          estimatedWidth,
          estimatedHeight,
        );

        // Record trace entry for vision analysis
        if (executionTraceService && traceId) {
          executionTraceService.addEntry(traceId, {
            timestamp: new Date().toISOString(),
            type: 'tool-call',
            toolName: 'vision-analyze',
            parameters: { imageSize: analysisResult.imageSize },
            durationMs: Date.now() - startTime,
            result: { componentCount: analysisResult.components.length },
          });
        }

        // Format detected components as context
        if (analysisResult.components.length > 0) {
          const componentDescriptions = analysisResult.components
            .map((c) => `- ${c.type} at (${c.boundingBox.x}, ${c.boundingBox.y}) ${c.boundingBox.width}x${c.boundingBox.height} [confidence: ${(c.confidence * 100).toFixed(1)}%]${c.label ? ` label: "${c.label}"` : ''}`)
            .join('\n');
          return `## Screenshot Analysis\nDetected ${analysisResult.components.length} UI components:\n${componentDescriptions}`;
        }

        return '## Screenshot Analysis\nNo UI components detected in the provided screenshot.';
      }

      // Fall back to multimodal LLM when ONNX unavailable (Req 7.5)
      if (multimodalLLMClient) {
        const fallbackPrompt = 'Analyze this UI screenshot. Identify and describe all visible UI components (buttons, inputs, text, images, navigation, cards) with their approximate positions and any visible text labels. Format as a structured list.';
        const llmAnalysis = await multimodalLLMClient.analyzeImage(imageBuffer, fallbackPrompt);

        // Record trace entry for multimodal fallback
        if (executionTraceService && traceId) {
          executionTraceService.addEntry(traceId, {
            timestamp: new Date().toISOString(),
            type: 'tool-call',
            toolName: 'vision-analyze-multimodal-fallback',
            parameters: { fallback: true },
            durationMs: Date.now() - startTime,
            result: { analysisLength: llmAnalysis.length },
          });
        }

        return `## Screenshot Analysis (Multimodal LLM)\n${llmAnalysis}`;
      }
    } catch (error) {
      // Graceful degradation: if vision analysis fails entirely, continue without it
      console.error('[AgentLoop] Vision analysis failed:', error);

      // If the error is MODEL_UNAVAILABLE and we have a multimodal client, try fallback
      if (error instanceof FeatureError && error.code === 'MODEL_UNAVAILABLE' && multimodalLLMClient) {
        try {
          const fallbackPrompt = 'Analyze this UI screenshot. Identify and describe all visible UI components with their approximate positions and any visible text labels.';
          const llmAnalysis = await multimodalLLMClient.analyzeImage(imageBuffer, fallbackPrompt);

          if (executionTraceService && traceId) {
            executionTraceService.addEntry(traceId, {
              timestamp: new Date().toISOString(),
              type: 'tool-call',
              toolName: 'vision-analyze-multimodal-fallback',
              parameters: { fallback: true, reason: 'model_unavailable' },
              durationMs: Date.now() - startTime,
              result: { analysisLength: llmAnalysis.length },
            });
          }

          return `## Screenshot Analysis (Multimodal LLM Fallback)\n${llmAnalysis}`;
        } catch (fallbackError) {
          console.error('[AgentLoop] Multimodal fallback also failed:', fallbackError);
        }
      }

      // Record error in trace
      if (executionTraceService && traceId) {
        executionTraceService.addEntry(traceId, {
          timestamp: new Date().toISOString(),
          type: 'error',
          toolName: 'vision-analyze',
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startTime,
        });
      }
    }

    return '';
  }

  /**
   * Automatically store structured agent outputs as artifacts.
   *
   * Detects whether the LLM response contains structured output (code blocks,
   * JSON data, document content) and stores it as an artifact via ArtifactService.
   *
   * Requirements: 1.1
   */
  private async autoStoreArtifact(response: string, filesModified: string[]): Promise<string | null> {
    const { artifactService, sessionId, projectDir } = this.config;

    if (!artifactService || !response) {
      return null;
    }

    // Detect structured output patterns worth storing as artifacts
    const artifactCandidate = this.detectStructuredOutput(response);
    if (!artifactCandidate) {
      return null;
    }

    try {
      const artifact = await artifactService.create({
        sessionId,
        projectDir,
        title: artifactCandidate.title,
        type: artifactCandidate.type,
        content: artifactCandidate.content,
        metadata: {
          autoStored: true,
          filesModified,
          detectedPattern: artifactCandidate.pattern,
        },
      });
      return artifact.id;
    } catch (error) {
      // Graceful degradation: if artifact storage fails, continue without it
      console.error('[AgentLoop] Auto-artifact storage failed:', error);
      return null;
    }
  }

  /**
   * Detect structured output in the LLM response that should be stored as an artifact.
   * Returns artifact metadata if a recognizable pattern is found, null otherwise.
   */
  private detectStructuredOutput(response: string): { title: string; type: ArtifactType; content: string; pattern: string } | null {
    // Detect multi-file code generation (multiple code blocks with file paths)
    const codeBlockRegex = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
    const codeBlocks: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = codeBlockRegex.exec(response)) !== null) {
      codeBlocks.push(match[1]);
    }

    // If there are multiple substantial code blocks, store as code-bundle
    if (codeBlocks.length >= 2) {
      const totalLength = codeBlocks.reduce((sum, b) => sum + b.length, 0);
      if (totalLength > 200) {
        return {
          title: 'Generated Code Bundle',
          type: 'code-bundle',
          content: codeBlocks.join('\n\n// --- next file ---\n\n'),
          pattern: 'multi-code-block',
        };
      }
    }

    // Detect single large code block (e.g., a complete component or module)
    if (codeBlocks.length === 1 && codeBlocks[0].length > 500) {
      return {
        title: 'Generated Code',
        type: 'code-bundle',
        content: codeBlocks[0],
        pattern: 'single-large-code-block',
      };
    }

    // Detect JSON data output (structured data like configs, schemas)
    const jsonMatch = response.match(/```json\s*\n([\s\S]{100,})```/);
    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[1]); // Validate it's actual JSON
        return {
          title: 'Generated Data',
          type: 'document',
          content: jsonMatch[1],
          pattern: 'json-output',
        };
      } catch {
        // Not valid JSON, skip
      }
    }

    // Detect generated app structure (package.json mention + multiple files)
    if (response.includes('package.json') && codeBlocks.length >= 3) {
      return {
        title: 'Generated Application',
        type: 'generated-app',
        content: response,
        pattern: 'app-generation',
      };
    }

    return null;
  }
}
