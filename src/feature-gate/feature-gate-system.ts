/**
 * FeatureGateSystem — Configuration resolver and runtime guard for all feature flags.
 *
 * Validates dependencies, auto-enables prerequisites, rejects incompatible
 * combinations, and provides zero-cost null-check guards for subsystem activation.
 *
 * Performance: isEnabled() is an object property lookup + Set.has() — <0.001ms.
 *
 * Requirements: 0.1, 0.5, 0.6, 0.7, 0.8
 */

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_DEPENDENCIES,
  RUNTIME_SECURITY_DEPENDENCIES,
  ENHANCED_FEATURE_DEPENDENCIES,
  LOOP_ENGINE_DEPENDENCIES,
  KNOWLEDGE_TRAINING_DEPENDENCIES,
  type FeatureDependency,
  type FeatureGateFlags,
  type ResolvedFeatureConfig,
} from './feature-gate-config.js';

export class FeatureGateSystem {
  private flags: FeatureGateFlags;
  private disabledAtRuntime: Set<keyof FeatureGateFlags> = new Set();
  private runtimeDisableReasons: Map<keyof FeatureGateFlags, string> = new Map();

  constructor(userConfig: Partial<FeatureGateFlags>) {
    this.flags = { ...DEFAULT_FEATURE_FLAGS, ...userConfig };
  }

  /**
   * Validate dependencies and resolve config.
   * Auto-enables hard prerequisites transitively.
   * Throws on incompatible feature combinations.
   */
  resolve(): ResolvedFeatureConfig {
    const autoEnabled: (keyof FeatureGateFlags)[] = [];
    const warnings: string[] = [];

    // Merge all dependency declarations for unified checking
    const allDependencies: FeatureDependency[] = [
      ...FEATURE_DEPENDENCIES,
      ...RUNTIME_SECURITY_DEPENDENCIES,
      ...ENHANCED_FEATURE_DEPENDENCIES,
      ...LOOP_ENGINE_DEPENDENCIES,
      ...KNOWLEDGE_TRAINING_DEPENDENCIES,
    ];

    // Auto-enable hard prerequisites transitively
    let changed = true;
    while (changed) {
      changed = false;
      for (const dep of allDependencies) {
        if (!this.flags[dep.feature]) continue;

        if (dep.requires) {
          for (const req of dep.requires) {
            if (!this.flags[req]) {
              this.flags[req] = true;
              autoEnabled.push(req);
              warnings.push(
                `Auto-enabled '${req}' as prerequisite of '${dep.feature}'`,
              );
              changed = true;
            }
          }
        }
      }
    }

    // Validate requiresAny — at least one must be enabled (after auto-enabling)
    for (const dep of allDependencies) {
      if (!this.flags[dep.feature]) continue;

      if (dep.requiresAny && dep.requiresAny.length > 0) {
        const hasAny = dep.requiresAny.some((req) => this.flags[req]);
        if (!hasAny) {
          const options = dep.requiresAny.join(' or ');
          throw new Error(
            `Feature '${dep.feature}' requires at least one of: ${options}. ` +
            `Enable one of these features or disable '${dep.feature}'.`,
          );
        }
      }
    }

    // Validate incompatible pairs — reject with descriptive error
    for (const dep of allDependencies) {
      if (!this.flags[dep.feature]) continue;

      if (dep.incompatible) {
        for (const incompat of dep.incompatible) {
          if (this.flags[incompat]) {
            throw new Error(
              `Feature '${dep.feature}' is incompatible with '${incompat}'. ` +
              `Disable one of these features.`,
            );
          }
        }
      }
    }

    return {
      flags: { ...this.flags },
      resolved: true,
      autoEnabled,
      warnings,
    };
  }

  /**
   * Null-check guard — zero cost branch prediction when disabled.
   * Object property lookup + Set.has() — under 0.001ms.
   */
  isEnabled(feature: keyof FeatureGateFlags): boolean {
    return this.flags[feature] && !this.disabledAtRuntime.has(feature);
  }

  /**
   * Runtime disable after unhandled error (graceful degradation).
   * Does not require restart.
   */
  disableAtRuntime(feature: keyof FeatureGateFlags, reason: string): void {
    this.disabledAtRuntime.add(feature);
    this.runtimeDisableReasons.set(feature, reason);
  }

  /**
   * Hot-enable a feature without restart.
   * Supports two scenarios:
   * 1. Re-enabling a feature that was disabled at runtime (was in disabledAtRuntime set)
   * 2. Enabling a feature that was initially disabled in config (hot-enable without restart)
   *
   * Validates dependencies (FEATURE_DEPENDENCIES + RUNTIME_SECURITY_DEPENDENCIES)
   * before enabling. Throws if enabling would create an invalid configuration.
   *
   * Requirements: 1.9
   */
  enableAtRuntime(feature: keyof FeatureGateFlags): void {
    const wasDisabledAtRuntime = this.disabledAtRuntime.has(feature);

    if (wasDisabledAtRuntime) {
      // Re-enable a runtime-disabled feature
      this.disabledAtRuntime.delete(feature);
      this.runtimeDisableReasons.delete(feature);
    } else if (this.flags[feature]) {
      // Already enabled and not runtime-disabled — nothing to do
      return;
    } else {
      // Hot-enable: set the flag to true in the internal flags object
      this.flags[feature] = true;
    }

    // Validate that enabling doesn't violate any constraints
    try {
      this.validateFeatureDependencies(feature);
    } catch (err) {
      // Roll back the enable
      if (wasDisabledAtRuntime) {
        this.disabledAtRuntime.add(feature);
      } else {
        this.flags[feature] = false;
      }
      throw err;
    }
  }

  /**
   * Get the reason a feature was disabled at runtime.
   */
  getRuntimeDisableReason(feature: keyof FeatureGateFlags): string | undefined {
    return this.runtimeDisableReasons.get(feature);
  }

  /**
   * Get all features that were disabled at runtime.
   */
  getRuntimeDisabledFeatures(): (keyof FeatureGateFlags)[] {
    return Array.from(this.disabledAtRuntime);
  }

  /**
   * Validate that a single feature's dependencies are met.
   * Checks both FEATURE_DEPENDENCIES and RUNTIME_SECURITY_DEPENDENCIES.
   */
  private validateFeatureDependencies(feature: keyof FeatureGateFlags): void {
    const allDependencies: FeatureDependency[] = [
      ...FEATURE_DEPENDENCIES,
      ...RUNTIME_SECURITY_DEPENDENCIES,
      ...ENHANCED_FEATURE_DEPENDENCIES,
      ...LOOP_ENGINE_DEPENDENCIES,
      ...KNOWLEDGE_TRAINING_DEPENDENCIES,
    ];

    for (const dep of allDependencies) {
      if (dep.feature !== feature) continue;

      if (dep.requires) {
        for (const req of dep.requires) {
          if (!this.isEnabled(req)) {
            throw new Error(
              `Cannot enable '${feature}': prerequisite '${req}' is not enabled.`,
            );
          }
        }
      }

      if (dep.requiresAny && dep.requiresAny.length > 0) {
        const hasAny = dep.requiresAny.some((req) => this.isEnabled(req));
        if (!hasAny) {
          const options = dep.requiresAny.join(' or ');
          throw new Error(
            `Cannot enable '${feature}': requires at least one of: ${options}.`,
          );
        }
      }

      if (dep.incompatible) {
        for (const incompat of dep.incompatible) {
          if (this.isEnabled(incompat)) {
            throw new Error(
              `Cannot enable '${feature}': incompatible with '${incompat}'.`,
            );
          }
        }
      }
    }
  }
}
