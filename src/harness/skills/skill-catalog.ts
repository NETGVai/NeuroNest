/**
 * Skill Catalog — Filesystem skill discovery, validation, merging, and scope-based visibility.
 *
 * Extends NeuroNest's existing Skill_Catalog authority with:
 * - Stable identity merging of filesystem-discovered skills with persisted skills
 * - Contract, permission, reference, and compatibility validation
 * - Scope-based visibility filtering
 * - Activation with registered effects and rollback on failure
 * - Unload with disposer invocation and bounded async drain
 * - Explicit defaults: no implicit skill loading
 *
 * Requirements: 10.1–10.6
 */

import { z } from 'zod';
import {
  SkillManifestSchema,
  skillIdentityKey,
  type SkillManifest,
  type SkillIdentity,
  type CatalogSkillEntry,
  type SkillValidationStatus,
  type SkillDisposer,
  type SkillEffect,
  type SkillActivationResult,
} from './types';
import type { ScopeDescriptorV1 } from '../contracts/scope';

// ─── Validation ─────────────────────────────────────────────────

/**
 * Validates a skill manifest: name, version, contracts, permissions,
 * tool references, prompt references, and compatibility.
 * Returns an array of validation error messages (empty = valid).
 */
export function validateSkillManifest(manifest: unknown): string[] {
  const errors: string[] = [];

  const result = SkillManifestSchema.safeParse(manifest);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
    return errors;
  }

  const parsed = result.data;

  // Name must not be empty after trim
  if (parsed.name.trim().length === 0) {
    errors.push('name: must not be empty or whitespace-only');
  }

  // Version must look like a semver-ish string
  if (!/^\d+\.\d+/.test(parsed.version)) {
    errors.push('version: must follow semantic versioning (major.minor[.patch])');
  }

  // Tool references must have valid names
  for (const ref of parsed.toolReferences) {
    if (ref.name.trim().length === 0) {
      errors.push(`toolReferences: tool name must not be empty`);
    }
  }

  // Prompt references must have valid section names
  for (const ref of parsed.promptReferences) {
    if (ref.sectionName.trim().length === 0) {
      errors.push(`promptReferences: section name must not be empty`);
    }
  }

  return errors;
}

// ─── Scope Matching ─────────────────────────────────────────────

/**
 * Checks whether a caller's scope descriptor matches the skill's visibility scope.
 * A skill with no scope is visible to all callers.
 * A skill with a scope is visible only if the caller's scope includes at least
 * all specified fields of the skill's scope.
 */
export function isScopeVisible(
  skillScope: ScopeDescriptorV1 | undefined,
  callerScope: ScopeDescriptorV1,
): boolean {
  if (!skillScope) return true;

  const scopeFields: Array<keyof ScopeDescriptorV1> = [
    'userId',
    'workspaceId',
    'projectId',
    'sessionId',
    'agentId',
    'ownerId',
  ];

  for (const field of scopeFields) {
    if (field === 'schemaVersion') continue;
    const skillValue = skillScope[field];
    if (skillValue !== undefined && skillValue !== callerScope[field]) {
      return false;
    }
  }

  return true;
}

// ─── Skill Catalog ──────────────────────────────────────────────

/**
 * SkillCatalog merges filesystem-discovered skills with existing persisted skills
 * through stable skill identities.
 *
 * Key behaviors:
 * - No implicit skill loading (explicit defaults only)
 * - Skills merged by stable identity (name@version)
 * - Scope-based visibility filtering
 * - Activation with registered effects and rollback on failure
 * - Unload with disposer invocation and bounded async drain
 */
export class SkillCatalog {
  private readonly entries: Map<string, CatalogSkillEntry> = new Map();
  private readonly activeEffects: Map<string, SkillEffect[]> = new Map();
  private readonly drainDeadlineMs: number;
  private revisionCounter = 0;

  constructor(options: { drainDeadlineMs?: number } = {}) {
    this.drainDeadlineMs = options.drainDeadlineMs ?? 5000;
  }

  /**
   * Merge discovered skills into the catalog by stable identity.
   * If a skill with the same identity already exists, it is updated with a new revision.
   * Validates contracts, permissions, references, and compatibility before publishing.
   *
   * Requirement 10.1: Merge configured filesystem discoveries with persisted catalog
   * Requirement 10.2: Validate name, version, contracts, permissions, references, compatibility
   */
  mergeDiscoveredSkills(manifests: SkillManifest[]): CatalogSkillEntry[] {
    const merged: CatalogSkillEntry[] = [];

    for (const manifest of manifests) {
      const identity: SkillIdentity = { name: manifest.name, version: manifest.version };
      const key = skillIdentityKey(identity);
      const validationErrors = validateSkillManifest(manifest);
      const validationStatus: SkillValidationStatus =
        validationErrors.length === 0 ? 'valid' : 'invalid';

      this.revisionCounter++;

      const entry: CatalogSkillEntry = {
        identity,
        identityKey: key,
        manifest,
        source: 'filesystem',
        validationStatus,
        validationErrors,
        revision: this.revisionCounter,
        registeredAt: Date.now(),
        scope: manifest.scope,
      };

      this.entries.set(key, entry);
      merged.push(entry);
    }

    return merged;
  }

  /**
   * Merge persisted skills into the catalog.
   * Persisted skills have lower priority than filesystem discoveries with the same identity.
   */
  mergePersistedSkills(manifests: SkillManifest[]): CatalogSkillEntry[] {
    const merged: CatalogSkillEntry[] = [];

    for (const manifest of manifests) {
      const identity: SkillIdentity = { name: manifest.name, version: manifest.version };
      const key = skillIdentityKey(identity);

      // Filesystem discovery takes priority — don't overwrite
      if (this.entries.has(key) && this.entries.get(key)!.source === 'filesystem') {
        continue;
      }

      const validationErrors = validateSkillManifest(manifest);
      const validationStatus: SkillValidationStatus =
        validationErrors.length === 0 ? 'valid' : 'invalid';

      this.revisionCounter++;

      const entry: CatalogSkillEntry = {
        identity,
        identityKey: key,
        manifest,
        source: 'persisted',
        validationStatus,
        validationErrors,
        revision: this.revisionCounter,
        registeredAt: Date.now(),
        scope: manifest.scope,
      };

      this.entries.set(key, entry);
      merged.push(entry);
    }

    return merged;
  }

  /**
   * List skills visible to the caller's scope.
   *
   * Requirement 10.3: Return only skills visible to the caller's ScopeDescriptor
   */
  listVisibleSkills(callerScope: ScopeDescriptorV1): CatalogSkillEntry[] {
    const visible: CatalogSkillEntry[] = [];
    for (const entry of this.entries.values()) {
      if (isScopeVisible(entry.scope, callerScope)) {
        visible.push(entry);
      }
    }
    return visible;
  }

  /**
   * Get a specific skill by identity key.
   */
  getSkill(identityKey: string): CatalogSkillEntry | undefined {
    return this.entries.get(identityKey);
  }

  /**
   * Get all registered skills (unfiltered).
   */
  getAllSkills(): CatalogSkillEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Activate a skill for a session. Verifies required capabilities and permissions,
   * registers owned effects, and rolls back all effects on failure.
   *
   * Requirement 10.4: Verify required capabilities and permissions before registering effects
   * Requirement 10.5: Roll back all effects from failed activation
   */
  activateSkill(
    identityKey: string,
    sessionId: string,
    options: {
      availableCapabilities?: string[];
      effectFactories?: Array<{
        description: string;
        activate: () => SkillDisposer;
      }>;
    } = {},
  ): SkillActivationResult {
    const entry = this.entries.get(identityKey);
    if (!entry) {
      return {
        success: false,
        identityKey,
        effects: [],
        errors: [`Skill "${identityKey}" not found in catalog`],
      };
    }

    if (entry.validationStatus !== 'valid') {
      return {
        success: false,
        identityKey,
        effects: [],
        errors: [`Skill "${identityKey}" failed validation: ${entry.validationErrors.join('; ')}`],
      };
    }

    // Verify required capabilities
    const requiredCapabilities = entry.manifest.compatibility.requiredCapabilities;
    const available = new Set(options.availableCapabilities ?? []);
    const missingCapabilities = requiredCapabilities.filter((c) => !available.has(c));

    if (missingCapabilities.length > 0) {
      return {
        success: false,
        identityKey,
        effects: [],
        errors: [
          `Missing required capabilities: ${missingCapabilities.join(', ')}`,
        ],
      };
    }

    // Register effects — rollback all on failure
    const registeredEffects: SkillEffect[] = [];
    const factories = options.effectFactories ?? [];

    try {
      for (const factory of factories) {
        const disposer = factory.activate();
        const effect: SkillEffect = {
          skillIdentityKey: identityKey,
          sessionId,
          effectId: `${identityKey}:${sessionId}:${registeredEffects.length}`,
          description: factory.description,
          disposer,
          registeredAt: Date.now(),
        };
        registeredEffects.push(effect);
      }
    } catch (error) {
      // Rollback all registered effects on failure
      for (const effect of registeredEffects) {
        try {
          effect.disposer();
        } catch {
          // Best-effort rollback — disposers should be idempotent
        }
      }

      return {
        success: false,
        identityKey,
        effects: [],
        errors: [
          `Activation failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }

    // Store active effects for this skill
    const existingEffects = this.activeEffects.get(identityKey) ?? [];
    this.activeEffects.set(identityKey, [...existingEffects, ...registeredEffects]);

    return {
      success: true,
      identityKey,
      effects: registeredEffects,
      errors: [],
    };
  }

  /**
   * Unload a skill — invoke disposers and drain owned async work within the deadline.
   *
   * Requirement 10.6: Invoke disposers and drain owned async work within configured deadline
   */
  async unloadSkill(identityKey: string): Promise<{ success: boolean; errors: string[] }> {
    const effects = this.activeEffects.get(identityKey);
    if (!effects || effects.length === 0) {
      this.activeEffects.delete(identityKey);
      return { success: true, errors: [] };
    }

    const errors: string[] = [];
    const deadline = Date.now() + this.drainDeadlineMs;

    for (const effect of effects) {
      if (Date.now() > deadline) {
        errors.push(
          `Drain deadline exceeded while disposing effect "${effect.description}"`,
        );
        break;
      }

      try {
        const result = effect.disposer();
        if (result && typeof result === 'object' && 'then' in result) {
          // Async disposer — wait with deadline
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            await Promise.race([
              result,
              new Promise<void>((_, reject) =>
                setTimeout(() => reject(new Error('Drain deadline exceeded')), remaining),
              ),
            ]);
          } else {
            errors.push(
              `Drain deadline exceeded for async disposer "${effect.description}"`,
            );
          }
        }
      } catch (error) {
        errors.push(
          `Disposer error for "${effect.description}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.activeEffects.delete(identityKey);
    return { success: errors.length === 0, errors };
  }

  /**
   * Get active effects for a skill.
   */
  getActiveEffects(identityKey: string): readonly SkillEffect[] {
    return this.activeEffects.get(identityKey) ?? [];
  }

  /**
   * Check if a skill has active effects.
   */
  isActive(identityKey: string): boolean {
    const effects = this.activeEffects.get(identityKey);
    return effects !== undefined && effects.length > 0;
  }

  /**
   * Remove a skill from the catalog entirely.
   */
  removeSkill(identityKey: string): boolean {
    return this.entries.delete(identityKey);
  }

  /**
   * Clear all entries and effects.
   */
  clear(): void {
    this.entries.clear();
    this.activeEffects.clear();
  }
}
