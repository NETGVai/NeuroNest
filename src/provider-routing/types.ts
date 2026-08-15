/**
 * Types for capability-aware provider routing and resilient fallback.
 *
 * Defines the data structures used by ProviderRouteService to select
 * per-role routes from registry capabilities, privacy, locality, trust,
 * health, context size, latency, cost, and user locks.
 *
 * Requirements: 36.1, 36.2, 36.3, 36.4, 36.5, 36.6, 36.7, 36.8, 36.9, 36.10
 */

// ─── Trust Levels ───────────────────────────────────────────────

/**
 * Trust levels ordered from most trusted to least trusted.
 * Fallback chains must be monotonic: a fallback cannot expose data
 * to a less-trusted destination.
 */
export enum TrustLevel {
  /** Local model running on-device */
  Local = 0,
  /** Self-hosted or on-premises provider */
  SelfHosted = 1,
  /** Trusted third-party with data processing agreement */
  Trusted = 2,
  /** External cloud provider */
  External = 3,
}

// ─── Model Roles ────────────────────────────────────────────────

/**
 * Supported model roles for independent routing.
 * Each role may have its own provider route and fallback chain.
 */
export type ModelRole =
  | 'planning'
  | 'chat'
  | 'autocomplete'
  | 'code_editing'
  | 'change_application'
  | 'embedding'
  | 'reranking'
  | 'review'
  | 'summarization';

// ─── Provider Capabilities ──────────────────────────────────────

/**
 * Describes the capabilities of a registered model/provider.
 * Used for routing decisions and capability matching.
 *
 * Requirement 36.1: context window, tool-calling mode, structured-output support,
 * image support, edit/FIM suitability, reasoning controls, latency class, cost,
 * locality, endpoint trust, and availability.
 */
export interface ProviderCapabilities {
  /** Unique provider identifier */
  providerId: string;
  /** Model identifier at this provider */
  modelId: string;
  /** Human-readable provider name */
  providerName: string;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Whether the model supports tool/function calling */
  toolCalling: boolean;
  /** Whether the model supports structured JSON output */
  structuredOutput: boolean;
  /** Whether the model supports image inputs */
  imageSupport: boolean;
  /** Whether the model is suitable for edit/FIM tasks */
  editSuitability: boolean;
  /** Whether the model supports reasoning controls */
  reasoningControls: boolean;
  /** Expected latency class */
  latencyClass: 'low' | 'medium' | 'high';
  /** Cost per 1K tokens (input + output average) in USD */
  costPer1kTokens: number;
  /** Locality: where the model runs */
  locality: 'local' | 'self-hosted' | 'cloud';
  /** Trust level for privacy-aware routing */
  trustLevel: TrustLevel;
  /** Supported model roles */
  supportedRoles: ModelRole[];
  /** Whether the provider is currently healthy */
  healthy: boolean;
  /** Observed health score 0-1 based on recent success/latency */
  healthScore: number;
  /** Observed average first-token latency in milliseconds */
  observedLatencyMs: number;
  /** Recent availability ratio 0-1 */
  availability: number;
  /** Token accounting method — how to count actual tokens for this provider */
  tokenAccountingMethod: 'exact' | 'estimated' | 'provider_reported';
  /** Tokens per unit for cost calculation (e.g. 1000 for per-1K pricing) */
  tokenPricingUnit: number;
  /** Input cost per pricing unit in USD */
  inputCostPerUnit: number;
  /** Output cost per pricing unit in USD */
  outputCostPerUnit: number;
}

// ─── Routing Constraints ────────────────────────────────────────

/**
 * Constraints applied when selecting a provider for a role.
 */
export interface RoutingConstraints {
  /** Required model role */
  role: ModelRole;
  /** Minimum context window tokens required */
  minContextSize?: number;
  /** Maximum acceptable latency in milliseconds */
  maxLatencyMs?: number;
  /** Maximum cost per 1K tokens in USD */
  maxCostPer1kTokens?: number;
  /** Required capabilities */
  requireToolCalling?: boolean;
  requireStructuredOutput?: boolean;
  requireImageSupport?: boolean;
  requireEditSuitability?: boolean;
  requireReasoningControls?: boolean;
  /** Privacy constraints */
  maxTrustLevel?: TrustLevel;
  /** Required locality */
  requiredLocality?: 'local' | 'self-hosted' | 'cloud';
  /** User-locked provider (takes precedence over all other constraints) */
  lockedProviderId?: string;
  /** User-locked model (takes precedence over all other constraints) */
  lockedModelId?: string;
  /** Disable fallback entirely for this request */
  disableFallback?: boolean;
}

// ─── Routing Decision ───────────────────────────────────────────

/**
 * The result of a routing decision, including the selected provider
 * and an explanation of why it was chosen.
 */
export interface RoutingDecision {
  /** Selected provider ID */
  providerId: string;
  /** Selected model ID */
  modelId: string;
  /** Provider name for display */
  providerName: string;
  /** The role this decision is for */
  role: ModelRole;
  /** Trust level of the selected provider */
  trustLevel: TrustLevel;
  /** Explanation of why this provider was selected */
  explanation: string;
  /** Whether this is a fallback selection */
  isFallback: boolean;
  /** The fallback chain available (in order of preference) */
  fallbackChain: FallbackEntry[];
  /** Whether routing is paused (provider unavailable, no fallback) */
  paused: boolean;
  /** Reason for pause if paused */
  pauseReason?: string;
}

/**
 * An entry in a fallback chain.
 */
export interface FallbackEntry {
  providerId: string;
  modelId: string;
  trustLevel: TrustLevel;
}

// ─── Request Envelope ───────────────────────────────────────────

/**
 * Wraps every provider request with correlation, timeout,
 * cancellation, and concurrency controls.
 *
 * Requirement 36.6: correlation, timeout, cancellation, retry classification,
 * per-route concurrency limits.
 */
export interface ProviderRequestEnvelope {
  /** Unique correlation ID for tracing this request across systems */
  correlationId: string;
  /** Role this request is for */
  role: ModelRole;
  /** Provider routing decision */
  routingDecision: RoutingDecision;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Cancellation signal */
  cancelled: boolean;
  /** Timestamp when the request was created */
  createdAt: number;
  /** Task ID for cost attribution */
  taskId?: string;
  /** Agent run ID for cost attribution */
  runId?: string;
  /** Delivery loop stage for cost attribution */
  deliveryStage?: string;
}

// ─── Response Metadata ──────────────────────────────────────────

/**
 * Metadata included in every response from a routed provider.
 * Exposes actual model, latency, token count, cost, and confidence.
 *
 * Requirement 36.7: provider-appropriate token accounting.
 * Requirement 36.10: cost attributed to Task, Agent_Run, stage, role, route.
 */
export interface ResponseMetadata {
  /** Actual model used (may differ from requested if fallback occurred) */
  actualModel: string;
  /** Actual provider used */
  actualProvider: string;
  /** Response latency in milliseconds */
  latencyMs: number;
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens used */
  outputTokens: number;
  /** Total tokens used (input + output) */
  totalTokens: number;
  /** Estimated cost in USD based on provider-appropriate accounting */
  costUsd: number;
  /** Confidence score 0-1 (based on provider health and response quality) */
  confidence: number;
  /** The role this response was for */
  role: ModelRole;
  /** Whether a fallback was used */
  usedFallback: boolean;
  /** Correlation identifier for tracing */
  correlationId: string;
  /** Token accounting method used */
  tokenAccountingMethod: 'exact' | 'estimated' | 'provider_reported';
  /** Task ID for cost attribution */
  taskId?: string;
  /** Agent run ID for cost attribution */
  runId?: string;
  /** Delivery loop stage for cost attribution */
  deliveryStage?: string;
}

// ─── Fallback Chain Configuration ───────────────────────────────

/**
 * Configuration for a pre-approved fallback chain for a specific role.
 * Chains must be monotonic in trust: each subsequent entry must have
 * a trust level equal to or greater than (less trusted than) the previous.
 *
 * Requirement 36.5: Fallback never silently moves source context from a
 * local or trusted route to a less-trusted external provider.
 */
export interface FallbackChainConfig {
  /** The role this chain applies to */
  role: ModelRole;
  /** Ordered list of provider/model pairs, monotonically increasing in trust level */
  chain: FallbackEntry[];
  /** Maximum trust level allowed for this chain */
  maxTrustLevel: TrustLevel;
}

// ─── Provider Health ────────────────────────────────────────────

/**
 * Health observation record for a provider.
 *
 * Requirement 36.8: health based on observed success, error class,
 * first-token latency, completion latency, and recent availability.
 */
export interface ProviderHealthObservation {
  providerId: string;
  modelId: string;
  timestamp: number;
  success: boolean;
  /** First-token latency in milliseconds */
  firstTokenLatencyMs?: number;
  /** Total completion latency in milliseconds */
  completionLatencyMs: number;
  /** Error class when not successful */
  errorClass?: ProviderErrorClass;
  /** Token count from this observation */
  tokenCount?: number;
}

/**
 * Classification of provider errors for retry decisions.
 *
 * Requirement 36.6: retry classification.
 */
export type ProviderErrorClass =
  | 'transient'      // Temporary failure, safe to retry (e.g. 503, timeout)
  | 'rate_limited'   // Rate limited, retry after backoff
  | 'auth_failure'   // Authentication issue, do not retry without fix
  | 'invalid_request'// Bad request, do not retry without change
  | 'model_overloaded' // Model capacity issue, try fallback
  | 'context_exceeded' // Context window exceeded, reduce input
  | 'content_filter' // Content policy violation, do not retry
  | 'server_error'   // Server-side error, may be retried
  | 'network_error'  // Network connectivity issue, may be retried
  | 'cancelled'      // Request was cancelled, do not retry
  | 'unknown';       // Unclassified error

/**
 * Whether a given error class is retryable.
 */
export function isRetryableError(errorClass: ProviderErrorClass): boolean {
  switch (errorClass) {
    case 'transient':
    case 'rate_limited':
    case 'model_overloaded':
    case 'server_error':
    case 'network_error':
      return true;
    case 'auth_failure':
    case 'invalid_request':
    case 'context_exceeded':
    case 'content_filter':
    case 'cancelled':
    case 'unknown':
      return false;
  }
}

// ─── Concurrency Tracking ───────────────────────────────────────

/**
 * Per-route concurrency configuration and state.
 *
 * Requirement 36.6: per-route concurrency limits.
 */
export interface RouteConcurrencyConfig {
  /** Maximum concurrent requests for this route */
  maxConcurrent: number;
  /** Current active request count */
  activeCount: number;
}

// ─── Cost Attribution ───────────────────────────────────────────

/**
 * Cost record attributed to Task, Agent_Run, Delivery_Loop stage, role, and route.
 *
 * Requirement 36.10: cost and token usage attributed without recording source content.
 */
export interface CostAttribution {
  /** Correlation ID of the request */
  correlationId: string;
  /** Task ID */
  taskId?: string;
  /** Agent run ID */
  runId?: string;
  /** Delivery loop stage */
  deliveryStage?: string;
  /** Model role used */
  role: ModelRole;
  /** Provider route used */
  providerId: string;
  /** Model used */
  modelId: string;
  /** Input tokens */
  inputTokens: number;
  /** Output tokens */
  outputTokens: number;
  /** Cost in USD */
  costUsd: number;
  /** Token accounting method */
  tokenAccountingMethod: 'exact' | 'estimated' | 'provider_reported';
  /** Timestamp */
  timestamp: number;
}

// ─── User Lock Configuration ────────────────────────────────────

/**
 * User lock binding a role to a specific provider/model.
 *
 * Requirement 36.9: lock a Task or session to a model and disable all fallback.
 */
export interface UserLock {
  /** The role being locked */
  role: ModelRole;
  /** Provider to lock to */
  providerId: string;
  /** Model to lock to */
  modelId: string;
  /** Scope of the lock */
  scope: 'global' | 'session' | 'task';
  /** Associated task ID if scope is 'task' */
  taskId?: string;
  /** Associated session ID if scope is 'session' */
  sessionId?: string;
  /** Whether to disable all fallback when locked */
  disableFallback: boolean;
}
