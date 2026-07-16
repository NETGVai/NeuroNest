/**
 * Tool System — Modular tool registration, schema validation, execution.
 *
 * Implements register, unregister, get, list, search, execute with:
 * - Zod schema validation on tool registration
 * - AuthorizationPipeline as sole authorization gate before execution (Req 1.3)
 * - Lazy loading pattern (tools registered but not loaded until first use)
 *
 * ToolSystem.execute is the SINGLE invocation path for every tool capability (Req 1.1).
 * No tool-execution side channel bypasses this method (Req 1.2).
 *
 * Requirements: 1.1, 1.2, 1.3, 10.9, 15.1, 15.12, 15.15
 */

import { z } from 'zod';
import { PermissionSystem } from '../security/permission-system.js';
import {
  AuthorizationPipeline,
  type AuthorizationPipelineConfig,
  type AuthDecision,
} from '../security/authorization-pipeline.js';
import type {
  ToolDefinition,
  ToolCall,
  ToolContext,
  ToolResult,
} from '../shared/types.js';

// ─── Extended ToolDefinition with execute function ──────────────

export interface ExecutableToolDefinition extends ToolDefinition {
  execute: (input: unknown, context: ToolContext) => Promise<ToolResult>;
}

// ─── Lazy-loaded tool wrapper ───────────────────────────────────

interface LazyTool {
  definition: ToolDefinition;
  execute?: (input: unknown, context: ToolContext) => Promise<ToolResult>;
  loaded: boolean;
  loader?: () => Promise<(input: unknown, context: ToolContext) => Promise<ToolResult>>;
}

// ─── Validation schema for ToolDefinition registration ──────────

const toolDefinitionValidationSchema = z.object({
  id: z.string().min(1, 'Tool id is required'),
  name: z.string().min(1, 'Tool name is required'),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()).refine(
    (schema) => typeof schema === 'object' && schema !== null,
    { message: 'inputSchema must be a valid object' },
  ),
  riskLevel: z.enum(['read-only', 'write', 'execute', 'destructive']),
});

// ─── ToolSystem ─────────────────────────────────────────────────

export class ToolSystem {
  private tools = new Map<string, LazyTool>();
  private readonly _permissionSystem: PermissionSystem;
  private authorizationPipeline: AuthorizationPipeline;

  constructor(permissionSystem: PermissionSystem, pipelineConfig?: AuthorizationPipelineConfig) {
    this._permissionSystem = permissionSystem;

    // Wire PermissionSystem as the audit sink for all pipeline decisions (Req 10.9).
    // Every decision records: verdict, stage, reason, project, session, agent, tool, args, timestamp.
    this.authorizationPipeline = new AuthorizationPipeline({
      ...pipelineConfig,
      auditSink: permissionSystem,
    });
  }

  /** Access the underlying PermissionSystem (audit sink for the pipeline). */
  get permissionSystem(): PermissionSystem {
    return this._permissionSystem;
  }

  /**
   * Register a tool. Validates the definition schema before accepting.
   * Throws if the schema is invalid or the tool id is already registered.
   */
  register(tool: ExecutableToolDefinition): void {
    // Validate the tool definition using Zod
    const result = toolDefinitionValidationSchema.safeParse(tool);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join('; ');
      throw new Error(`Invalid tool definition: ${message}`);
    }

    if (this.tools.has(tool.id)) {
      throw new Error(`Tool already registered: ${tool.id}`);
    }

    this.tools.set(tool.id, {
      definition: {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        riskLevel: tool.riskLevel,
      },
      execute: tool.execute,
      loaded: true,
    });
  }

  /**
   * Register a tool with lazy loading — the execute function is loaded on first use.
   */
  registerLazy(
    definition: ToolDefinition,
    loader: () => Promise<(input: unknown, context: ToolContext) => Promise<ToolResult>>,
  ): void {
    const result = toolDefinitionValidationSchema.safeParse(definition);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join('; ');
      throw new Error(`Invalid tool definition: ${message}`);
    }

    if (this.tools.has(definition.id)) {
      throw new Error(`Tool already registered: ${definition.id}`);
    }

    this.tools.set(definition.id, {
      definition,
      loaded: false,
      loader,
    });
  }

  /** Unregister a tool by id. */
  unregister(toolId: string): void {
    this.tools.delete(toolId);
  }

  /** Get a tool definition by id, or null if not found. */
  get(toolId: string): ToolDefinition | null {
    const tool = this.tools.get(toolId);
    return tool?.definition ?? null;
  }

  /** List all registered tool definitions. */
  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Search tools by query string (matches id, name, or description). */
  search(query: string): ToolDefinition[] {
    const lower = query.toLowerCase();
    return this.list().filter(
      (t) =>
        t.id.toLowerCase().includes(lower) ||
        t.name.toLowerCase().includes(lower) ||
        t.description.toLowerCase().includes(lower),
    );
  }

  /**
   * Execute a tool by id. Authorization decisions flow through the AuthorizationPipeline
   * (Req 1.3) — this is the SOLE authorization gate in front of tool execution.
   *
   * ToolSystem.execute is the SINGLE invocation path for all tool capabilities (Req 1.1).
   * No side channel bypasses this method (Req 1.2).
   *
   * Possible pipeline verdicts:
   *   - 'deny'  → return error with reason
   *   - 'allow' → proceed to execution
   *   - 'ask'   → route to existing approval flow via approvalHandler
   */
  async execute(toolId: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return { success: false, output: null, error: `Tool not found: ${toolId}` };
    }

    // Build the ToolCall structure expected by the pipeline
    const call: ToolCall = {
      id: `${toolId}-${Date.now()}`,
      name: toolId,
      arguments: typeof input === 'string' ? input : JSON.stringify(input),
    };

    // Authorize through the pipeline — the ONLY authorization gate (Req 1.3)
    const decision: AuthDecision = await this.authorizationPipeline.authorize(call, {
      ...context,
      riskLevel: tool.definition.riskLevel,
    });

    // Handle decision verdicts
    switch (decision.verdict) {
      case 'deny':
        return {
          success: false,
          output: null,
          error: `Permission denied: ${decision.reason}`,
        };

      case 'ask': {
        // Route 'ask' decisions to the existing approval flow (AWAITING_APPROVAL)
        const { promptContext } = decision;
        if (context.approvalHandler) {
          const approved = await context.approvalHandler(
            `${promptContext.toolName}: ${promptContext.reason}`,
          );
          if (!approved) {
            return {
              success: false,
              output: null,
              error: `Permission denied: user rejected ${promptContext.toolName} (${promptContext.reason})`,
            };
          }
          // User approved — fall through to execution
        } else if (context.permissionMode !== 'auto-approve') {
          // No approval handler and not in auto-approve mode: deny
          return {
            success: false,
            output: null,
            error: `Permission denied: ${promptContext.reason} (no approval handler available)`,
          };
        }
        // If auto-approve mode with no handler, allow (shouldn't normally reach here
        // since mode-policy would have returned 'allow', but defensive)
        break;
      }

      case 'allow':
        // Proceed to execution
        break;
    }

    // Lazy load if needed
    if (!tool.loaded && tool.loader) {
      tool.execute = await tool.loader();
      tool.loaded = true;
    }

    if (!tool.execute) {
      return { success: false, output: null, error: `Tool has no execute function: ${toolId}` };
    }

    try {
      return await tool.execute(input, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: message };
    }
  }
}
