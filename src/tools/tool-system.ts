/**
 * Tool System — Modular tool registration, schema validation, execution.
 *
 * Implements register, unregister, get, list, search, execute with:
 * - Zod schema validation on tool registration
 * - Permission checks before every tool execution
 * - Lazy loading pattern (tools registered but not loaded until first use)
 *
 * Requirements: 15.1, 15.12, 15.15
 */

import { z } from 'zod';
import { PermissionSystem } from '../security/permission-system.js';
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
  RiskLevel,
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

const validRiskLevels: RiskLevel[] = ['read-only', 'write', 'execute', 'destructive'];

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
  private permissionSystem: PermissionSystem;

  constructor(permissionSystem: PermissionSystem) {
    this.permissionSystem = permissionSystem;
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
   * Execute a tool by id. Checks permissions first, then runs the tool.
   * Lazy-loaded tools are loaded on first execution.
   */
  async execute(toolId: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return { success: false, output: null, error: `Tool not found: ${toolId}` };
    }

    // Permission check
    const decision = await this.permissionSystem.check({
      toolId,
      agentId: context.agentId,
      input,
      riskLevel: tool.definition.riskLevel,
    });

    if (!decision.allowed) {
      return {
        success: false,
        output: null,
        error: `Permission denied: ${decision.reason}`,
      };
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
