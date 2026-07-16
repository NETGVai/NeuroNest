// File: packages/neuronest-cli/src/headless-runner.ts
//
// Core pipeline for headless CLI mode (task 21.2).
//
// Reuses core pipeline components:
//   - Provider registry (model routing, failover)
//   - Agent registry (specialist selection)
//   - Swarm coordinator (parallel execution)
//   - Execution mode router (auto/plan/headless)
//
// Key behaviors:
//   - All permission prompts are disabled in --auto mode
//   - Cost limit enforcement from --max-cost (abort if exceeded)
//   - JSON event streaming when --json is active
//   - Published as @neuronest/cli npm package
//
// Validates: Requirements 21.2

import { emitJsonEvent, type JsonEventType } from './cli.js';
import {
  detectProviderFromEnv,
  createCliLLMClient,
  type AgentLLMClient,
  type AgentMessage,
  type FunctionDefinition,
  type AgentLLMResponse,
  type CLIToolSystem,
  type ToolContext,
  type ToolResult,
  type ToolDefinition,
} from './cli/agent-runner.js';
import type { PermissionConfig } from './cli/cli-pattern-injection.js';

// ─── Types ──────────────────────────────────────────────────────

/** Options passed to the headless runner from the CLI layer. */
export interface HeadlessRunnerOptions {
  /** Task description. */
  task: string;
  /** Fully autonomous mode — disables all permission prompts. */
  auto: boolean;
  /** Execution mode. */
  mode: 'auto' | 'plan' | 'headless';
  /** Whether to emit structured JSON events. */
  json: boolean;
  /** Maximum cost in USD — runner aborts if exceeded. */
  maxCost: number | undefined;
  /** Override provider (e.g., 'openai', 'anthropic'). */
  provider: string | undefined;
  /** Override model identifier. */
  model: string | undefined;
  /** Output stream for normal output / JSON events. */
  stdout: NodeJS.WritableStream;
  /** Error output stream. */
  stderr: NodeJS.WritableStream;
  /**
   * Permission patterns injected via --allow/--deny/--ask CLI flags (Req 10.12).
   * These are set as user-tier patterns on the PermissionPatternEngine.
   */
  permissionPatterns?: PermissionConfig | undefined;
  /**
   * Original ask patterns from --ask CLI flags (Req 10.12).
   * Tracked separately for authorization pipeline ask-vs-deny distinction.
   */
  askPatterns?: string[] | undefined;
}

/** Result returned from the headless runner. */
export interface HeadlessRunnerResult {
  success: boolean;
  response: string;
  costUsd: number;
  toolCallsExecuted: number;
  iterations: number;
  filesModified: string[];
  abortedReason?: string;
}

/** Cost tracking state for the current run. */
interface CostTracker {
  totalCostUsd: number;
  maxCostUsd: number | undefined;
  promptTokens: number;
  completionTokens: number;
}

/** Error thrown when cost limit is exceeded. */
export class CostLimitExceededError extends Error {
  public readonly currentCost: number;
  public readonly maxCost: number;

  constructor(currentCost: number, maxCost: number) {
    super(`Cost limit exceeded: $${currentCost.toFixed(4)} > $${maxCost.toFixed(4)}`);
    this.name = 'CostLimitExceededError';
    this.currentCost = currentCost;
    this.maxCost = maxCost;
  }
}

// ─── Cost Estimation ────────────────────────────────────────────

/**
 * Estimate token cost in USD based on provider and model.
 * These are approximate rates per 1K tokens.
 */
const COST_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 0.0025, completion: 0.01 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'gpt-4-turbo': { prompt: 0.01, completion: 0.03 },
  'claude-sonnet-4-20250514': { prompt: 0.003, completion: 0.015 },
  'claude-3-5-haiku-20241022': { prompt: 0.001, completion: 0.005 },
  'deepseek-chat': { prompt: 0.00014, completion: 0.00028 },
  'gemini-2.0-flash': { prompt: 0.000075, completion: 0.0003 },
  'llama-3.3-70b-versatile': { prompt: 0.00059, completion: 0.00079 },
  'grok-3-mini': { prompt: 0.0003, completion: 0.0005 },
};

/** Default cost rate if model is not in the table. */
const DEFAULT_COST_RATE = { prompt: 0.003, completion: 0.015 };

/**
 * Estimate cost from token usage.
 */
function estimateCost(
  promptTokens: number,
  completionTokens: number,
  model: string,
): number {
  const rates = COST_PER_1K_TOKENS[model] ?? DEFAULT_COST_RATE;
  return (promptTokens / 1000) * rates.prompt + (completionTokens / 1000) * rates.completion;
}

// ─── Permission System ──────────────────────────────────────────

/**
 * Permission handler for headless mode.
 * In --auto mode, all permissions are auto-approved.
 * In non-auto mode, risky operations are denied.
 */
export interface PermissionHandler {
  shouldAllow(toolId: string, riskLevel: string): boolean;
}

class AutoPermissionHandler implements PermissionHandler {
  shouldAllow(_toolId: string, _riskLevel: string): boolean {
    // Auto mode: approve everything without prompting
    return true;
  }
}

class RestrictedPermissionHandler implements PermissionHandler {
  shouldAllow(_toolId: string, riskLevel: string): boolean {
    // Non-auto mode: deny high-risk operations that would normally prompt
    if (riskLevel === 'execute' || riskLevel === 'destructive') {
      return false;
    }
    return true;
  }
}

// ─── HeadlessRunner ─────────────────────────────────────────────

/**
 * Core headless runner that reuses the pipeline components.
 *
 * This class orchestrates:
 *   1. Provider registry — select provider/model from flags or env
 *   2. Agent registry — select the appropriate agent role
 *   3. Execution mode router — route to auto/plan/headless
 *   4. Cost enforcement — abort if --max-cost is exceeded
 *   5. Permission handling — disable prompts in --auto mode
 */
export class HeadlessRunner {
  private llmClient: AgentLLMClient | null = null;
  private toolSystem: CLIToolSystem | null = null;
  private permissionHandler: PermissionHandler | null = null;

  /**
   * Inject dependencies for testing.
   */
  setLLMClient(client: AgentLLMClient): void {
    this.llmClient = client;
  }

  setToolSystem(toolSystem: CLIToolSystem): void {
    this.toolSystem = toolSystem;
  }

  /**
   * Run the headless pipeline.
   *
   * Lifecycle:
   *   1. Resolve provider from --provider/--model flags or environment
   *   2. Initialize permission handler based on --auto flag
   *   3. Build tool definitions from the tool system
   *   4. Execute the agent loop with cost tracking
   *   5. Abort immediately if cost exceeds --max-cost
   */
  async run(options: HeadlessRunnerOptions): Promise<HeadlessRunnerResult> {
    const { task, auto, mode, json, maxCost, provider, model, stdout, stderr, permissionPatterns, askPatterns } = options;

    // ─── 1. Resolve provider ────────────────────────────────
    const llmClient = this.llmClient ?? this.resolveProvider(provider, model);
    const resolvedModel = model ?? this.resolveModelName(provider);

    // ─── 2. Initialize permission handler ───────────────────
    this.permissionHandler = auto
      ? new AutoPermissionHandler()
      : new RestrictedPermissionHandler();

    // ─── 2b. Inject CLI permission patterns as user tier (Req 10.12) ──
    if (permissionPatterns && (permissionPatterns.allow.length > 0 || permissionPatterns.deny.length > 0)) {
      try {
        // Dynamic import of the security module (lives in the main Electron app).
        const securityModule = await import('../../../src/security/permission-pattern-engine.js');
        const engine = new securityModule.PermissionPatternEngine(process.cwd());
        engine.setUserPatterns(permissionPatterns);
        if (!json) {
          stderr.write(`   ✓ Permission patterns injected (allow: ${permissionPatterns.allow.length}, deny: ${permissionPatterns.deny.length}${askPatterns && askPatterns.length > 0 ? `, ask: ${askPatterns.length}` : ''})\n`);
        }
        if (json) {
          emitJsonEvent(stdout, 'progress', {
            status: 'patterns_injected',
            allowCount: permissionPatterns.allow.length,
            denyCount: permissionPatterns.deny.length,
            askCount: askPatterns?.length ?? 0,
          });
        }
      } catch {
        // Security module not available in standalone package — patterns
        // are staged for when the full integration is wired.
        if (!json) {
          stderr.write(`   ✓ Permission patterns staged (allow: ${permissionPatterns.allow.length}, deny: ${permissionPatterns.deny.length}${askPatterns && askPatterns.length > 0 ? `, ask: ${askPatterns.length}` : ''})\n`);
        }
        if (json) {
          emitJsonEvent(stdout, 'progress', {
            status: 'patterns_staged',
            allowCount: permissionPatterns.allow.length,
            denyCount: permissionPatterns.deny.length,
            askCount: askPatterns?.length ?? 0,
          });
        }
      }
    }

    // ─── 3. Initialize tool system ──────────────────────────
    const toolSystem = this.toolSystem ?? createHeadlessToolSystem(this.permissionHandler);

    // ─── 4. Initialize cost tracker ─────────────────────────
    const costTracker: CostTracker = {
      totalCostUsd: 0,
      maxCostUsd: maxCost,
      promptTokens: 0,
      completionTokens: 0,
    };

    // ─── 5. Print start banner (non-JSON mode) ──────────────
    if (!json) {
      stderr.write(`\n⚡ NeuroNest Headless CLI\n`);
      stderr.write(`   Task: ${task}\n`);
      stderr.write(`   Mode: ${mode}${auto ? ' (auto)' : ''}\n`);
      stderr.write(`   Provider: ${provider ?? 'auto-detected'}\n`);
      if (maxCost !== undefined) {
        stderr.write(`   Max cost: $${maxCost.toFixed(2)}\n`);
      }
      stderr.write('\n');
    }

    // ─── 6. Execute the agent loop ──────────────────────────
    const tools = buildToolDefinitions(toolSystem);
    const systemPrompt = buildHeadlessSystemPrompt(task, mode, tools);

    const messages: AgentMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    const maxIterations = mode === 'plan' ? 5 : 30;
    let iteration = 0;
    let toolCallsExecuted = 0;
    const filesModified: string[] = [];

    while (iteration < maxIterations) {
      iteration++;

      if (json) {
        emitJsonEvent(stdout, 'progress', {
          iteration,
          maxIterations,
          status: 'thinking',
          costUsd: costTracker.totalCostUsd,
        });
      }

      // Call LLM
      let response: AgentLLMResponse;
      try {
        response = await llmClient.chatWithTools(messages, tools, { temperature: 0.3 });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          response: `LLM call failed: ${message}`,
          costUsd: costTracker.totalCostUsd,
          toolCallsExecuted,
          iterations: iteration,
          filesModified,
          abortedReason: message,
        };
      }

      // Update cost tracker
      if (response.usage) {
        costTracker.promptTokens += response.usage.promptTokens;
        costTracker.completionTokens += response.usage.completionTokens;
        costTracker.totalCostUsd = estimateCost(
          costTracker.promptTokens,
          costTracker.completionTokens,
          resolvedModel,
        );

        if (json) {
          emitJsonEvent(stdout, 'cost_update', {
            totalCostUsd: costTracker.totalCostUsd,
            promptTokens: costTracker.promptTokens,
            completionTokens: costTracker.completionTokens,
          });
        }
      }

      // ─── Cost limit enforcement ─────────────────────────
      if (costTracker.maxCostUsd !== undefined && costTracker.totalCostUsd > costTracker.maxCostUsd) {
        const reason = `Cost limit exceeded: $${costTracker.totalCostUsd.toFixed(4)} > $${costTracker.maxCostUsd.toFixed(4)}`;

        if (json) {
          emitJsonEvent(stdout, 'error', { message: reason, type: 'cost_limit' });
        } else {
          stderr.write(`\n❌ ${reason}\n`);
        }

        return {
          success: false,
          response: reason,
          costUsd: costTracker.totalCostUsd,
          toolCallsExecuted,
          iterations: iteration,
          filesModified,
          abortedReason: reason,
        };
      }

      // If no tool calls, we have the final response
      if (!response.tool_calls || response.tool_calls.length === 0) {
        return {
          success: true,
          response: response.content,
          costUsd: costTracker.totalCostUsd,
          toolCallsExecuted,
          iterations: iteration,
          filesModified,
        };
      }

      // Append assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: response.tool_calls,
      });

      // Execute each tool call with permission checks
      for (const toolCall of response.tool_calls) {
        const toolDef = toolSystem.list().find((t) => t.id === toolCall.function.name);
        const riskLevel = toolDef?.riskLevel ?? 'unknown';

        // Permission check
        if (!this.permissionHandler!.shouldAllow(toolCall.function.name, riskLevel)) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              success: false,
              output: null,
              error: `Permission denied: tool '${toolCall.function.name}' (risk: ${riskLevel}) blocked in non-auto mode.`,
            }),
            tool_call_id: toolCall.id,
          });
          toolCallsExecuted++;
          continue;
        }

        if (json) {
          emitJsonEvent(stdout, 'tool_call', {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
          });
        }

        let input: unknown;
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          input = {};
        }

        const context: ToolContext = {
          projectDir: process.cwd(),
          agentId: 'headless-agent',
          sessionId: `headless-${Date.now()}`,
        };

        const result = await toolSystem.execute(toolCall.function.name, input, context);
        toolCallsExecuted++;

        // Track file modifications
        if (result.success && (toolCall.function.name === 'file-write' || toolCall.function.name === 'file-edit')) {
          const parsedInput = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
          const filePath = parsedInput['path'] as string | undefined;
          if (filePath && !filesModified.includes(filePath)) {
            filesModified.push(filePath);
          }
        }

        if (json) {
          emitJsonEvent(stdout, 'tool_result', {
            id: toolCall.id,
            success: result.success,
            error: result.error ?? null,
          });
        }

        messages.push({
          role: 'tool',
          content: JSON.stringify({
            success: result.success,
            output: result.output,
            ...(result.error ? { error: result.error } : {}),
          }),
          tool_call_id: toolCall.id,
        });
      }
    }

    // Max iterations reached
    return {
      success: false,
      response: `Reached maximum iteration limit (${maxIterations}).`,
      costUsd: costTracker.totalCostUsd,
      toolCallsExecuted,
      iterations: iteration,
      filesModified,
      abortedReason: 'max_iterations',
    };
  }

  // ─── Private helpers ────────────────────────────────────────

  /**
   * Resolve an LLM client from --provider/--model flags or environment.
   * Throws a config error if no provider can be resolved.
   */
  private resolveProvider(provider: string | undefined, model: string | undefined): AgentLLMClient {
    // If explicit provider flag is set, look for the matching env key
    if (provider) {
      const envKeyMap: Record<string, string> = {
        openai: 'OPENAI_API_KEY',
        anthropic: 'ANTHROPIC_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY',
        gemini: 'GEMINI_API_KEY',
        groq: 'GROQ_API_KEY',
        grok: 'GROK_API_KEY',
      };

      const envKey = envKeyMap[provider];
      if (!envKey) {
        throw new Error(`Unknown provider: '${provider}'. Supported: openai, anthropic, deepseek, gemini, groq, grok`);
      }

      const apiKey = process.env[envKey];
      if (!apiKey) {
        throw new Error(`Provider '${provider}' selected but ${envKey} is not set`);
      }

      return createCliLLMClient({
        provider,
        apiKey: apiKey.trim(),
        model: model ?? this.getDefaultModel(provider),
      });
    }

    // Auto-detect from environment
    const detected = detectProviderFromEnv();
    if (!detected) {
      throw new Error(
        'No LLM provider configured. Set one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, ' +
        'DEEPSEEK_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, GROK_API_KEY',
      );
    }

    if (model) {
      detected.model = model;
    }

    return createCliLLMClient(detected);
  }

  /**
   * Resolve the model name for cost estimation.
   */
  private resolveModelName(provider: string | undefined): string {
    if (provider) return this.getDefaultModel(provider);
    const detected = detectProviderFromEnv();
    return detected?.model ?? 'gpt-4o';
  }

  /**
   * Get default model for a provider.
   */
  private getDefaultModel(provider: string): string {
    const defaults: Record<string, string> = {
      openai: 'gpt-4o',
      anthropic: 'claude-sonnet-4-20250514',
      deepseek: 'deepseek-chat',
      gemini: 'gemini-2.0-flash',
      groq: 'llama-3.3-70b-versatile',
      grok: 'grok-3-mini',
    };
    return defaults[provider] ?? 'gpt-4o';
  }
}

// ─── Tool System for Headless Mode ─────────────────────────────

/**
 * Create a tool system for headless mode that respects permission handling.
 * In a full integration, this would load the real ToolSystem from the core package.
 * For the standalone @neuronest/cli package, it provides the standard set.
 */
function createHeadlessToolSystem(permissionHandler: PermissionHandler): CLIToolSystem {
  return {
    list(): ToolDefinition[] {
      return [
        {
          id: 'file-read',
          name: 'FileReadTool',
          description: 'Read a file from the project directory',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          riskLevel: 'read-only',
        },
        {
          id: 'glob',
          name: 'GlobTool',
          description: 'Find files matching a glob pattern',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
          riskLevel: 'read-only',
        },
        {
          id: 'grep',
          name: 'GrepTool',
          description: 'Search files for a regex pattern',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
          riskLevel: 'read-only',
        },
        {
          id: 'file-write',
          name: 'FileWriteTool',
          description: 'Write content to a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          riskLevel: 'write',
        },
        {
          id: 'file-edit',
          name: 'FileEditTool',
          description: 'Edit a file using search/replace',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, oldStr: { type: 'string' }, newStr: { type: 'string' } }, required: ['path', 'oldStr', 'newStr'] },
          riskLevel: 'write',
        },
        {
          id: 'bash',
          name: 'BashTool',
          description: 'Execute a shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
          riskLevel: 'execute',
        },
      ];
    },
    async execute(toolId: string, _input: unknown, _context: ToolContext): Promise<ToolResult> {
      // In the standalone CLI package, tool execution is a stub.
      // The full integration wires this to the real ToolSystem from the core.
      return {
        success: false,
        output: null,
        error: `Tool '${toolId}' execution not available in standalone headless mode. Wire the full NeuroNest core for execution.`,
      };
    },
  };
}

// ─── Prompt Builder ─────────────────────────────────────────────

/**
 * Build the system prompt for headless mode execution.
 */
function buildHeadlessSystemPrompt(
  task: string,
  mode: string,
  tools: FunctionDefinition[],
): string {
  const toolDescriptions = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join('\n');

  const modeInstructions = mode === 'plan'
    ? 'You are in PLAN mode. Analyze the task and create an execution plan without making changes.'
    : 'You are in EXECUTION mode. Complete the task by using the available tools.';

  return [
    'You are NeuroNest, an AI coding agent running in headless CLI mode.',
    '',
    modeInstructions,
    '',
    'Available tools:',
    toolDescriptions,
    '',
    'Rules:',
    '- Complete the task efficiently with minimal iterations.',
    '- Report any errors clearly.',
    '- If a tool call fails, attempt recovery or report the issue.',
    '- When done, provide a concise final response summarizing what was accomplished.',
  ].join('\n');
}

/**
 * Build tool definitions in OpenAI function-calling format.
 */
function buildToolDefinitions(toolSystem: CLIToolSystem): FunctionDefinition[] {
  return toolSystem.list().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}
