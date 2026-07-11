/**
 * Shared input validation utilities for built-in tools.
 *
 * Provides:
 * - `validateInput`: Generic schema-based input validator
 * - `safeExecute`: Higher-order function wrapping tool execution with try/catch → ToolResult
 *
 * Requirements: 8.1, 8.2, 8.4
 */

import type { ToolContext, ToolResult } from '../../shared/types.js';

// ─── Schema Types ───────────────────────────────────────────────

/**
 * Supported types for field validation.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * Describes a single field in the input schema for validation.
 */
export interface FieldSchema {
  /** The field name to validate */
  name: string;
  /** Expected JavaScript type */
  type: FieldType;
  /** Whether the field must be present (default: true) */
  required?: boolean;
}

/**
 * Result of a successful validation containing the parsed data.
 */
export interface ValidationSuccess<T> {
  valid: true;
  data: T;
}

/**
 * Result of a failed validation containing the error description.
 */
export interface ValidationFailure {
  valid: false;
  error: string;
}

/**
 * Discriminated union returned by `validateInput`.
 */
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

// ─── validateInput ──────────────────────────────────────────────

/**
 * Validates an unknown input against a schema definition (list of required fields with expected types).
 *
 * Returns `{ valid: true, data: T }` if all checks pass, or `{ valid: false, error: string }` with
 * a human-readable description of the first validation failure.
 *
 * @param input - The unknown input to validate (typically from the agent loop)
 * @param schema - Array of field descriptors specifying name, type, and whether required
 * @returns A discriminated union of success with typed data or failure with error message
 */
export function validateInput<T = Record<string, unknown>>(
  input: unknown,
  schema: FieldSchema[],
): ValidationResult<T> {
  // Input must be a non-null object
  if (input === null || input === undefined) {
    return { valid: false, error: 'Input is required but was null or undefined' };
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: 'Input must be a plain object' };
  }

  const record = input as Record<string, unknown>;

  for (const field of schema) {
    const value = record[field.name];
    const isRequired = field.required !== false; // default to true

    // Check for missing required fields
    if (value === undefined || value === null) {
      if (isRequired) {
        return {
          valid: false,
          error: `Missing required parameter: ${field.name}`,
        };
      }
      // Optional field not present — skip type check
      continue;
    }

    // Type validation
    if (field.type === 'array') {
      if (!Array.isArray(value)) {
        return {
          valid: false,
          error: `Parameter "${field.name}" must be of type array, got ${typeof value}`,
        };
      }
    } else if (typeof value !== field.type) {
      return {
        valid: false,
        error: `Parameter "${field.name}" must be of type ${field.type}, got ${typeof value}`,
      };
    }
  }

  return { valid: true, data: record as T };
}

// ─── safeExecute ────────────────────────────────────────────────

/**
 * The type signature for a tool's core execution logic (after input validation).
 * Receives already-validated and typed input plus the tool context.
 */
export type ToolExecutionFn<T> = (
  input: T,
  context: ToolContext,
) => Promise<ToolResult>;

/**
 * Higher-order function that wraps any tool execution function with the
 * standard error handling pattern:
 *
 * 1. Validate input against the provided schema
 * 2. Call the wrapped execution function with validated data
 * 3. Catch all exceptions and return ToolResult with `success: false`
 *
 * This ensures no tool ever throws — all errors are captured in ToolResult.
 *
 * @param schema - Field schema array for input validation
 * @param executeFn - The core tool logic to wrap
 * @returns A function matching the standard `(input: unknown, context: ToolContext) => Promise<ToolResult>` signature
 */
export function safeExecute<T = Record<string, unknown>>(
  schema: FieldSchema[],
  executeFn: ToolExecutionFn<T>,
): (input: unknown, context: ToolContext) => Promise<ToolResult> {
  return async (input: unknown, context: ToolContext): Promise<ToolResult> => {
    try {
      // 1. Validate input against expected schema
      const parsed = validateInput<T>(input, schema);
      if (!parsed.valid) {
        return { success: false, output: null, error: parsed.error };
      }

      // 2. Perform operation
      const result = await executeFn(parsed.data, context);
      return result;
    } catch (err: unknown) {
      // 3. Never throw — always return ToolResult
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: null, error: message };
    }
  };
}
