/**
 * Enhanced Tool System — Extends ToolSystem with comprehensive metadata and validation.
 *
 * Wraps the existing ToolSystem to add:
 * - usageHint metadata for tool selection guidance
 * - errorCases documentation for each tool
 * - Enhanced parameter descriptions with constraints and examples
 * - Pre-execution parameter validation with structured error responses
 *
 * Feature-gated via `production_ux_tool_robustness`:
 * - When enabled: validates parameters before execution, returns structured errors
 * - When disabled: passes through to original ToolSystem with zero overhead
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../shared/types.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { ToolSystem, type ExecutableToolDefinition } from './tool-system.js';
import {
  type EnhancedToolDefinition,
  type EnhancedParameterDefinition,
  type ErrorCaseDescription,
  validateToolParameters,
  getEnhancedToolMetadata,
} from './enhanced-tool-definitions.js';

// ─── Enhanced Tool Info (public read-only view) ─────────────────

/** Public-facing enhanced tool information for LLM tool descriptions */
export interface EnhancedToolInfo extends ToolDefinition {
  usageHint: string;
  errorCases: ErrorCaseDescription[];
  enhancedParameters: Record<string, EnhancedParameterDefinition>;
}

// ─── Enhanced Tool System ───────────────────────────────────────

export class EnhancedToolSystem {
  private toolSystem: ToolSystem;
  private featureGate: FeatureGateSystem;
  private enhancedMetadata: Map<string, {
    usageHint: string;
    errorCases: ErrorCaseDescription[];
    enhancedParameters: Record<string, EnhancedParameterDefinition>;
  }> = new Map();

  constructor(toolSystem: ToolSystem, featureGate: FeatureGateSystem) {
    this.toolSystem = toolSystem;
    this.featureGate = featureGate;

    // Load built-in enhanced metadata
    const metadata = getEnhancedToolMetadata();
    for (const [toolId, meta] of Object.entries(metadata)) {
      this.enhancedMetadata.set(toolId, meta);
    }
  }

  /**
   * Register enhanced metadata for a tool.
   * Call this after the tool is registered in ToolSystem.
   */
  registerMetadata(
    toolId: string,
    metadata: {
      usageHint: string;
      errorCases: ErrorCaseDescription[];
      enhancedParameters: Record<string, EnhancedParameterDefinition>;
    },
  ): void {
    this.enhancedMetadata.set(toolId, metadata);
  }

  /**
   * Get enhanced tool information including metadata.
   * Returns null if the tool is not registered.
   */
  getEnhanced(toolId: string): EnhancedToolInfo | null {
    const base = this.toolSystem.get(toolId);
    if (!base) return null;

    const metadata = this.enhancedMetadata.get(toolId);
    if (!metadata) {
      // Return base definition with empty enhanced fields
      return {
        ...base,
        usageHint: '',
        errorCases: [],
        enhancedParameters: {},
      };
    }

    return {
      ...base,
      usageHint: metadata.usageHint,
      errorCases: metadata.errorCases,
      enhancedParameters: metadata.enhancedParameters,
    };
  }

  /**
   * List all tools with enhanced metadata.
   */
  listEnhanced(): EnhancedToolInfo[] {
    const baseDefs = this.toolSystem.list();
    return baseDefs.map((def) => {
      const metadata = this.enhancedMetadata.get(def.id);
      return {
        ...def,
        usageHint: metadata?.usageHint || '',
        errorCases: metadata?.errorCases || [],
        enhancedParameters: metadata?.enhancedParameters || {},
      };
    });
  }

  /**
   * Execute a tool with optional parameter validation.
   * When `production_ux_tool_robustness` is enabled, validates parameters first.
   * Returns structured errors for validation failures without executing the tool.
   *
   * Requirements: 12.3, 12.4
   */
  async execute(toolId: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    // Only validate when feature gate is enabled
    if (this.featureGate.isEnabled('production_ux_tool_robustness')) {
      const metadata = this.enhancedMetadata.get(toolId);
      const baseDef = this.toolSystem.get(toolId);

      if (metadata && baseDef) {
        // Build a pseudo-EnhancedToolDefinition for validation
        const enhancedDef = {
          ...baseDef,
          usageHint: metadata.usageHint,
          errorCases: metadata.errorCases,
          enhancedParameters: metadata.enhancedParameters,
          execute: async () => ({ success: true, output: null }), // unused placeholder
        } as EnhancedToolDefinition;

        const validationError = validateToolParameters(input, enhancedDef);
        if (validationError) {
          return validationError;
        }
      }
    }

    // Delegate to original ToolSystem
    return this.toolSystem.execute(toolId, input, context);
  }

  /**
   * Proxy: get tool definition from underlying ToolSystem.
   */
  get(toolId: string): ToolDefinition | null {
    return this.toolSystem.get(toolId);
  }

  /**
   * Proxy: list all tool definitions from underlying ToolSystem.
   */
  list(): ToolDefinition[] {
    return this.toolSystem.list();
  }

  /**
   * Proxy: search tools from underlying ToolSystem.
   */
  search(query: string): ToolDefinition[] {
    return this.toolSystem.search(query);
  }

  /**
   * Proxy: register a tool in the underlying ToolSystem.
   */
  register(tool: ExecutableToolDefinition): void {
    this.toolSystem.register(tool);
  }

  /**
   * Proxy: unregister a tool from the underlying ToolSystem.
   */
  unregister(toolId: string): void {
    this.toolSystem.unregister(toolId);
    this.enhancedMetadata.delete(toolId);
  }

  /**
   * Check if the enhanced validation feature is active.
   */
  isValidationEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_tool_robustness');
  }
}
