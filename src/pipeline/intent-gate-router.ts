/**
 * Intent Gate Router — Bridges the IntentGate classification to existing routing targets.
 *
 * Maps IntentDecision.intent to the appropriate handler:
 *   - 'conversation' → SimpleResponder (simple_responder route)
 *   - 'quick_action' → SingleStepExec (simple_responder route, single-step handler)
 *   - 'build'        → SpecInterviewEngine / orchestrator_pipeline route
 *   - 'ambiguous'    → DisambiguationManager (held for disambiguation)
 *
 * When the `unified_intent_gate` feature flag is disabled, all functions in this
 * module fall through to the legacy classification paths (no behavioral change).
 *
 * Requirements: 1.3, 1.4, 1.5, 1.6
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { IntentDecision, IIntentGate, SessionContext } from './intent-gate.js';
import type { RoutingDecision, MessageIntent } from './message-router.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type IntentRoute = 'simple_responder' | 'single_step_exec' | 'orchestrator_pipeline' | 'disambiguation';

export interface IntentRoutingResult {
  route: IntentRoute;
  decision: IntentDecision;
  legacyCompat: RoutingDecision; // Compatible RoutingDecision for existing consumers
}

// ─── Route Mapping ──────────────────────────────────────────────────────────

/**
 * Maps an IntentDecision to a routing target.
 *
 * Property 2 (Intent-based routing determinism): The routing target is determined
 * solely by the `intent` field. No other field influences the routing target.
 *
 * Requirements: 1.3, 1.4, 1.5
 */
export function mapIntentToRoute(decision: IntentDecision): IntentRoute {
  switch (decision.intent) {
    case 'conversation':
      return 'simple_responder';
    case 'quick_action':
      return 'single_step_exec';
    case 'build':
      return 'orchestrator_pipeline';
    case 'ambiguous':
      return 'disambiguation';
  }
}

/**
 * Converts an IntentDecision into a legacy-compatible RoutingDecision so existing
 * downstream consumers (IPC handlers, orchestrator pipeline) don't need modification.
 *
 * Requirements: 1.6 (sole classification call site, backward compatible)
 */
export function toLegacyRoutingDecision(decision: IntentDecision): RoutingDecision {
  let intentType: MessageIntent['type'];
  let legacyRoute: RoutingDecision['route'];

  switch (decision.intent) {
    case 'conversation':
      intentType = 'conversational';
      legacyRoute = 'simple_responder';
      break;
    case 'quick_action':
      // quick_action maps to simple_responder in legacy terms (single-step exec
      // is handled by the simple responder which has project context)
      intentType = 'conversational';
      legacyRoute = 'simple_responder';
      break;
    case 'build':
      intentType = 'build_task';
      legacyRoute = 'orchestrator_pipeline';
      break;
    case 'ambiguous':
      intentType = 'clarification';
      legacyRoute = 'clarification';
      break;
  }

  const intent: MessageIntent = {
    type: intentType,
    confidence: decision.confidence,
    reasoning: `IntentGate (stage: ${decision.stage}): ${decision.intent} — signals: ${decision.signals.join(', ')}`,
  };

  return { route: legacyRoute, intent };
}

/**
 * Full routing via the IntentGate — classifies the message and returns both
 * the native IntentRoutingResult and a legacy-compatible RoutingDecision.
 *
 * When the `unified_intent_gate` flag is disabled, returns null to signal
 * callers to fall through to the legacy classification path.
 *
 * Requirements: 1.3, 1.4, 1.5, 1.6
 */
export async function routeWithIntentGate(
  message: string,
  sessionContext: SessionContext,
  intentGate: IIntentGate,
  featureGate: FeatureGateSystem,
): Promise<IntentRoutingResult | null> {
  // When the flag is disabled, return null to indicate legacy fallback
  if (!featureGate.isEnabled('unified_intent_gate')) {
    return null;
  }

  const decision = await intentGate.classify(message, sessionContext);

  // If the gate returned an ambiguous/zero-confidence result because it's
  // internally disabled, fall through to legacy
  if (decision.confidence === 0 && decision.signals.some(s => s.includes('disabled'))) {
    return null;
  }

  const route = mapIntentToRoute(decision);
  const legacyCompat = toLegacyRoutingDecision(decision);

  return { route, decision, legacyCompat };
}

/**
 * Converts an IntentDecision intent label to a classification signal usable
 * by the AutoTuner. Maps the IntentGate taxonomy to the legacy intent-classifier
 * taxonomy for backward-compatible signal boosting.
 *
 * Requirements: 1.6 (sole classification call site)
 */
export function intentToLegacyClassification(decision: IntentDecision): { intent: string; confidence: number } {
  switch (decision.intent) {
    case 'conversation':
      return { intent: 'informational', confidence: decision.confidence };
    case 'quick_action':
      return { intent: 'execution', confidence: decision.confidence };
    case 'build':
      return { intent: 'execution', confidence: decision.confidence };
    case 'ambiguous':
      return { intent: 'ambiguous', confidence: decision.confidence };
  }
}
