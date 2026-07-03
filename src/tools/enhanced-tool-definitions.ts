/**
 * Enhanced Tool Definitions — Comprehensive metadata and parameter validation.
 *
 * Extends the existing ToolDefinition/ExecutableToolDefinition with:
 * - usageHint: one-line when-to-use/when-not-to-use for each tool
 * - errorCases: explicit failure conditions documented per tool
 * - Enhanced parameter descriptions with constraints and examples
 * - Pre-execution parameter validation returning structured errors
 *
 * Feature-gated via `production_ux_tool_robustness`.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from './tool-system.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Enhanced Type Definitions ──────────────────────────────────

/** Describes a known error condition a tool can encounter */
export interface ErrorCaseDescription {
  /** Human-readable condition that triggers this error */
  condition: string;
  /** The error message returned when this condition is met */
  errorMessage: string;
}

/** Enhanced parameter definition with constraints and examples */
export interface EnhancedParameterDefinition {
  type: string;
  description: string;
  /** Validation constraints (e.g., "non-empty string", "positive integer", "valid glob pattern") */
  constraints?: string;
  /** Example value for this parameter */
  example?: string;
  /** Allowed enum values if parameter is constrained to a set */
  enum?: string[];
}

/** Enhanced tool definition with comprehensive metadata */
export interface EnhancedToolDefinition extends ExecutableToolDefinition {
  /** One-line summary: when to use and when NOT to use this tool */
  usageHint: string;
  /** Documented error cases the tool can return */
  errorCases: ErrorCaseDescription[];
  /** Enhanced input schema with constraints and examples per parameter */
  enhancedParameters: Record<string, EnhancedParameterDefinition>;
}

/** Structured error returned when parameter validation fails */
export interface ParameterValidationError {
  success: false;
  output: null;
  error: string;
  validationDetails: {
    parameterName: string;
    issue: 'missing' | 'invalid_type' | 'constraint_violation';
    expectedType: string | undefined;
    constraints: string | undefined;
    acceptableValues: string | undefined;
  };
}

// ─── Parameter Validation ───────────────────────────────────────

/**
 * Validates tool parameters against the enhanced schema before execution.
 * Returns a structured error identifying the failed parameter and acceptable values.
 *
 * Requirements: 12.3, 12.4
 */
export function validateToolParameters(
  input: unknown,
  tool: EnhancedToolDefinition,
): ParameterValidationError | null {
  const params = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const schema = tool.inputSchema as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };

  // Check required fields
  const requiredFields = schema.required || [];
  for (const field of requiredFields) {
    if (params[field] === undefined || params[field] === null || params[field] === '') {
      const enhanced = tool.enhancedParameters[field];
      return {
        success: false,
        output: null,
        error: `Missing required parameter: '${field}'. ${enhanced?.constraints || `Expected: ${enhanced?.type || 'string'}`}${enhanced?.example ? `. Example: ${enhanced.example}` : ''}`,
        validationDetails: {
          parameterName: field,
          issue: 'missing',
          expectedType: enhanced?.type,
          constraints: enhanced?.constraints,
          acceptableValues: enhanced?.example,
        },
      };
    }
  }

  // Type and constraint validation for provided parameters
  const properties = schema.properties || {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const propSchema = properties[key];
    if (!propSchema) continue;

    const enhanced = tool.enhancedParameters[key];
    const expectedType = enhanced?.type || propSchema.type;

    // Type validation
    if (expectedType) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      const typeValid = validateType(value, expectedType);
      if (!typeValid) {
        return {
          success: false,
          output: null,
          error: `Invalid type for parameter '${key}': expected ${expectedType}, got ${actualType}.${enhanced?.constraints ? ` Constraints: ${enhanced.constraints}` : ''}${enhanced?.example ? ` Example: ${enhanced.example}` : ''}`,
          validationDetails: {
            parameterName: key,
            issue: 'invalid_type',
            expectedType,
            constraints: enhanced?.constraints,
            acceptableValues: enhanced?.example,
          },
        };
      }
    }

    // Enum constraint validation
    if (enhanced?.enum && enhanced.enum.length > 0) {
      if (!enhanced.enum.includes(String(value))) {
        return {
          success: false,
          output: null,
          error: `Invalid value for parameter '${key}': '${String(value)}'. Acceptable values: ${enhanced.enum.join(', ')}`,
          validationDetails: {
            parameterName: key,
            issue: 'constraint_violation',
            expectedType: enhanced.type,
            constraints: enhanced.constraints,
            acceptableValues: enhanced.enum.join(', '),
          },
        };
      }
    }
  }

  return null;
}

/**
 * Validates that a value matches the expected JSON Schema type.
 */
function validateType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number' && !isNaN(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true; // Unknown types pass through
  }
}

// ─── Enhanced Tool Wrapper ──────────────────────────────────────

/**
 * Wraps tool execution with parameter validation when the feature gate is enabled.
 * When disabled, passes through to the original execute function without overhead.
 *
 * Requirements: 12.3, 12.4, 12.5
 */
export function createValidatingExecutor(
  tool: EnhancedToolDefinition,
  featureGate: FeatureGateSystem,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  const originalExecute = tool.execute;

  return async (input: unknown, context: ToolContext): Promise<ToolResult> => {
    // Only validate when feature gate is enabled
    if (featureGate.isEnabled('production_ux_tool_robustness')) {
      const validationError = validateToolParameters(input, tool);
      if (validationError) {
        return validationError;
      }
    }

    return originalExecute(input, context);
  };
}

// ─── Enhanced Built-in Tool Definitions ─────────────────────────

/**
 * Returns enhanced metadata for all built-in tools.
 * These definitions include usageHint, errorCases, and enhanced parameter descriptions.
 *
 * Requirements: 12.1, 12.2, 12.5
 */
export function getEnhancedToolMetadata(): Record<string, Omit<EnhancedToolDefinition, keyof ExecutableToolDefinition>> {
  return {
    'bash': {
      usageHint: 'Use for shell command execution (build, test, install). Do NOT use for file reads/writes — use file-read/file-write tools instead.',
      errorCases: [
        { condition: 'Command not found in PATH', errorMessage: 'Failed to execute command: command not found' },
        { condition: 'Command exceeds timeout', errorMessage: 'Command timed out after {timeout/1000}s' },
        { condition: 'Working directory outside project', errorMessage: 'Access denied: working directory is outside project directory' },
        { condition: 'User rejects command', errorMessage: 'Command rejected by user' },
        { condition: 'No project directory in context', errorMessage: 'No project directory set in context' },
      ],
      enhancedParameters: {
        command: {
          type: 'string',
          description: 'Shell command to execute',
          constraints: 'Non-empty string. Must be a valid shell command.',
          example: 'npm run test -- --run',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000)',
          constraints: 'Positive integer. Minimum recommended: 1000.',
          example: '30000',
        },
        cwd: {
          type: 'string',
          description: 'Working directory relative to project root',
          constraints: 'Must resolve to a path within the project directory.',
          example: 'src/tests',
        },
      },
    },
    'file-read': {
      usageHint: 'Use to read file contents for inspection or context. Do NOT use for binary files or files outside the project.',
      errorCases: [
        { condition: 'File does not exist', errorMessage: 'File not found: {path}' },
        { condition: 'Path is outside project directory', errorMessage: 'Access denied: path is outside project directory' },
        { condition: 'Path points to a directory', errorMessage: 'Not a file: {path}' },
        { condition: 'No project directory in context', errorMessage: 'No project directory set in context' },
      ],
      enhancedParameters: {
        path: {
          type: 'string',
          description: 'Relative or absolute path to the file',
          constraints: 'Non-empty string. Must resolve within the project directory.',
          example: 'src/index.ts',
        },
        maxBytes: {
          type: 'number',
          description: 'Maximum bytes to read (default: 1MB)',
          constraints: 'Positive integer. Files exceeding this limit are truncated.',
          example: '524288',
        },
      },
    },
    'file-write': {
      usageHint: 'Use to create or overwrite files. Do NOT use for targeted edits to existing files — use file-edit instead.',
      errorCases: [
        { condition: 'Path is outside project directory', errorMessage: 'Access denied: path is outside project directory' },
        { condition: 'Parent directory does not exist', errorMessage: 'Directory not found: {parentDir}' },
        { condition: 'No write permission', errorMessage: 'Permission denied: cannot write to {path}' },
      ],
      enhancedParameters: {
        path: {
          type: 'string',
          description: 'Relative or absolute path for the file to write',
          constraints: 'Non-empty string. Must resolve within the project directory.',
          example: 'src/utils/helpers.ts',
        },
        content: {
          type: 'string',
          description: 'Full file content to write',
          constraints: 'Non-empty string. Provide complete file content (not a diff).',
          example: 'export function add(a: number, b: number): number { return a + b; }',
        },
      },
    },
    'file-edit': {
      usageHint: 'Use for targeted edits to existing files with diff preview. Do NOT use to create new files — use file-write instead.',
      errorCases: [
        { condition: 'File does not exist', errorMessage: 'File not found: {path}' },
        { condition: 'Edit target text not found in file', errorMessage: 'Edit target not found: specified text does not exist in file' },
        { condition: 'Path is outside project directory', errorMessage: 'Access denied: path is outside project directory' },
      ],
      enhancedParameters: {
        path: {
          type: 'string',
          description: 'Path to the file to edit',
          constraints: 'Non-empty string. File must exist within the project directory.',
          example: 'src/components/Button.tsx',
        },
        edits: {
          type: 'array',
          description: 'Array of edit operations to apply',
          constraints: 'Non-empty array. Each edit must specify old text and new text.',
          example: '[{"oldText": "const x = 1", "newText": "const x = 2"}]',
        },
      },
    },
    'glob': {
      usageHint: 'Use to find files by glob pattern. Do NOT use for content search — use grep instead.',
      errorCases: [
        { condition: 'Invalid glob pattern syntax', errorMessage: 'Glob search failed: invalid pattern' },
        { condition: 'No project directory in context', errorMessage: 'No project directory set in context' },
      ],
      enhancedParameters: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g., "src/**/*.ts")',
          constraints: 'Non-empty string. Must be a valid glob pattern.',
          example: 'src/**/*.test.ts',
        },
        ignore: {
          type: 'array',
          description: 'Additional patterns to ignore beyond defaults (node_modules, .git, dist, build)',
          constraints: 'Array of strings. Each must be a valid glob pattern.',
          example: '["**/*.spec.ts", "coverage/**"]',
        },
      },
    },
    'grep': {
      usageHint: 'Use to search file contents by regex or literal text. Do NOT use for finding files by name — use glob instead.',
      errorCases: [
        { condition: 'Search directory does not exist', errorMessage: 'Search directory not found: {path}' },
        { condition: 'Search path outside project', errorMessage: 'Access denied: search path is outside project directory' },
        { condition: 'Path is not a directory', errorMessage: 'Not a directory: {path}' },
      ],
      enhancedParameters: {
        pattern: {
          type: 'string',
          description: 'Search pattern (regex or literal string)',
          constraints: 'Non-empty string. Regex patterns must use valid syntax.',
          example: 'function\\s+handle\\w+',
        },
        path: {
          type: 'string',
          description: 'Subdirectory to scope search (relative to project root)',
          constraints: 'Must resolve to a directory within the project.',
          example: 'src/services',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether to match case-sensitively (default: false)',
          constraints: 'Boolean value.',
          example: 'true',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return (default: 100)',
          constraints: 'Positive integer.',
          example: '50',
        },
      },
    },
    'web-fetch': {
      usageHint: 'Use to fetch content from a URL for reference. Do NOT use for API calls that modify external state.',
      errorCases: [
        { condition: 'URL is unreachable', errorMessage: 'Network error: unable to reach {url}' },
        { condition: 'Request times out', errorMessage: 'Request timed out fetching {url}' },
        { condition: 'Invalid URL format', errorMessage: 'Invalid URL: {url}' },
      ],
      enhancedParameters: {
        url: {
          type: 'string',
          description: 'The URL to fetch content from',
          constraints: 'Non-empty string. Must be a valid HTTP or HTTPS URL.',
          example: 'https://api.example.com/docs',
        },
      },
    },
    'web-search': {
      usageHint: 'Use to search the web for documentation or solutions. Do NOT use when the answer is in the local codebase.',
      errorCases: [
        { condition: 'Search service unavailable', errorMessage: 'Web search service is currently unavailable' },
        { condition: 'Empty query', errorMessage: 'Missing required parameter: query' },
      ],
      enhancedParameters: {
        query: {
          type: 'string',
          description: 'The search query text',
          constraints: 'Non-empty string. Keep queries concise and focused.',
          example: 'TypeScript generic constraints tutorial',
        },
      },
    },
    'agent': {
      usageHint: 'Use to delegate a subtask to another agent. Do NOT use for simple operations that can be done directly.',
      errorCases: [
        { condition: 'Agent ID not found', errorMessage: 'Agent not found: {agentId}' },
        { condition: 'Agent execution fails', errorMessage: 'Sub-agent execution failed: {error}' },
      ],
      enhancedParameters: {
        agentId: {
          type: 'string',
          description: 'ID of the agent to invoke',
          constraints: 'Non-empty string. Must be a registered agent identifier.',
          example: 'code-reviewer',
        },
        task: {
          type: 'string',
          description: 'Description of the task to delegate',
          constraints: 'Non-empty string. Be specific about the expected outcome.',
          example: 'Review the auth module for security vulnerabilities',
        },
      },
    },
    'send-message': {
      usageHint: 'Use to send a message to another running agent. Do NOT use to invoke agent actions — use agent tool instead.',
      errorCases: [
        { condition: 'Target agent not found', errorMessage: 'Agent not found: {targetAgentId}' },
        { condition: 'Agent is not running', errorMessage: 'Target agent is not active: {targetAgentId}' },
      ],
      enhancedParameters: {
        targetAgentId: {
          type: 'string',
          description: 'ID of the target agent to receive the message',
          constraints: 'Non-empty string. Target agent must be currently active.',
          example: 'orchestrator',
        },
        message: {
          type: 'string',
          description: 'Message content to send',
          constraints: 'Non-empty string.',
          example: 'Task completed successfully with 3 files modified',
        },
      },
    },
    'task-create': {
      usageHint: 'Use to create subtasks in the workflow. Do NOT use for tasks that should be executed immediately — use bash or agent instead.',
      errorCases: [
        { condition: 'No active workflow', errorMessage: 'Cannot create task: no active workflow session' },
        { condition: 'Invalid assignee', errorMessage: 'Invalid assignee: {assignee}' },
      ],
      enhancedParameters: {
        description: {
          type: 'string',
          description: 'Description of the subtask to create',
          constraints: 'Non-empty string. Be specific and actionable.',
          example: 'Add input validation to the login form handler',
        },
        assignee: {
          type: 'string',
          description: 'Agent or user to assign the task to (optional)',
          constraints: 'If provided, must be a valid agent or user identifier.',
          example: 'code-agent',
        },
      },
    },
    'task-update': {
      usageHint: 'Use to update the status of an existing task. Do NOT use to create new tasks — use task-create instead.',
      errorCases: [
        { condition: 'Task ID not found', errorMessage: 'Task not found: {taskId}' },
        { condition: 'Invalid status transition', errorMessage: 'Invalid status transition: cannot move from {current} to {status}' },
      ],
      enhancedParameters: {
        taskId: {
          type: 'string',
          description: 'ID of the task to update',
          constraints: 'Non-empty string. Must reference an existing task.',
          example: 'task-001',
        },
        status: {
          type: 'string',
          description: 'New status for the task',
          constraints: 'Must be one of: pending, in-progress, completed, failed, cancelled.',
          example: 'completed',
          enum: ['pending', 'in-progress', 'completed', 'failed', 'cancelled'],
        },
      },
    },
    'tool-search': {
      usageHint: 'Use to discover available tools by name or description. Do NOT use when you already know the tool name.',
      errorCases: [
        { condition: 'Empty query', errorMessage: 'Missing required parameter: query' },
      ],
      enhancedParameters: {
        query: {
          type: 'string',
          description: 'Search query to match against tool names and descriptions',
          constraints: 'Non-empty string.',
          example: 'file',
        },
      },
    },
  };
}
