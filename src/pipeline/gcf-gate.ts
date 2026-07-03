/**
 * GCF expanded-scope gate helper.
 *
 * Shared by all four GCF-expanded surfaces (SharedMemory, SwarmMemoryPool,
 * SubAgentContextIsolator, DelegationEnvelope) to determine whether the
 * expanded GCF encoding path is active.
 *
 * The gate requires the conjunction of:
 *   1. PERF_FLAGS.GCF_WIRE_FORMAT === true (performance flag)
 *   2. featureGate.isEnabled('gcf_expanded_handoffs') === true (feature gate)
 *
 * Returns false when featureGate is null (graceful degradation).
 *
 * Requirements: 7.3, 7.4
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

/**
 * Check whether the expanded GCF encoding path is active.
 *
 * @param featureGate - The resolved feature gate system, or null if unavailable.
 * @returns true only when both GCF_WIRE_FORMAT perf flag AND gcf_expanded_handoffs
 *          feature gate are enabled.
 */
export function isGcfExpandedActive(featureGate: FeatureGateSystem | null): boolean {
  return (
    PERF_FLAGS.GCF_WIRE_FORMAT &&
    featureGate !== null &&
    featureGate.isEnabled('gcf_expanded_handoffs')
  );
}
