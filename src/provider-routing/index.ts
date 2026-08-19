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
  InferenceRouteCoordinator,
  classifyTransport,
  type EntitlementPreflightFn,
  type InferenceRouteCoordinatorDependencies,
  type InferenceRouteFailedClosed,
  type InferenceRouteFailureCode,
  type InferenceRouteRequest,
  type InferenceRouteResolution,
  type InferenceRouteResolved,
  type ProxyCredentialStatusReader,
} from './inference-route-coordinator.js';
export {
  CoordinatedInferenceClient,
  type CloudTransportBinding,
  type CoordinatedInferenceClientDependencies,
  type CoordinatedInferenceClientResolved,
  type CoordinatedInferenceFailure,
  type CoordinatedInferenceFailureCode,
  type CoordinatedInferenceOutcome,
  type CoordinatedRequestContext,
  type LocalAdapterFactory,
  type LocalAdapterFactoryInput,
} from './coordinated-inference-client.js';
export * from './proxy-contracts.js';
export {
  INVOCATION_SOURCE_TRANSPORT_BEHAVIOR,
  MODEL_ROLE_TRANSPORT_BEHAVIOR,
  TRANSPORT_CLASS_BY_PROVIDER_LOCALITY,
  type CostAttribution,
  type FallbackChainConfig,
  type FallbackEntry,
  type InferenceInvocationSource,
  type InferenceRoute,
  type ModelRole,
  type ProviderCapabilities,
  type ProviderErrorClass,
  type ProviderHealthObservation,
  type ProviderLocality,
  type ProviderRequestEnvelope,
  type ResponseMetadata,
  type RouteConcurrencyConfig,
  type RoutingConstraints,
  type RoutingDecision,
  type TransportBehavior,
  type TransportClass,
  type UserLock,
  TrustLevel,
  isRetryableError,
} from './types.js';
