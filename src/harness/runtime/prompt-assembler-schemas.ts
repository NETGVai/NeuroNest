/**
 * Prompt Assembler Schemas
 *
 * Zod schemas and TypeScript types for deterministic prompt assembly.
 * Defines the contracts for named sections, strict typed variables,
 * scope overrides, tool schema normalization, prompt fingerprints,
 * and assembly results.
 *
 * Requirements: 12.1–12.8, 34.1–34.2
 */

import { z } from 'zod';
import { IdentifierSchema, IntegrityHashSchema, TimestampSchema } from '../contracts/primitives.js';

// ─── Section Variable ───────────────────────────────────────────

/**
 * A strict typed variable within a named prompt section.
 * Variables must resolve to string values; unresolved variables block assembly.
 */
export const SectionVariableSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  source: IdentifierSchema.describe('Source revision that contributed this variable'),
}).passthrough();

export type SectionVariable = z.infer<typeof SectionVariableSchema>;

// ─── Scope Override Entry ───────────────────────────────────────

/**
 * A scope override applied to a section during assembly.
 * Deterministic precedence: route > session > skill > profile (highest to lowest).
 */
export const ScopePrecedenceSchema = z.enum([
  'profile',
  'skill',
  'session',
  'route',
]);

export type ScopePrecedence = z.infer<typeof ScopePrecedenceSchema>;

export const ScopeOverrideEntrySchema = z.object({
  sectionName: z.string().min(1),
  variableName: z.string().min(1),
  value: z.string(),
  precedence: ScopePrecedenceSchema,
  sourceRevision: IdentifierSchema,
}).passthrough();

export type ScopeOverrideEntry = z.infer<typeof ScopeOverrideEntrySchema>;

// ─── Named Prompt Section ───────────────────────────────────────

/**
 * A named prompt section with an explicit version and stable ordering key.
 * Sections are assembled in ascending `orderingKey` order.
 *
 * Requirement 12.1: ordered named sections with explicit section versions,
 * stable ordering keys, and strict typed variables.
 */
export const NamedPromptSectionSchema = z.object({
  sectionName: z.string().min(1),
  sectionVersion: IdentifierSchema,
  orderingKey: z.number().int(),
  template: z.string().describe('Template with {{variable}} placeholders'),
  variables: z.array(SectionVariableSchema).default([]),
}).passthrough();

export type NamedPromptSection = z.infer<typeof NamedPromptSectionSchema>;

// ─── Normalized Tool Schema ─────────────────────────────────────

/**
 * A tool schema normalized for deterministic assembly ordering.
 * Tool schemas are ordered by configured order and stable tool identity.
 *
 * Requirement 12.3: order normalized tool schemas deterministically.
 */
export const NormalizedToolSchemaSchema = z.object({
  toolName: IdentifierSchema,
  toolVersion: IdentifierSchema,
  schemaHash: IntegrityHashSchema,
  configuredOrder: z.number().int().nonnegative(),
  inputSchema: z.record(z.string(), z.unknown()),
  description: z.string().default(''),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type NormalizedToolSchema = z.infer<typeof NormalizedToolSchemaSchema>;

// ─── Assembly Input ─────────────────────────────────────────────

/**
 * The complete set of inputs for a single prompt assembly invocation.
 * All inputs are normalized and persisted for exact reconstruction.
 *
 * Requirement 12.7: persist every normalized input required to reconstruct
 * the exact provider-neutral prompt and model-visible tool schemas.
 */
export const AssemblyInputSchema = z.object({
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  routeId: IdentifierSchema,
  adapterVersion: IdentifierSchema,
  assemblyVersion: IdentifierSchema,
  sections: z.array(NamedPromptSectionSchema).min(1),
  scopeOverrides: z.array(ScopeOverrideEntrySchema).default([]),
  tools: z.array(NormalizedToolSchemaSchema).default([]),
  attachments: z.array(z.object({
    attachmentId: IdentifierSchema,
    contentHash: IntegrityHashSchema,
  }).passthrough()).default([]),
}).passthrough();

export type AssemblyInput = z.infer<typeof AssemblyInputSchema>;

// ─── Prompt Fingerprint ─────────────────────────────────────────

/**
 * The Prompt_Fingerprint record computed before provider-specific translation.
 *
 * Requirement 12.5: compute Prompt_Fingerprint before provider-specific translation.
 */
export const PromptFingerprintRecordSchema = z.object({
  fingerprint: IntegrityHashSchema,
  sessionId: IdentifierSchema,
  branchId: IdentifierSchema,
  routeId: IdentifierSchema,
  assemblyVersion: IdentifierSchema,
  sectionCount: z.number().int().nonnegative(),
  toolCount: z.number().int().nonnegative(),
  computedAt: TimestampSchema,
}).passthrough();

export type PromptFingerprintRecord = z.infer<typeof PromptFingerprintRecordSchema>;

// ─── Assembled Prompt ───────────────────────────────────────────

/**
 * The result of a successful prompt assembly: assembled content, ordered
 * tool schemas, and the computed fingerprint.
 */
export const AssembledPromptSchema = z.object({
  /** Assembled section content in stable order */
  assembledSections: z.array(z.object({
    sectionName: z.string().min(1),
    sectionVersion: IdentifierSchema,
    orderingKey: z.number().int(),
    resolvedContent: z.string(),
    variableResolutions: z.record(z.string(), z.string()).default({}),
    sourceRevisions: z.array(IdentifierSchema).default([]),
  }).passthrough()),
  /** Ordered tool schemas normalized deterministically */
  orderedTools: z.array(NormalizedToolSchemaSchema),
  /** Prompt fingerprint computed before translation */
  fingerprint: PromptFingerprintRecordSchema,
  /** All normalized inputs persisted for reconstruction */
  persistedInput: AssemblyInputSchema,
  /** The concatenated prompt content (provider-neutral) */
  promptContent: z.string(),
  /** Assembly timestamp */
  assembledAt: TimestampSchema,
}).passthrough();

export type AssembledPrompt = z.infer<typeof AssembledPromptSchema>;

// ─── Assembly Error ─────────────────────────────────────────────

/**
 * Structured assembly errors that block dispatch.
 *
 * Requirement 12.4: fail before provider dispatch with structured assembly error.
 * Requirement 12.8: block provider dispatch when not reconstructable.
 */
export const AssemblyErrorKindSchema = z.enum([
  'unresolved_variable',
  'malformed_section',
  'malformed_tool_reference',
  'unresolved_section_reference',
  'unresolved_tool_reference',
  'duplicate_ordering_key',
  'non_reconstructable',
  'invalid_override',
  'empty_sections',
]);

export type AssemblyErrorKind = z.infer<typeof AssemblyErrorKindSchema>;

export const AssemblyErrorSchema = z.object({
  kind: AssemblyErrorKindSchema,
  message: z.string().min(1),
  sectionName: z.string().optional(),
  variableName: z.string().optional(),
  toolName: z.string().optional(),
  details: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export type AssemblyError = z.infer<typeof AssemblyErrorSchema>;

// ─── Assembly Result ────────────────────────────────────────────

/**
 * The discriminated assembly result: either success with an assembled prompt
 * or failure with structured error(s).
 */
export const AssemblyResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    prompt: AssembledPromptSchema,
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(AssemblyErrorSchema).min(1),
  }),
]);

export type AssemblyResult = z.infer<typeof AssemblyResultSchema>;
