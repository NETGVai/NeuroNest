/**
 * Agent Loop Controller — Iterative tool-use loop connecting LLM responses to real tool execution.
 *
 * Implements the standard agentic pattern:
 * 1. Send conversation (system prompt + history + user message) to LLM
 * 2. If response contains `tool_calls` → execute each via ToolSystem, append results as `tool` role messages
 * 3. Send updated conversation back to LLM
 * 4. Repeat until no more tool calls or maxIterations reached
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6
 */

import type { ToolSystem } from '../tools/tool-system.js';
import type { ToolContext, ToolResult, TokenUsage, ToolDefinition } from '../shared/types.js';
import { loadAIRules } from './simple-responder.js';
import { SmartContextSelector } from './smart-context.js';
import type { SmartContextResult } from './smart-context.js';
import type { LLMClient } from './llm-client';
import type { CallbackEngine } from './callback-engine.js';
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
  callbackEngine?: CallbackEngineEmitter;
  onProgress?: (update: LoopProgress) => void;
  onPlanReady?: (plan: ExecutionPlan) => Promise<PlanApprovalResult>;
}

/** Progress update emitted on each iteration */
export interface LoopProgress {
  iteration: number;
  maxIterations: number;
  lastToolCall?: string;
  status: 'thinking' | 'tool_executing' | 'awaiting_approval' | 'complete';
}

/** Result returned when the loop completes */
export interface AgentLoopResult {
  response: string;
  toolCallsExecuted: number;
  iterations: number;
  tokenUsage: TokenUsage;
  filesModified: string[];
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

        response = await llmClient.chatWithTools(messages, toolDefs);

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
   */
  private async runStandardLoop(message: string): Promise<AgentLoopResult> {
    const { llmClient, toolSystem, projectDir, sessionId, maxIterations, smartContextEnabled, smartContextConfig, callbackEngine, onProgress } = this.config;

    // Build tool definitions for the LLM
    const toolDefs = buildToolDefinitions(toolSystem);

    // Load AI rules (reload per message — requirement 5.5)
    const aiRules = loadAIRules(projectDir);
    const rulesContent = aiRules?.content ?? undefined;

    // Run Smart Context selection if enabled (requirement 11.3)
    const relevantContext = await runSmartContextSelection(message, projectDir, smartContextEnabled, smartContextConfig);

    // Build the system prompt (with injected context if available)
    const systemPrompt = buildSystemPrompt(projectDir, toolDefs, rulesContent, relevantContext || undefined);

    // Initialize conversation
    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ];

    // Track state
    let iteration = 0;
    let toolCallsExecuted = 0;
    const filesModified: string[] = [];
    const tokenUsage: TokenUsage = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
    };

    // Iteration loop
    while (iteration < maxIterations) {
      iteration++;

      // Emit progress: thinking
      onProgress?.({
        iteration,
        maxIterations,
        status: 'thinking',
      });

      // Call LLM with tools
      let response: AgentLLMResponse;
      try {
        // Emit before-llm-call hook
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'before-llm-call',
            sessionId,
            iteration,
          });
        }

        response = await llmClient.chatWithTools(messages, toolDefs);

        // Emit after-llm-call hook
        if (callbackEngine) {
          await callbackEngine.emit({
            event: 'after-llm-call',
            sessionId,
            iteration,
            output: response,
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
        // Return partial results with error message
        return {
          response: `Error calling LLM: ${error instanceof Error ? error.message : String(error)}`,
          toolCallsExecuted,
          iterations: iteration,
          tokenUsage,
          filesModified,
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

        return {
          response: response.content || '',
          toolCallsExecuted,
          iterations: iteration,
          tokenUsage,
          filesModified,
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

        // Execute the tool
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
    };
  }
}
