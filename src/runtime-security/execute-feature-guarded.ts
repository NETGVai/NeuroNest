/**
 * executeFeatureGuarded — Wraps subsystem operations for graceful degradation.
 *
 * When a runtime security subsystem throws an unhandled error:
 * 1. Disables only that subsystem via FeatureGateSystem.disableAtRuntime()
 * 2. Logs the error via the provided logger
 * 3. Returns undefined, allowing the agent loop to continue without affecting other subsystems
 *
 * This ensures a single faulting subsystem cannot bring down the entire
 * security pipeline or the agent loop.
 *
 * Requirements: 1.8
 */

import type { FeatureGateFlags } from '../feature-gate/feature-gate-config.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

/**
 * Wraps a subsystem operation so that any unhandled error:
 * 1. Disables only that subsystem via FeatureGateSystem.disableAtRuntime()
 * 2. Logs the error via the provided logger
 * 3. Continues operation without affecting other subsystems
 *
 * @param feature - The feature flag key identifying the subsystem
 * @param featureGate - The FeatureGateSystem instance for runtime disable
 * @param operation - The async or sync operation to guard
 * @param logger - Logger with an error method for recording failures
 * @returns The operation result, or undefined if the operation threw
 */
export async function executeFeatureGuarded<T>(
  feature: keyof FeatureGateFlags,
  featureGate: FeatureGateSystem,
  operation: () => Promise<T> | T,
  logger: { error: (msg: string, ...args: unknown[]) => void },
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;

    // Disable only the faulting subsystem
    featureGate.disableAtRuntime(
      feature,
      `Unhandled error: ${errorMessage}`,
    );

    // Log the error with full context
    logger.error(
      `[RuntimeSecurity] Subsystem '${feature}' disabled due to unhandled error: ${errorMessage}`,
      { feature, error: err, stack: errorStack },
    );

    return undefined;
  }
}
