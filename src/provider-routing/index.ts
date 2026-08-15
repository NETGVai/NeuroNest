/**
 * Provider Routing — Capability-aware model routing and resilient fallback.
 *
 * Exports:
 * - ProviderRouteService: Main routing service
 * - Types: All routing-related type definitions
 *
 * Requirements: 36.1, 36.2, 36.3, 36.4, 36.5, 36.6, 36.7, 36.8, 36.9, 36.10
 */

export { ProviderRouteService } from './provider-route-service.js';
export {
  type CostAttribution,
  type FallbackChainConfig,
  type FallbackEntry,
  type ModelRole,
  type ProviderCapabilities,
  type ProviderErrorClass,
  type ProviderHealthObservation,
  type ProviderRequestEnvelope,
  type ResponseMetadata,
  type RouteConcurrencyConfig,
  type RoutingConstraints,
  type RoutingDecision,
  type UserLock,
  TrustLevel,
  isRetryableError,
} from './types.js';
