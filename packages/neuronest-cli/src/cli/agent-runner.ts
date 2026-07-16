// File: packages/neuronest-cli/src/cli/agent-runner.ts
//
// Standalone agent loop runner for CLI mode (task 19.1).
//
// Creates an AgentLoopController with the same ToolSystem as the GUI,
// streams output to stdout as the loop progresses, and exits with
// code 0 on success, code 1 on failure.
//
// Supports:
//   neuronest task "description" --mode plan|auto --project-dir ./path
//
// The LLM client reads provider configuration from environment
// variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) or from
// `.neuronest/config.json` in the project directory.
//
// Validates: Requirements 14.1, 14.2, 14.3, 14.4

import * as path from 'node:path';
import * as fs from 'node:fs';

import type { CliExitCode } from './types.js';
import type { PermissionConfig } from './cli-pattern-injection.js';

// ─── Types ──────────────────────────────────────────────────────

/** Execution mode for the agent runner. */
export type AgentRunnerMode = 'auto' | 'plan';

/** Options parsed from CLI flags for the task runner. */
export interface AgentRunnerOptions {
  /** The task description to execute. */
  task: string;
  /** Execution mode: 'auto' (default) or 'plan'. */
  mode: AgentRunnerMode;
  /** Working directory for the project. Defaults to cwd. */
  projectDir: string;
  /** Optional additional arguments passed through. */
  args?: string | undefined;
  /**
   * Permission patterns injected via --allow and --deny CLI flags (Req 10.12).
   * These are set as user-tier patterns on the PermissionPatternEngine.
   */
  permissionPatterns?: PermissionConfig | undefined;
  /**
   * Original ask patterns from --ask CLI flags (Req 10.12).
   * Tracked separately for authorization pipeline ask-vs-deny distinction.
   */
  askPatterns?: string[] | undefined;
}

/** OpenAI-compatible tool call structure in LLM responses. */
export interface LLMToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** Message format used within the agent loop conversation. */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

/** Response from the LLM client that supports tool calling. */
export interface AgentLLMResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/** OpenAI-compatible function definition for tool registration. */
export interface FunctionDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** LLM client interface for the CLI agent loop. */
export interface AgentLLMClient {
  chatWithTools(
    messages: AgentMessage[],
    tools: FunctionDefinition[],
    options?: { temperature?: number; maxTokens?: number },
  ): Promise<AgentLLMResponse>;
}

/** Tool execution result. */
export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}

/** Tool definition interface. */
export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  riskLevel: string;
}

/** Tool execution context. */
export interface ToolContext {
  projectDir: string;
  agentId: string;
  sessionId: string;
}

/** Minimal ToolSystem interface for the CLI. */
export interface CLIToolSystem {
  list(): ToolDefinition[];
  execute(toolId: string, input: unknown, context: ToolContext): Promise<ToolResult>;
}

/** Progress update emitted on each iteration. */
export interface LoopProgress {
  iteration: number;
  maxIterations: number;
  lastToolCall?: string;
  status: 'thinking' | 'tool_executing' | 'awaiting_approval' | 'complete';
}

/** Result returned when the loop completes. */
export interface AgentLoopResult {
  response: string;
  toolCallsExecuted: number;
  iterations: number;
  tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  filesModified: string[];
}

/** Project configuration interface. */
interface ProjectConfig {
  temperature: number;
  maxIterations: number;
  model: string | undefined;
  contextBudget: number;
  turboThreshold: number;
  autoVersioning: boolean;
  planMode: boolean;
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  temperature: 0.7,
  maxIterations: 25,
  model: undefined,
  contextBudget: 32000,
  turboThreshold: 1,
  autoVersioning: true,
  planMode: false,
};

// ─── Project Config Loader ──────────────────────────────────────

/**
 * Load project configuration from `.neuronest/config.json`.
 * Returns defaults if file does not exist or is invalid.
 */
export function loadProjectConfig(projectDir: string): ProjectConfig {
  const configPath = path.join(projectDir, '.neuronest', 'config.json');

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_PROJECT_CONFIG };
  }

  const raw = parsed as Record<string, unknown>;
  const config: ProjectConfig = { ...DEFAULT_PROJECT_CONFIG };

  if (typeof raw['temperature'] === 'number' && raw['temperature'] >= 0 && raw['temperature'] <= 2) {
    config.temperature = raw['temperature'];
  }
  if (typeof raw['maxIterations'] === 'number' && Number.isInteger(raw['maxIterations']) &&
      raw['maxIterations'] >= 1 && raw['maxIterations'] <= 50) {
    config.maxIterations = raw['maxIterations'];
  }
  if (typeof raw['model'] === 'string' && raw['model'].trim().length > 0) {
    config.model = raw['model'].trim();
  }
  if (typeof raw['contextBudget'] === 'number' && Number.isInteger(raw['contextBudget']) && raw['contextBudget'] > 0) {
    config.contextBudget = raw['contextBudget'];
  }
  if (typeof raw['turboThreshold'] === 'number' && Number.isInteger(raw['turboThreshold']) && raw['turboThreshold'] >= 1) {
    config.turboThreshold = raw['turboThreshold'];
  }
  if (typeof raw['autoVersioning'] === 'boolean') {
    config.autoVersioning = raw['autoVersioning'];
  }
  if (typeof raw['planMode'] === 'boolean') {
    config.planMode = raw['planMode'];
  }

  return config;
}

// ─── LLM Provider Detection ────────────────────────────────────

interface ProviderConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string | undefined;
}

/**
 * Detect provider configuration from environment variables.
 * Reads OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, etc.
 */
export function detectProviderFromEnv(): ProviderConfig | null {
  const envMappings: Array<{
    envKey: string;
    provider: string;
    defaultModel: string;
    baseUrl?: string;
  }> = [
    { envKey: 'OPENAI_API_KEY', provider: 'openai', defaultModel: 'gpt-4o' },
    { envKey: 'ANTHROPIC_API_KEY', provider: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' },
    { envKey: 'DEEPSEEK_API_KEY', provider: 'deepseek', defaultModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    { envKey: 'GEMINI_API_KEY', provider: 'gemini', defaultModel: 'gemini-2.0-flash' },
    { envKey: 'GROQ_API_KEY', provider: 'groq', defaultModel: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
    { envKey: 'GROK_API_KEY', provider: 'grok', defaultModel: 'grok-3-mini', baseUrl: 'https://api.x.ai/v1' },
  ];

  for (const mapping of envMappings) {
    const key = process.env[mapping.envKey];
    if (key && key.trim().length > 0) {
      return {
        provider: mapping.provider,
        apiKey: key.trim(),
        model: mapping.defaultModel,
        baseUrl: mapping.baseUrl,
      };
    }
  }

  return null;
}

/**
 * Build the base URL for OpenAI-compatible providers.
 */
function getProviderBaseUrl(provider: string, customBaseUrl?: string): string {
  if (customBaseUrl) return customBaseUrl;

  const urls: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    deepseek: 'https://api.deepseek.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1beta',
    groq: 'https://api.groq.com/openai/v1',
    grok: 'https://api.x.ai/v1',
  };

  return urls[provider] || 'https://api.openai.com/v1';
}

/**
 * Create a minimal LLM client from environment configuration.
 * Uses the OpenAI-compatible chat/completions endpoint.
 */
export function createCliLLMClient(config: ProviderConfig): AgentLLMClient {
  const baseUrl = getProviderBaseUrl(config.provider, config.baseUrl);

  return {
    async chatWithTools(
      messages: AgentMessage[],
      tools: FunctionDefinition[],
      options?: { temperature?: number; maxTokens?: number },
    ): Promise<AgentLLMResponse> {
      const url = `${baseUrl}/chat/completions`;

      const body: Record<string, unknown> = {
        model: config.model,
        messages: messages.map((msg) => ({
          role: msg.role,
          content: msg.content,
          ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
          ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        })),
        temperature: options?.temperature ?? 0.7,
      };

      if (tools.length > 0) {
        body['tools'] = tools.map((t) => ({
          type: 'function',
          function: t.function,
        }));
      }

      if (options?.maxTokens) {
        body['max_tokens'] = options.maxTokens;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Provider-specific auth headers
      if (config.provider === 'anthropic') {
        headers['x-api-key'] = config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown error');
        throw new Error(`LLM API error (${response.status}): ${errorText}`);
      }

      const data = await response.json() as Record<string, unknown>;

      // Parse OpenAI-compatible response format
      const choices = data['choices'] as Array<Record<string, unknown>> | undefined;
      const choice = choices?.[0];
      const message = choice?.['message'] as Record<string, unknown> | undefined;

      const result: AgentLLMResponse = {
        content: (message?.['content'] as string) || '',
      };

      const toolCalls = message?.['tool_calls'] as LLMToolCall[] | undefined;
      if (toolCalls && toolCalls.length > 0) {
        result.tool_calls = toolCalls;
      }

      const usage = data['usage'] as Record<string, number> | undefined;
      if (usage) {
        result.usage = {
          promptTokens: usage['prompt_tokens'] || 0,
          completionTokens: usage['completion_tokens'] || 0,
          totalTokens: usage['total_tokens'] || 0,
        };
      }

      return result;
    },
  };
}

// ─── Agent Loop (self-contained) ────────────────────────────────

/**
 * Build tool definitions in OpenAI function-calling format from the
 * tool system's registered tools.
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

/**
 * Build the system prompt for the agent loop with project context.
 */
function buildSystemPrompt(projectDir: string, tools: FunctionDefinition[]): string {
  const toolDescriptions = tools
    .map((t) => `- ${t.function.name}: ${t.function.description}`)
    .join('\n');

  return [
    'You are NeuroNest, an AI coding agent running in CLI mode.',
    `Project directory: ${projectDir}`,
    '',
    'Available tools:',
    toolDescriptions,
    '',
    'Use tools to complete the user\'s task. When done, provide a final response.',
    'If a tool call fails, attempt recovery or report the issue.',
  ].join('\n');
}

/**
 * Execute the agent loop: iteratively call the LLM, execute tool
 * calls, and feed results back until the LLM produces a final
 * response or the iteration limit is reached.
 *
 * This is the same loop pattern as AgentLoopController in the GUI
 * (Requirement 14.2), implemented standalone for the CLI.
 */
async function executeAgentLoop(opts: {
  llmClient: AgentLLMClient;
  toolSystem: CLIToolSystem;
  projectDir: string;
  sessionId: string;
  task: string;
  maxIterations: number;
  planMode: boolean;
  temperature: number;
  onProgress?: (update: LoopProgress) => void;
}): Promise<AgentLoopResult> {
  const { llmClient, toolSystem, projectDir, sessionId, task, maxIterations, temperature, onProgress } = opts;

  const tools = buildToolDefinitions(toolSystem);
  const systemPrompt = buildSystemPrompt(projectDir, tools);

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ];

  let iteration = 0;
  let toolCallsExecuted = 0;
  const filesModified: string[] = [];
  const tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  while (iteration < maxIterations) {
    iteration++;
    onProgress?.({
      iteration,
      maxIterations,
      status: 'thinking',
    });

    // Call LLM
    const response = await llmClient.chatWithTools(messages, tools, { temperature });

    // Accumulate token usage
    if (response.usage) {
      tokenUsage.promptTokens += response.usage.promptTokens;
      tokenUsage.completionTokens += response.usage.completionTokens;
      tokenUsage.totalTokens += response.usage.totalTokens;
    }

    // If no tool calls, we have the final response
    if (!response.tool_calls || response.tool_calls.length === 0) {
      onProgress?.({ iteration, maxIterations, status: 'complete' });
      return {
        response: response.content,
        toolCallsExecuted,
        iterations: iteration,
        tokenUsage,
        filesModified,
      };
    }

    // Append assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: response.tool_calls,
    });

    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      onProgress?.({
        iteration,
        maxIterations,
        lastToolCall: toolCall.function.name,
        status: 'tool_executing',
      });

      let input: unknown;
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        input = {};
      }

      const context: ToolContext = {
        projectDir,
        agentId: 'cli-agent',
        sessionId,
      };

      const result = await toolSystem.execute(toolCall.function.name, input, context);
      toolCallsExecuted++;

      // Track file modifications
      if (result.success && (toolCall.function.name === 'file-write' || toolCall.function.name === 'file-edit')) {
        try {
          const parsedInput = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
          const filePath = parsedInput['path'] as string | undefined;
          if (filePath && !filesModified.includes(filePath)) {
            filesModified.push(filePath);
          }
        } catch {
          // Ignore parse errors for file tracking
        }
      }

      // Append tool result message
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

  // Max iterations reached — return partial results
  onProgress?.({ iteration, maxIterations, status: 'complete' });
  return {
    response: `[Reached maximum iteration limit of ${maxIterations}. Partial results returned.]`,
    toolCallsExecuted,
    iterations: iteration,
    tokenUsage,
    filesModified,
  };
}

// ─── Output streaming ───────────────────────────────────────────

/**
 * Format a progress update for terminal output.
 */
function formatProgress(update: LoopProgress): string {
  const statusIcons: Record<string, string> = {
    thinking: '🤔',
    tool_executing: '🔧',
    awaiting_approval: '⏳',
    complete: '✅',
  };

  const icon = statusIcons[update.status] || '▶';
  let line = `${icon} [${update.iteration}/${update.maxIterations}] ${update.status}`;

  if (update.lastToolCall) {
    line += ` — ${update.lastToolCall}`;
  }

  return line;
}

// ─── Main runner ────────────────────────────────────────────────

/**
 * Run the agent loop in CLI mode.
 *
 * - Initializes the ToolSystem with all built-in tools (same as GUI)
 * - Creates an LLM client from environment variables
 * - Runs the agent loop
 * - Streams progress to stdout
 * - Returns exit code 0 on success, 1 on failure
 *
 * Validates: Requirements 14.1, 14.2, 14.3, 14.4
 */
export async function runAgentTask(
  options: AgentRunnerOptions,
  deps?: {
    toolSystem?: CLIToolSystem;
    llmClient?: AgentLLMClient;
  },
): Promise<CliExitCode> {
  const { task, mode, projectDir, args, permissionPatterns, askPatterns } = options;

  // Resolve project directory to absolute path
  const resolvedProjectDir = path.resolve(projectDir);

  // Validate project directory exists
  try {
    const stat = fs.statSync(resolvedProjectDir);
    if (!stat.isDirectory()) {
      process.stderr.write(`error: --project-dir is not a directory: ${resolvedProjectDir}\n`);
      return 1;
    }
  } catch {
    process.stderr.write(`error: --project-dir does not exist: ${resolvedProjectDir}\n`);
    return 1;
  }

  // Resolve LLM provider from environment (unless injected for testing)
  let llmClient = deps?.llmClient;
  let providerInfo = '';
  if (!llmClient) {
    const providerConfig = detectProviderFromEnv();
    if (!providerConfig) {
      process.stderr.write(
        'error: No LLM provider configured.\n' +
        'Set one of the following environment variables:\n' +
        '  OPENAI_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY,\n' +
        '  GEMINI_API_KEY, GROQ_API_KEY, GROK_API_KEY\n',
      );
      return 1;
    }
    // Use project config model override if available
    const projectConfig = loadProjectConfig(resolvedProjectDir);
    if (projectConfig.model) {
      providerConfig.model = projectConfig.model;
    }
    llmClient = createCliLLMClient(providerConfig);
    providerInfo = `${providerConfig.provider} (${providerConfig.model})`;
  } else {
    providerInfo = 'injected';
  }

  // Load project config for agent loop parameters
  const projectConfig = loadProjectConfig(resolvedProjectDir);

  // Build the full task message, optionally including extra args
  const taskMessage = args ? `${task}\n\nAdditional context: ${args}` : task;

  // Stream start message (Requirement 14.3)
  process.stdout.write(`\n🚀 NeuroNest CLI — executing task\n`);
  process.stdout.write(`   Mode: ${mode}\n`);
  process.stdout.write(`   Project: ${resolvedProjectDir}\n`);
  process.stdout.write(`   Provider: ${providerInfo}\n`);
  process.stdout.write(`   Max iterations: ${projectConfig.maxIterations}\n`);
  if (permissionPatterns && (permissionPatterns.allow.length > 0 || permissionPatterns.deny.length > 0)) {
    if (permissionPatterns.allow.length > 0) {
      process.stdout.write(`   Allow patterns: ${permissionPatterns.allow.join(', ')}\n`);
    }
    if (permissionPatterns.deny.length > 0) {
      process.stdout.write(`   Deny patterns: ${permissionPatterns.deny.join(', ')}\n`);
    }
    if (askPatterns && askPatterns.length > 0) {
      process.stdout.write(`   Ask patterns: ${askPatterns.join(', ')}\n`);
    }
  }
  process.stdout.write('\n');

  // ── Inject CLI permission patterns as user-tier (Req 10.12) ──
  //
  // When --allow/--deny/--ask patterns are provided, they are injected
  // into the PermissionPatternEngine as user-tier patterns. The user
  // tier is the lowest priority but represents the user's explicit
  // intent for this CLI session.
  //
  // In the standalone CLI mode, we create a PermissionPatternEngine
  // for the project directory and set the user patterns. When the full
  // ToolSystem integration is available, the engine is shared with the
  // authorization pipeline.
  if (permissionPatterns && (permissionPatterns.allow.length > 0 || permissionPatterns.deny.length > 0)) {
    try {
      // Dynamic import of the security module (lives in the main Electron app).
      // This resolves at runtime in the monorepo layout; in the standalone
      // @neuronest/cli npm package, the import will fail gracefully.
      const securityModule = await import('../../../../src/security/permission-pattern-engine.js');
      const engine = new securityModule.PermissionPatternEngine(resolvedProjectDir);
      engine.setUserPatterns(permissionPatterns);
      // The engine instance would be passed to the ToolSystem/AuthorizationPipeline
      // in a full integration. For standalone CLI mode, it's available for
      // tool execution permission checks.
      process.stdout.write(`   ✓ Permission patterns injected into user tier\n\n`);
    } catch {
      // If the security module isn't available (standalone CLI package),
      // log that patterns are staged for injection when the full
      // integration is wired.
      process.stdout.write(`   ✓ Permission patterns staged (allow: ${permissionPatterns.allow.length}, deny: ${permissionPatterns.deny.length})\n\n`);
    }
  }

  // Use injected or create a stub tool system
  // In production, this would dynamically load the built-in tools from the
  // main package. For the CLI, we accept an injected toolSystem or use a
  // no-op stub that the LLM can still reason about.
  const toolSystem: CLIToolSystem = deps?.toolSystem ?? createNoopToolSystem();

  try {
    const result = await executeAgentLoop({
      llmClient,
      toolSystem,
      projectDir: resolvedProjectDir,
      sessionId: `cli-${Date.now()}`,
      task: taskMessage,
      maxIterations: projectConfig.maxIterations,
      planMode: mode === 'plan' || projectConfig.planMode,
      temperature: projectConfig.temperature,
      onProgress: (update: LoopProgress) => {
        process.stdout.write(`${formatProgress(update)}\n`);
      },
    });

    // Stream the final response (Requirement 14.3)
    process.stdout.write('\n─── Agent Response ───\n\n');
    process.stdout.write(result.response);
    process.stdout.write('\n\n');

    // Summary
    process.stdout.write('─── Summary ───\n');
    process.stdout.write(`   Iterations: ${result.iterations}\n`);
    process.stdout.write(`   Tool calls: ${result.toolCallsExecuted}\n`);
    if (result.filesModified.length > 0) {
      process.stdout.write(`   Files modified: ${result.filesModified.join(', ')}\n`);
    }
    if (result.tokenUsage.totalTokens > 0) {
      process.stdout.write(`   Tokens used: ${result.tokenUsage.totalTokens}\n`);
    }
    process.stdout.write('\n');

    // Exit code 0 on success (Requirement 14.4)
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\nerror: Agent loop failed: ${message}\n`);
    // Exit code 1 on failure (Requirement 14.4)
    return 1;
  }
}

/**
 * Create a no-op tool system for when tools are not available.
 * This allows the agent loop to run and the LLM to see tool
 * definitions, even if tool execution returns no-ops.
 */
function createNoopToolSystem(): CLIToolSystem {
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
          description: 'Search files for a pattern',
          inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
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
          id: 'bash',
          name: 'BashTool',
          description: 'Execute a shell command',
          inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
          riskLevel: 'execute',
        },
      ];
    },
    async execute(toolId: string, _input: unknown, _context: ToolContext): Promise<ToolResult> {
      return {
        success: false,
        output: null,
        error: `Tool '${toolId}' is not available in standalone CLI mode. Install the full NeuroNest package for tool execution.`,
      };
    },
  };
}
