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
  onProgress?: (update: LoopProgress) => void;
  onPlanReady?: (plan: ExecutionPlan) => Promise<PlanApprovalResult>;
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
- Use tools to accomplish the user's request
- Read files before making edits to understand current state
- When a tool call fails, analyze the error and try an alternative approach
- Provide clear explanations of what you're doing and why
- When you're done, provide a final summary of all changes made`;
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

// ─── Agent Loop Controller ──────────────────────────────────────

export class AgentLoopController {
  private config: AgentLoopConfig;

  constructor(config: AgentLoopConfig) {
    this.config = {
      ...config,
      maxIterations: config.maxIterations ?? 25,
    };
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
    const systemPrompt = buildSystemPrompt(projectDir, toolDefs, rulesContent, combinedContext);

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

      // Check if response contains tool calls
      if (!response.tool_calls || response.tool_calls.length === 0) {
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

    return {
      response:
        (lastAssistantMsg?.content || '') +
        `\n\n⚠️ Maximum iteration limit (${maxIterations}) reached. The task may be incomplete.`,
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
    const classification = autoTuner.classifyTask(message);

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
