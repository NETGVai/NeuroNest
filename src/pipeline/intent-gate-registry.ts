/**
 * Intent Gate Registry — Singleton registry for IntentGate and FeatureGateSystem instances.
 *
 * Provides global access to the IntentGate instance from any module in the pipeline.
 * The registry is populated during application initialization and used by the
 * message-router and IPC handlers to access the unified classification system.
 *
 * When the IntentGate has not been registered (e.g., during tests or before
 * initialization), getter functions return null to signal callers to fall through
 * to legacy classification paths.
 *
 * Requirements: 1.6, 14.1
 */

import type { IIntentGate } from './intent-gate.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';

// ─── Singleton State ────────────────────────────────────────────────────────

let intentGateInstance: IIntentGate | null = null;
let featureGateInstance: FeatureGateSystem | null = null;

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register the IntentGate instance for global access.
 * Should be called once during application initialization after the IntentGate
 * is constructed with its dependencies (PatternClassifier, LLMClassifier, ContextPrior).
 */
export function registerIntentGate(gate: IIntentGate): void {
  intentGateInstance = gate;
}

/**
 * Register the FeatureGateSystem instance for global access.
 * Should be called once during application initialization.
 */
export function registerFeatureGate(gate: FeatureGateSystem): void {
  featureGateInstance = gate;
}

// ─── Access ─────────────────────────────────────────────────────────────────

/**
 * Get the registered IntentGate instance.
 * Returns null if the IntentGate has not been registered yet (callers should
 * fall through to legacy classification).
 */
export function getIntentGateInstance(): IIntentGate | null {
  return intentGateInstance;
}

/**
 * Get the registered FeatureGateSystem instance.
 * Returns null if no FeatureGateSystem has been registered.
 */
export function getFeatureGateInstance(): FeatureGateSystem | null {
  return featureGateInstance;
}

// ─── Testing Utilities ──────────────────────────────────────────────────────

/**
 * Reset the registry (for testing purposes only).
 * Clears both registered instances.
 */
export function resetIntentGateRegistry(): void {
  intentGateInstance = null;
  featureGateInstance = null;
}
