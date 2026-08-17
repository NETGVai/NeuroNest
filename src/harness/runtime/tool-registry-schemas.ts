/**
 * Tool Registry Schemas — Versioned tool metadata contracts.
 *
 * Defines Zod schemas for Tool_Registry entries: versioned input/output schemas,
 * owner, risk class, Scope_Descriptor rules, idempotency semantics, concurrency
 * class, timeout policy, and pure Render_Intent factory reference.
 *
 * Render_Intent validation ensures intents contain no executable markup, secrets,
 * private paths, or unrestricted locators.
 *
 * Requirements: 13.1, 13.8–13.9, 35.5–35.6, 37.5–37.6
 */

import { z } from 'zod';
import { IdentifierSchema, ContractRefSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';
import { RenderIntentV1Schema, type RenderIntentV1 } from '../contracts/render-intent';

// ─── Risk Classification ────────────────────────────────────────

/**
 * Risk class determines policy evaluation order and approval requirements.
 */
export const ToolRiskClassSchema = z.enum([
  'read-only',
  'idempotent-write',
  'write',
  'execute',
  'destructive',
]);

export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;

// ─── Idempotency Semantics ──────────────────────────────────────

/**
 * Idempotency semantics determine how the pipeline handles retries and replay.
 *
 * - 'pure': Same input always produces same output, safe to retry unconditionally
 * - 'idempotent': Has side effects but repeated calls with same key are safe
 * - 'non-idempotent': Each call may produce distinct effects
 */
export const IdempotencySemanticsSchema = z.enum([
  'pure',
  'idempotent',
  'non-idempotent',
]);

export type IdempotencySemantics = z.infer<typeof IdempotencySemanticsSchema>;

// ─── Concurrency Classification ─────────────────────────────────

/**
 * Concurrency class determines parallel execution eligibility.
 *
 * - 'concurrent-safe': Can execute in parallel with other concurrent-safe tools
 * - 'exclusive': Must execute as an ordering barrier
 */
export const ConcurrencyClassSchema = z.enum([
  'concurrent-safe',
  'exclusive',
]);

export type ConcurrencyClass = z.infer<typeof ConcurrencyClassSchema>;

// ─── Timeout Policy ─────────────────────────────────────────────

/**
 * Timeout policy for tool execution deadlines.
 * All durations are positive finite milliseconds.
 */
export const TimeoutPolicySchema = z.object({
  /** Maximum execution time in milliseconds. Must be positive and finite. */
  deadlineMs: z.number().int().positive().finite(),
  /** Grace period for cleanup after deadline, in milliseconds. */
  gracePeriodMs: z.number().int().nonnegative().finite().default(5000),
});

export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;

// ─── Scope Rules ────────────────────────────────────────────────

/**
 * Scope rules determine which scope boundaries a tool can operate within.
 * Uses the existing ScopeDescriptorV1 to describe required and optional bounds.
 */
export const ScopeRulesSchema = z.object({
  /** Required scope fields that must be present in the execution context. */
  requiredScope: z.array(z.enum([
    'userId', 'workspaceId', 'projectId', 'sessionId', 'agentId', 'ownerId',
  ])).default([]),
  /** Maximum scope the tool is permitted to access. */
  maxScope: ScopeDescriptorV1Schema.optional(),
});

export type ScopeRules = z.infer<typeof ScopeRulesSchema>;

// ─── Render Intent Safety Validation ────────────────────────────

/**
 * Patterns that are forbidden in render intent string fields.
 * These detect executable markup, secrets, private paths, and unrestricted locators.
 *
 * Requirements: 13.8, 35.5–35.6, 37.5–37.6
 */
const EXECUTABLE_MARKUP_PATTERN = /<script[\s>]|javascript:|on\w+\s*=|<iframe[\s>]|<object[\s>]|<embed[\s>]|data:text\/html/i;
const SECRET_PATTERN = /(?:password|secret|token|api[_-]?key|private[_-]?key|credential)\s*[:=]/i;
const PRIVATE_PATH_PATTERN = /(?:\/etc\/(?:shadow|passwd|sudoers)|~\/\.|\/home\/[^/]+\/\.|\\Users\\[^\\]+\\AppData)/i;
const UNRESTRICTED_LOCATOR_PATTERN = /(?:file:\/\/\/|\\\\[^\\]+\\|\/proc\/|\/dev\/)/i;

/**
 * Validates that a render intent contains no forbidden content.
 * Returns a list of violation reasons, or empty array if clean.
 */
export function validateRenderIntentSafety(intent: RenderIntentV1): string[] {
  const violations: string[] = [];
  const stringValues = extractStringValues(intent);

  for (const { path, value } of stringValues) {
    if (EXECUTABLE_MARKUP_PATTERN.test(value)) {
      violations.push(`Executable markup detected in ${path}`);
    }
    if (SECRET_PATTERN.test(value)) {
      violations.push(`Potential secret detected in ${path}`);
    }
    if (PRIVATE_PATH_PATTERN.test(value)) {
      violations.push(`Private path detected in ${path}`);
    }
    if (UNRESTRICTED_LOCATOR_PATTERN.test(value)) {
      violations.push(`Unrestricted locator detected in ${path}`);
    }
  }

  return violations;
}

/**
 * Recursively extracts all string values with their JSON paths from an object.
 */
function extractStringValues(obj: unknown, prefix = ''): Array<{ path: string; value: string }> {
  const results: Array<{ path: string; value: string }> = [];

  if (typeof obj === 'string') {
    results.push({ path: prefix || 'root', value: obj });
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      results.push(...extractStringValues(obj[i], `${prefix}[${i}]`));
    }
  } else if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      results.push(...extractStringValues(value, prefix ? `${prefix}.${key}` : key));
    }
  }

  return results;
}

// ─── Render Intent Factory ──────────────────────────────────────

/**
 * A pure render-intent factory is a function that produces a RenderIntentV1
 * from a Canonical_Tool_Value. The factory must be deterministic and side-effect-free.
 *
 * The registry validates the output of the factory at registration time
 * and at every invocation boundary.
 */
export type RenderIntentFactory = (value: unknown) => RenderIntentV1;

// ─── Tool Registration Entry ────────────────────────────────────

/**
 * Complete typed tool metadata registered in Tool_Registry.
 *
 * Requirements: 13.1 — versioned input/output schemas, owner, risk class,
 * Scope_Descriptor rules, idempotency semantics, concurrency class, timeout
 * policy, and pure Render_Intent function.
 */
export const ToolRegistrationV1Schema = z.object({
  /** Versioned tool contract identifier (name + version). */
  contract: ContractRefSchema,

  /** Human-readable display name (metadata only; renderers never branch on this). */
  displayName: z.string().min(1),

  /** Tool description for documentation and search. */
  description: z.string(),

  /** Versioned input schema (Zod schema stored as JSON Schema for portability). */
  inputSchema: z.record(z.string(), z.unknown()),

  /** Versioned output schema (Zod schema stored as JSON Schema for portability). */
  outputSchema: z.record(z.string(), z.unknown()),

  /** Owner identity responsible for this tool registration. */
  owner: IdentifierSchema,

  /** Risk classification for policy evaluation. */
  riskClass: ToolRiskClassSchema,

  /** Scope boundary rules. */
  scopeRules: ScopeRulesSchema,

  /** Idempotency semantics for retry and replay handling. */
  idempotency: IdempotencySemanticsSchema,

  /** Concurrency classification for parallel execution. */
  concurrency: ConcurrencyClassSchema,

  /** Timeout policy for execution deadlines. */
  timeout: TimeoutPolicySchema,

  /** Schema version for this registration record. */
  schemaVersion: z.literal(1),
}).passthrough();

export type ToolRegistrationV1 = z.infer<typeof ToolRegistrationV1Schema>;

/**
 * Full tool entry including the render-intent factory (not serializable).
 * The factory is validated at registration but stored separately from
 * the serializable metadata.
 */
export interface ToolRegistryEntry {
  /** Serializable registration metadata. */
  registration: ToolRegistrationV1;
  /** Pure render-intent factory function. */
  renderIntentFactory: RenderIntentFactory;
}
