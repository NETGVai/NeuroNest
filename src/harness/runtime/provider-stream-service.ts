/**
 * ProviderStreamService — Pinned provider-neutral streaming.
 *
 * Extends Provider_Registry (the existing authority for provider routing,
 * health-based failover, and provider format translation) with:
 *
 * - Route resolution: resolve provider/model/adapter/capabilities/capacity before dispatch
 * - Durable pinning: once a request starts, the route/adapter is pinned for that request
 * - Stream block translation: all required semantics translated to provider-neutral format
 * - Lossy route rejection: routes that cannot faithfully represent required blocks are rejected
 * - Empty response classification: responses without content/tool calls/refusal classified as errors
 * - Completion_Anchor: immutable identity appended at stream end
 * - Hot swap isolation: provider/route changes apply ONLY to later requests, not in-flight ones
 *
 * Requirements: 16.1–16.8
 */

import crypto from 'node:crypto';
import type {
  ProviderBlockV1,
  ContentBlockV1,
  ReasoningBlockV1,
  ToolCallBlockV1,
  UsageBlockV1,
  CompletionAnchorBlockV1,
  ProviderErrorBlockV1,
} from '../contracts/provider-block';
import type {
  ResolvedRoute,
  PinnedRouteRecord,
  RequiredSemantics,
  LossyRouteRejection,
  EmptyResponseClassification,
  CompletionAnchor,
  HotSwapRecord,
  StreamBlockSemantic,
  AdapterCapabilities,
  ProviderStreamRequest,
  StreamCompletionResult,
} from './provider-stream-schemas';

// ─── Types ──────────────────────────────────────────────────────

/**
 * Configuration for the adapter registry that Provider_Registry manages.
 */
export interface AdapterRegistryEntry {
  adapterId: string;
  adapterVersion: string;
  providerId: string;
  capabilities: AdapterCapabilities;
}

/**
 * Provider route configuration from the existing Provider_Registry.
 */
export interface ProviderRouteConfig {
  providerId: string;
  modelId: string;
  adapterId: string;
  adapterVersion: string;
  capabilities: {
    toolCalling: boolean;
    structuredOutput: boolean;
    reasoning: boolean;
    imageInput: boolean;
    streaming: boolean;
  };
  contextCapacity: number;
  routeDefaults?: Record<string, unknown>;
  healthy: boolean;
}

/**
 * Stream block received from a provider adapter (raw, pre-translation).
 */
export interface RawStreamBlock {
  kind: string;
  data: Record<string, unknown>;
}

/**
 * Callback for receiving translated stream blocks.
 */
export type StreamBlockCallback = (block: ProviderBlockV1, index: number) => void;

// ─── ProviderStreamService ──────────────────────────────────────

export class ProviderStreamService {
  /** Active pinned routes (requestId -> record) */
  private pinnedRoutes: Map<string, PinnedRouteRecord> = new Map();

  /** Registered adapters (adapterId::version -> entry) */
  private adapters: Map<string, AdapterRegistryEntry> = new Map();

  /** Current adapter versions (adapterId -> current version) */
  private currentAdapterVersions: Map<string, string> = new Map();

  /** Hot swap history */
  private hotSwapHistory: HotSwapRecord[] = [];

  /** Available routes from Provider_Registry */
  private routes: Map<string, ProviderRouteConfig> = new Map();

  /** Active stream block counts per request */
  private streamBlockCounts: Map<string, number> = new Map();

  /** Stream content tracking for empty response detection */
  private streamContentTracking: Map<string, {
    hasContent: boolean;
    hasToolCalls: boolean;
    hasRefusal: boolean;
    finishReason: string | undefined;
  }> = new Map();

  // ─── Adapter Registration ───────────────────────────────────────

  /**
   * Register an adapter with its capabilities.
   * Provider_Registry remains the sole authority for route selection.
   */
  registerAdapter(entry: AdapterRegistryEntry): void {
    const key = this.adapterKey(entry.adapterId, entry.adapterVersion);
    this.adapters.set(key, { ...entry });
    this.currentAdapterVersions.set(entry.adapterId, entry.adapterVersion);
  }

  /**
   * Get the current adapter version for an adapter ID.
   */
  getCurrentAdapterVersion(adapterId: string): string | undefined {
    return this.currentAdapterVersions.get(adapterId);
  }

  // ─── Route Registration ─────────────────────────────────────────

  /**
   * Register a provider route configuration.
   * This is maintained by Provider_Registry as the sole routing authority (Req 16.7).
   */
  registerRoute(config: ProviderRouteConfig): void {
    const key = this.routeKey(config.providerId, config.modelId);
    this.routes.set(key, { ...config });
  }

  /**
   * Remove a route from the registry.
   */
  removeRoute(providerId: string, modelId: string): void {
    const key = this.routeKey(providerId, modelId);
    this.routes.delete(key);
  }

  // ─── Route Resolution (Req 16.2) ─────────────────────────────────

  /**
   * Resolve provider, model, adapter version, capabilities, context capacity,
   * and route defaults before request dispatch.
   *
   * Requirement 16.2: Provider_Registry SHALL resolve these before dispatch.
   * Requirement 16.7: Provider_Registry SHALL remain the sole authority.
   */
  resolveRoute(providerId: string, modelId: string): ResolvedRoute | null {
    const key = this.routeKey(providerId, modelId);
    const config = this.routes.get(key);
    if (!config || !config.healthy) {
      return null;
    }

    const adapterVersion = this.currentAdapterVersions.get(config.adapterId);
    if (!adapterVersion) {
      return null;
    }

    return {
      routeId: this.generateId(),
      providerId: config.providerId,
      modelId: config.modelId,
      adapterId: config.adapterId,
      adapterVersion,
      capabilities: { ...config.capabilities },
      contextCapacity: config.contextCapacity,
      routeDefaults: config.routeDefaults,
      resolvedAt: new Date().toISOString(),
    };
  }

  // ─── Lossy Route Rejection (Req 16.8) ────────────────────────────

  /**
   * Validate that a resolved route can faithfully represent all required
   * stream block semantics. If not, reject the route before dispatch.
   *
   * Requirement 16.8: IF provider translation would lose required prompt,
   * reasoning, tool-call, or completion semantics, THEN reject that route.
   */
  validateRouteSemantics(
    route: ResolvedRoute,
    requiredSemantics: RequiredSemantics,
  ): LossyRouteRejection | null {
    const adapterKey = this.adapterKey(route.adapterId, route.adapterVersion);
    const adapter = this.adapters.get(adapterKey);

    if (!adapter) {
      return {
        routeId: route.routeId,
        providerId: route.providerId,
        modelId: route.modelId,
        adapterId: route.adapterId,
        missingSemantics: requiredSemantics.required as [StreamBlockSemantic, ...StreamBlockSemantic[]],
        reason: `Adapter ${route.adapterId}@${route.adapterVersion} not found`,
        rejectedAt: new Date().toISOString(),
      };
    }

    const supportedSet = new Set(adapter.capabilities.supportedSemantics);
    const missingSemantics: StreamBlockSemantic[] = [];

    for (const semantic of requiredSemantics.required) {
      if (!supportedSet.has(semantic)) {
        missingSemantics.push(semantic);
      }
    }

    // Also check capability flags against semantic requirements
    if (requiredSemantics.required.includes('reasoning') && !adapter.capabilities.supportsReasoning) {
      if (!missingSemantics.includes('reasoning')) {
        missingSemantics.push('reasoning');
      }
    }
    if (requiredSemantics.required.includes('tool_call_delta') && !adapter.capabilities.supportsToolCalls) {
      if (!missingSemantics.includes('tool_call_delta')) {
        missingSemantics.push('tool_call_delta');
      }
    }
    if (requiredSemantics.required.includes('tool_call_completion') && !adapter.capabilities.supportsToolCalls) {
      if (!missingSemantics.includes('tool_call_completion')) {
        missingSemantics.push('tool_call_completion');
      }
    }

    if (missingSemantics.length > 0) {
      return {
        routeId: route.routeId,
        providerId: route.providerId,
        modelId: route.modelId,
        adapterId: route.adapterId,
        missingSemantics: missingSemantics as [StreamBlockSemantic, ...StreamBlockSemantic[]],
        reason: `Route cannot faithfully represent semantics: ${missingSemantics.join(', ')}`,
        rejectedAt: new Date().toISOString(),
      };
    }

    return null; // Route is valid
  }

  // ─── Durable Pinning (Req 16.3) ──────────────────────────────────

  /**
   * Pin a resolved route to a specific request. Once pinned, the route/adapter
   * version is locked for this request through stream completion.
   *
   * Requirement 16.3: WHEN a provider request starts, pin the resolved adapter
   * and route versions through stream completion.
   */
  pinRoute(requestId: string, route: ResolvedRoute): PinnedRouteRecord {
    const record: PinnedRouteRecord = {
      requestId,
      route: { ...route },
      pinnedAt: new Date().toISOString(),
      completed: false,
    };
    this.pinnedRoutes.set(requestId, record);
    this.streamBlockCounts.set(requestId, 0);
    this.streamContentTracking.set(requestId, {
      hasContent: false,
      hasToolCalls: false,
      hasRefusal: false,
      finishReason: undefined,
    });
    return record;
  }

  /**
   * Get the pinned route for a request.
   */
  getPinnedRoute(requestId: string): PinnedRouteRecord | undefined {
    return this.pinnedRoutes.get(requestId);
  }

  /**
   * Get all active (non-completed) pinned request IDs.
   */
  getActiveRequestIds(): string[] {
    const active: string[] = [];
    for (const [requestId, record] of this.pinnedRoutes) {
      if (!record.completed) {
        active.push(requestId);
      }
    }
    return active;
  }

  // ─── Stream Block Translation (Req 16.1) ─────────────────────────

  /**
   * Translate a raw provider block to the canonical provider-neutral format.
   * The Provider_Stream represents text, reasoning, tool-call deltas, tool-call
   * completion, usage, finish reason, refusal, and error through versioned
   * content-block events.
   *
   * Requirement 16.1: THE Provider_Stream SHALL represent text, reasoning,
   * tool-call deltas, tool-call completion, usage, finish reason, refusal,
   * and error through versioned content-block events.
   */
  translateBlock(requestId: string, raw: RawStreamBlock): ProviderBlockV1 | null {
    const pinned = this.pinnedRoutes.get(requestId);
    if (!pinned || pinned.completed) {
      return null;
    }

    const tracking = this.streamContentTracking.get(requestId);
    const blockIndex = this.streamBlockCounts.get(requestId) ?? 0;
    const blockId = this.generateId();

    let translated: ProviderBlockV1 | null = null;

    switch (raw.kind) {
      case 'text':
      case 'code':
      case 'markdown': {
        const contentType = raw.kind === 'text' ? 'text' :
          raw.kind === 'code' ? 'code' : 'markdown';
        translated = {
          kind: 'content' as const,
          blockId,
          contentType,
          text: String(raw.data['text'] ?? ''),
          isFinal: Boolean(raw.data['isFinal'] ?? false),
        };
        if (tracking) tracking.hasContent = true;
        break;
      }
      case 'reasoning': {
        translated = {
          kind: 'reasoning' as const,
          blockId,
          summary: raw.data['summary'] != null ? String(raw.data['summary']) : undefined,
          redacted: Boolean(raw.data['redacted'] ?? true),
        };
        if (tracking) tracking.hasContent = true;
        break;
      }
      case 'tool_call': {
        translated = {
          kind: 'tool_call' as const,
          blockId,
          callId: String(raw.data['callId'] ?? this.generateId()),
          toolName: String(raw.data['toolName'] ?? ''),
          arguments: String(raw.data['arguments'] ?? '{}'),
          modelOrderIndex: Number(raw.data['modelOrderIndex'] ?? blockIndex),
        };
        if (tracking) tracking.hasToolCalls = true;
        break;
      }
      case 'usage': {
        translated = {
          kind: 'usage' as const,
          blockId,
          inputTokens: Number(raw.data['inputTokens'] ?? 0),
          outputTokens: Number(raw.data['outputTokens'] ?? 0),
          cacheReadTokens: raw.data['cacheReadTokens'] != null
            ? Number(raw.data['cacheReadTokens'])
            : undefined,
          cacheWriteTokens: raw.data['cacheWriteTokens'] != null
            ? Number(raw.data['cacheWriteTokens'])
            : undefined,
          totalTokens: Number(raw.data['totalTokens'] ??
            (Number(raw.data['inputTokens'] ?? 0) + Number(raw.data['outputTokens'] ?? 0))),
        };
        break;
      }
      case 'error': {
        translated = {
          kind: 'error' as const,
          blockId,
          errorCode: String(raw.data['errorCode'] ?? 'unknown'),
          message: String(raw.data['message'] ?? ''),
          retryable: Boolean(raw.data['retryable'] ?? false),
          routeId: pinned.route.routeId,
        };
        break;
      }
      case 'refusal': {
        // Refusals are represented as error blocks with a specific code
        translated = {
          kind: 'error' as const,
          blockId,
          errorCode: 'refusal',
          message: String(raw.data['message'] ?? 'Content refused by provider'),
          retryable: false,
          routeId: pinned.route.routeId,
        };
        if (tracking) tracking.hasRefusal = true;
        break;
      }
      case 'finish': {
        // Finish blocks update tracking but don't produce a translated block
        if (tracking) {
          tracking.finishReason = String(raw.data['reason'] ?? 'stop');
        }
        return null;
      }
      default:
        return null;
    }

    if (translated) {
      this.streamBlockCounts.set(requestId, blockIndex + 1);
    }

    return translated;
  }

  // ─── Empty Response Classification (Req 16.6) ────────────────────

  /**
   * Classify a response as empty if it completed without content, tool calls,
   * refusal, or a recognized terminal reason.
   *
   * Requirement 16.6: IF a stream completes without content, tool calls,
   * refusal, or a recognized terminal reason, classify as empty-response error.
   */
  classifyEmptyResponse(requestId: string): EmptyResponseClassification | null {
    const tracking = this.streamContentTracking.get(requestId);
    if (!tracking) {
      return null;
    }

    const pinned = this.pinnedRoutes.get(requestId);
    if (!pinned) {
      return null;
    }

    // If there's content, tool calls, or refusal, it's not empty
    if (tracking.hasContent || tracking.hasToolCalls || tracking.hasRefusal) {
      return null;
    }

    // If there's a recognized terminal finish reason (not just "stop" with no content), not empty
    const recognizedTerminalReasons = ['length', 'content_filter'];
    if (tracking.finishReason && recognizedTerminalReasons.includes(tracking.finishReason)) {
      return null;
    }

    // Classify as empty response error
    return {
      requestId,
      routeId: pinned.route.routeId,
      hasFinishReason: tracking.finishReason !== undefined,
      finishReason: tracking.finishReason,
      hasContentBlocks: false,
      hasToolCalls: false,
      hasRefusal: false,
      errorCode: 'empty_response' as const,
      classifiedAt: new Date().toISOString(),
    };
  }

  // ─── Completion Anchor (Req 16.5) ────────────────────────────────

  /**
   * Append a Completion_Anchor at stream end. Binds to Prompt_Fingerprint,
   * route identity, request identity, and final content-block sequence.
   *
   * Requirement 16.5: WHEN an assistant response completes, append one
   * Completion_Anchor bound to Prompt_Fingerprint, route identity, request
   * identity, and final content-block sequence.
   */
  createCompletionAnchor(
    requestId: string,
    promptFingerprint: string,
    finishReason: 'stop' | 'tool_use' | 'length' | 'content_filter' | 'error',
  ): CompletionAnchor | null {
    const pinned = this.pinnedRoutes.get(requestId);
    if (!pinned) {
      return null;
    }

    const blockCount = this.streamBlockCounts.get(requestId) ?? 0;

    const anchor: CompletionAnchor = {
      anchorId: this.generateId(),
      requestId,
      promptFingerprint,
      routeId: pinned.route.routeId,
      providerId: pinned.route.providerId,
      modelId: pinned.route.modelId,
      finalBlockSequence: blockCount,
      finishReason,
      anchoredAt: new Date().toISOString(),
    };

    return anchor;
  }

  // ─── Stream Completion ────────────────────────────────────────────

  /**
   * Complete a stream: classify the response, create anchor, and unpin the route.
   * This is the primary completion API that handles all terminal semantics.
   */
  completeStream(
    requestId: string,
    promptFingerprint: string,
    finishReason?: 'stop' | 'tool_use' | 'length' | 'content_filter' | 'error',
  ): StreamCompletionResult {
    const pinned = this.pinnedRoutes.get(requestId);
    if (!pinned) {
      return {
        status: 'error' as const,
        requestId,
        errorCode: 'not_pinned',
        message: `No pinned route found for request ${requestId}`,
        retryable: false,
        occurredAt: new Date().toISOString(),
      };
    }

    // Check for empty response
    const emptyClassification = this.classifyEmptyResponse(requestId);
    if (emptyClassification) {
      this.markCompleted(requestId);
      return {
        status: 'empty_response' as const,
        requestId,
        classification: emptyClassification,
      };
    }

    // Create completion anchor
    const resolvedFinish = finishReason ?? this.inferFinishReason(requestId);
    const anchor = this.createCompletionAnchor(requestId, promptFingerprint, resolvedFinish);
    if (!anchor) {
      return {
        status: 'error' as const,
        requestId,
        errorCode: 'anchor_creation_failed',
        message: 'Failed to create completion anchor',
        retryable: false,
        occurredAt: new Date().toISOString(),
      };
    }

    const blockCount = this.streamBlockCounts.get(requestId) ?? 0;
    this.markCompleted(requestId);

    return {
      status: 'completed' as const,
      requestId,
      anchor,
      blockCount,
      completedAt: new Date().toISOString(),
    };
  }

  // ─── Hot Swap Isolation (Req 16.4) ────────────────────────────────

  /**
   * Apply a hot swap to the adapter version. The new adapter applies ONLY to
   * requests created AFTER the swap. In-flight (pinned) requests retain their
   * original adapter version.
   *
   * Requirement 16.4: IF a hot swap occurs during an active request, apply the
   * new adapter only to requests created after the swap.
   */
  hotSwapAdapter(adapterId: string, newVersion: string, newCapabilities: AdapterCapabilities): HotSwapRecord {
    const previousVersion = this.currentAdapterVersions.get(adapterId);
    const activeRequestIds = this.getActiveRequestIds();

    // Record the swap
    const swapRecord: HotSwapRecord = {
      swapId: this.generateId(),
      previousAdapterVersion: previousVersion ?? 'unknown',
      newAdapterVersion: newVersion,
      swappedAt: new Date().toISOString(),
      activeRequestIds: [...activeRequestIds],
    };
    this.hotSwapHistory.push(swapRecord);

    // Register new adapter version — active requests keep their pinned version
    const newEntry: AdapterRegistryEntry = {
      adapterId,
      adapterVersion: newVersion,
      providerId: newCapabilities.adapterId, // Use adapterId for association
      capabilities: newCapabilities,
    };
    this.registerAdapter(newEntry);

    // Update current version — only future route resolutions will use this
    this.currentAdapterVersions.set(adapterId, newVersion);

    return swapRecord;
  }

  /**
   * Apply a hot swap to a route configuration. The new route applies ONLY to
   * requests created AFTER the swap.
   *
   * Requirement 16.4: hot swaps apply only to later requests.
   */
  hotSwapRoute(
    providerId: string,
    modelId: string,
    newConfig: Partial<ProviderRouteConfig>,
  ): HotSwapRecord {
    const key = this.routeKey(providerId, modelId);
    const existing = this.routes.get(key);
    const activeRequestIds = this.getActiveRequestIds();

    const swapRecord: HotSwapRecord = {
      swapId: this.generateId(),
      previousAdapterVersion: existing?.adapterVersion ?? 'unknown',
      newAdapterVersion: newConfig.adapterVersion ?? existing?.adapterVersion ?? 'unknown',
      previousRouteId: key,
      newRouteId: key,
      swappedAt: new Date().toISOString(),
      activeRequestIds: [...activeRequestIds],
    };
    this.hotSwapHistory.push(swapRecord);

    // Merge new configuration — only future resolutions use it
    if (existing) {
      this.routes.set(key, { ...existing, ...newConfig });
    }

    return swapRecord;
  }

  /**
   * Get hot swap history.
   */
  getHotSwapHistory(): readonly HotSwapRecord[] {
    return this.hotSwapHistory;
  }

  // ─── Full Request Lifecycle ───────────────────────────────────────

  /**
   * Start a provider stream request: resolve, validate, and pin the route.
   * Returns the pinned route or a rejection/error.
   *
   * This is the primary entry point that enforces all requirements:
   * - Resolves route (16.2)
   * - Validates semantics / rejects lossy routes (16.8)
   * - Pins the route durably (16.3)
   * - Provider_Registry remains sole authority (16.7)
   */
  startStream(request: ProviderStreamRequest, providerId: string, modelId: string): StreamCompletionResult | PinnedRouteRecord {
    // 1. Resolve route
    const route = this.resolveRoute(providerId, modelId);
    if (!route) {
      return {
        status: 'error' as const,
        requestId: request.requestId,
        errorCode: 'route_unavailable',
        message: `No healthy route available for ${providerId}/${modelId}`,
        retryable: true,
        occurredAt: new Date().toISOString(),
      };
    }

    // 2. Validate semantics — reject lossy routes before dispatch
    const rejection = this.validateRouteSemantics(route, request.requiredSemantics);
    if (rejection) {
      return {
        status: 'rejected' as const,
        requestId: request.requestId,
        rejection,
      };
    }

    // 3. Pin the route durably
    const pinned = this.pinRoute(request.requestId, route);
    return pinned;
  }

  // ─── Utility ──────────────────────────────────────────────────────

  /**
   * Mark a request as completed and clean up tracking state.
   */
  private markCompleted(requestId: string): void {
    const pinned = this.pinnedRoutes.get(requestId);
    if (pinned) {
      pinned.completed = true;
      pinned.completedAt = new Date().toISOString();
    }
    this.streamContentTracking.delete(requestId);
  }

  /**
   * Infer finish reason from stream tracking state.
   */
  private inferFinishReason(requestId: string): 'stop' | 'tool_use' | 'length' | 'content_filter' | 'error' {
    const tracking = this.streamContentTracking.get(requestId);
    if (!tracking) return 'stop';

    if (tracking.finishReason) {
      const mapped: Record<string, 'stop' | 'tool_use' | 'length' | 'content_filter' | 'error'> = {
        stop: 'stop',
        tool_use: 'tool_use',
        tool_calls: 'tool_use',
        length: 'length',
        content_filter: 'content_filter',
        error: 'error',
      };
      return mapped[tracking.finishReason] ?? 'stop';
    }

    if (tracking.hasToolCalls) return 'tool_use';
    return 'stop';
  }

  private routeKey(providerId: string, modelId: string): string {
    return `${providerId}::${modelId}`;
  }

  private adapterKey(adapterId: string, version: string): string {
    return `${adapterId}@${version}`;
  }

  private generateId(): string {
    return crypto.randomUUID();
  }
}
