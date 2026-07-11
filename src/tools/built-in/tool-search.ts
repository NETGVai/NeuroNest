/**
 * ToolSearch Tool — Searches available tools by keyword via the ToolSystem.
 *
 * Factory function `createToolSearchExecute` accepts the ToolSystem dependency
 * and returns a tool execute function that queries registered tools by keyword,
 * returning matching tools as `{ id, name, description }` objects.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';
import type { ToolDependencies } from './tool-dependencies.js';
import { safeExecute, type FieldSchema } from './input-validator.js';

// ─── Input Interface ────────────────────────────────────────────

export interface ToolSearchInput {
  query: string;
}

// ─── Input Schema ───────────────────────────────────────────────

const toolSearchSchema: FieldSchema[] = [
  { name: 'query', type: 'string', required: true },
];

// ─── Factory Function ───────────────────────────────────────────

/**
 * Creates the ToolSearch tool execute function.
 *
 * @param deps - Dependency injection containing the ToolSystem instance
 * @returns A tool execute function conforming to (input: unknown, context: ToolContext) => Promise<ToolResult>
 */
export function createToolSearchExecute(
  deps: Pick<ToolDependencies, 'toolSystem'>,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return safeExecute<ToolSearchInput>(toolSearchSchema, async (input, _context) => {
    const { query } = input;

    // Check that ToolSystem is available
    if (!deps.toolSystem) {
      return {
        success: false,
        output: null,
        error: 'ToolSystem is unavailable',
      };
    }

    // Call ToolSystem.search(query) and map results to { id, name, description }
    const results = deps.toolSystem.search(query);

    const tools = results.map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
    }));

    return {
      success: true,
      output: tools,
    };
  });
}
