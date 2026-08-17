/**
 * Skill Discovery and Profile Types — Canonical type definitions for filesystem
 * skill discovery, validation, reversible profile effects, and scope-based visibility.
 *
 * Requirements: 10.1–10.6, 26.1–26.8
 */

import { z } from 'zod';
import { IdentifierSchema, ContractRefSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema, type ScopeDescriptorV1 } from '../contracts/scope';

// ─── Skill Identity and Metadata ────────────────────────────────

/**
 * Stable skill identity used to merge filesystem discoveries with persisted skills.
 * Identity is derived from name + version, not from filesystem path.
 */
export const SkillIdentitySchema = z.object({
  name: IdentifierSchema,
  version: IdentifierSchema,
});

export type SkillIdentity = z.infer<typeof SkillIdentitySchema>;

/**
 * Computes a stable identity key for a skill.
 */
export function skillIdentityKey(identity: SkillIdentity): string {
  return `${identity.name}@${identity.version}`;
}

/**
 * Permission declaration for a skill — what the skill requires from the host.
 */
export const SkillPermissionSchema = z.object({
  kind: z.enum(['filesystem', 'process', 'network', 'tool', 'prompt', 'capability']),
  target: IdentifierSchema,
  access: z.enum(['read', 'write', 'execute']),
});

export type SkillPermission = z.infer<typeof SkillPermissionSchema>;

/**
 * A reference to a tool that the skill provides or requires.
 */
export const ToolReferenceSchema = z.object({
  name: IdentifierSchema,
  version: IdentifierSchema,
  required: z.boolean(),
});

export type ToolReference = z.infer<typeof ToolReferenceSchema>;

/**
 * A reference to a prompt section the skill contributes.
 */
export const PromptReferenceSchema = z.object({
  sectionName: IdentifierSchema,
  version: IdentifierSchema,
  required: z.boolean(),
});

export type PromptReference = z.infer<typeof PromptReferenceSchema>;

/**
 * Compatibility constraint for a skill.
 */
export const CompatibilitySchema = z.object({
  minHostVersion: IdentifierSchema.optional(),
  maxHostVersion: IdentifierSchema.optional(),
  requiredCapabilities: z.array(IdentifierSchema).default([]),
});

export type Compatibility = z.infer<typeof CompatibilitySchema>;

/**
 * Complete skill manifest as discovered from the filesystem.
 */
export const SkillManifestSchema = z.object({
  name: IdentifierSchema,
  version: IdentifierSchema,
  description: z.string().default(''),
  contracts: z.array(ContractRefSchema).default([]),
  permissions: z.array(SkillPermissionSchema).default([]),
  toolReferences: z.array(ToolReferenceSchema).default([]),
  promptReferences: z.array(PromptReferenceSchema).default([]),
  compatibility: CompatibilitySchema.default({ requiredCapabilities: [] }),
  scope: ScopeDescriptorV1Schema.optional(),
  entrypoint: z.string().optional(),
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ─── Catalog Entry ──────────────────────────────────────────────

/**
 * Validation status of a skill in the catalog.
 */
export type SkillValidationStatus = 'valid' | 'invalid' | 'pending';

/**
 * A skill registered in the catalog with full validation state.
 */
export interface CatalogSkillEntry {
  identity: SkillIdentity;
  identityKey: string;
  manifest: SkillManifest;
  source: 'filesystem' | 'persisted';
  validationStatus: SkillValidationStatus;
  validationErrors: string[];
  revision: number;
  registeredAt: number;
  scope: ScopeDescriptorV1 | undefined;
}

// ─── Activation and Effects ─────────────────────────────────────

/**
 * A disposer function registered by a skill activation.
 * Must be idempotent.
 */
export type SkillDisposer = () => void | Promise<void>;

/**
 * An effect registered by a skill activation that can be rolled back.
 */
export interface SkillEffect {
  skillIdentityKey: string;
  sessionId: string;
  effectId: string;
  description: string;
  disposer: SkillDisposer;
  registeredAt: number;
}

/**
 * Result of a skill activation attempt.
 */
export interface SkillActivationResult {
  success: boolean;
  identityKey: string;
  effects: SkillEffect[];
  errors: string[];
}

// ─── Profile Types ──────────────────────────────────────────────

/**
 * A single layer in a profile overlay stack.
 */
export const ProfileLayerSchema = z.object({
  layerId: IdentifierSchema,
  revision: z.number().int().nonnegative(),
  persona: z.record(z.string(), z.unknown()).optional(),
  promptOverrides: z.record(z.string(), z.unknown()).optional(),
  toolOverrides: z.record(z.string(), z.unknown()).optional(),
  modelOverrides: z.record(z.string(), z.unknown()).optional(),
  permissionOverrides: z.record(z.string(), z.unknown()).optional(),
  budgetOverrides: z.record(z.string(), z.unknown()).optional(),
  skillOverrides: z.record(z.string(), z.unknown()).optional(),
  behaviorOverrides: z.record(z.string(), z.unknown()).optional(),
});

export type ProfileLayer = z.infer<typeof ProfileLayerSchema>;

/**
 * A complete profile definition composed from ordered layers.
 */
export const ProfileDefinitionSchema = z.object({
  profileId: IdentifierSchema,
  name: z.string(),
  layers: z.array(ProfileLayerSchema),
  scope: ScopeDescriptorV1Schema.optional(),
  schemaVersion: z.literal(1),
});

export type ProfileDefinition = z.infer<typeof ProfileDefinitionSchema>;

/**
 * The effective resolved profile state after overlay application.
 */
export interface EffectiveProfile {
  profileId: string;
  appliedLayers: Array<{ layerId: string; revision: number }>;
  effectiveSettings: Record<string, unknown>;
  effectiveTools: Record<string, unknown>;
  effectivePrompts: Record<string, unknown>;
  effectivePermissions: Record<string, unknown>;
  effectiveBudgets: Record<string, unknown>;
  computedAt: number;
}

/**
 * A diff entry showing what would change during profile activation.
 */
export interface ProfileDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * The dry-run diff result for a profile activation.
 */
export interface ProfileDryRunResult {
  profileId: string;
  diffs: ProfileDiffEntry[];
  wouldApplyLayers: Array<{ layerId: string; revision: number }>;
  valid: boolean;
  errors: string[];
}

/**
 * Profile effect registered during activation, supports rollback.
 */
export interface ProfileEffect {
  profileId: string;
  sessionId: string;
  effectId: string;
  description: string;
  disposer: SkillDisposer;
  registeredAt: number;
}
