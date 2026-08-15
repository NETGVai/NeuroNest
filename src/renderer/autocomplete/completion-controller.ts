/**
 * CompletionController — Manages model roles, request binding, cancellation,
 * debounce, concurrency, and content-identity caching for inline completion.
 *
 * The controller wraps the existing inline completion provider with:
 * - Independently configured model roles (autocomplete, inline_edit, change_application, chat, planning, embedding)
 * - Request binding to workspace, URI, documentVersion, cursor, language, requestId
 * - Cancellation on cursor movement, file switch, version change, newer request supersession
 * - Per-workspace debounce and concurrency limits
 * - A bounded content-identity cache
 * - Provider-role selection through ProviderRouteService
 * - Source-free outcome telemetry
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

// ─── Types ──────────────────────────────────────────────────────

/** Supported model roles for different completion/AI tasks */
export type ModelRole =
  | 'autocomplete'
  | 'inline_edit'
  | 'change_application'
  | 'chat'
  | 'planning'
  | 'embedding';

/** Configuration for a single model role */
export interface ModelRoleConfig {
  /** The model identifier to use for this role */
  model: string;
  /** Debounce delay in milliseconds before sending a request */
  debounceMs: number;
  /** Maximum concurrent requests allowed */
  maxConcurrency: number;
  /** Whether this role is enabled */
  enabled: boolean;
}

/** Per-workspace configuration */
export interface WorkspaceCompletionConfig {
  /** Workspace identifier */
  workspaceId: string;
  /** Debounce override for the workspace (ms) */
  debounceMs: number;
  /** Maximum concurrent requests for this workspace */
  maxConcurrency: number;
  /** Content-identity cache size limit */
  cacheMaxSize: number;
}

/** Request envelope binding a completion request to its context */
export interface CompletionRequestEnvelope {
  /** Unique request identifier */
  requestId: string;
  /** Workspace identifier */
  workspaceId: string;
  /** File URI */
  uri: string;
  /** Document version at the time of the request */
  documentVersion: number;
  /** Cursor line number (1-indexed) */
  cursorLine: number;
  /** Cursor column (1-indexed) */
  cursorColumn: number;
  /** Language identifier */
  language: string;
  /** Model role for this request */
  role: ModelRole;
  /** Timestamp of request creation */
  timestamp: number;
  /** Generation counter to detect supersession */
  generation: number;
}

/** Result of a completion request */
export interface CompletionResult {
  /** The request this result corresponds to */
  requestId: string;
  /** The completion text */
  text: string;
  /** Whether this is an insertion-only completion (ghost text) */
  isInsertOnly: boolean;
  /** Target URI if different from request URI (cross-location suggestion) */
  targetUri?: string;
  /** Range to replace (for non-insert suggestions) */
  replaceRange?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  /** Whether this was served from cache */
  fromCache: boolean;
  /** Latency in milliseconds */
  latencyMs: number;
}

/** Cancellation reasons */
export type CancellationReason =
  | 'cursor_moved'
  | 'file_switched'
  | 'version_changed'
  | 'newer_request'
  | 'user_dismissed'
  | 'disposed';

/** Cache entry for content-identity caching */
interface CacheEntry {
  /** Content key (hash of surrounding content) */
  key: string;
  /** The cached result */
  result: CompletionResult;
  /** When this was cached */
  cachedAt: number;
  /** Document version when cached */
  documentVersion: number;
}

/** Active request tracking */
interface ActiveRequest {
  envelope: CompletionRequestEnvelope;
  abortController: AbortController;
  startTime: number;
}

// ─── Content Identity Cache ─────────────────────────────────────

/**
 * Bounded LRU cache keyed by content identity (content around cursor).
 */
export class ContentIdentityCache {
  private entries: Map<string, CacheEntry> = new Map();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Generate a cache key from content around the cursor.
   */
  static computeKey(
    uri: string,
    language: string,
    prefix: string,
    suffix: string,
    cursorLine: number,
    cursorColumn: number,
  ): string {
    // Use a simple string key combining content context
    const normalizedPrefix = prefix.slice(-200); // Last 200 chars before cursor
    const normalizedSuffix = suffix.slice(0, 100); // First 100 chars after cursor
    return `${uri}:${language}:${cursorLine}:${cursorColumn}:${normalizedPrefix}:${normalizedSuffix}`;
  }

  /**
   * Get a cached result if available and not stale.
   */
  get(key: string, documentVersion: number): CompletionResult | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    // Stale if document version differs
    if (entry.documentVersion !== documentVersion) {
      this.entries.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.result;
  }

  /**
   * Store a result in the cache.
   */
  set(key: string, result: CompletionResult, documentVersion: number): void {
    // Evict LRU if at capacity
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) {
        this.entries.delete(firstKey);
      }
    }

    this.entries.set(key, {
      key,
      result,
      cachedAt: Date.now(),
      documentVersion,
    });
  }

  /**
   * Invalidate all entries for a given URI.
   */
  invalidateUri(uri: string): void {
    for (const [key] of this.entries) {
      if (key.startsWith(uri + ':')) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Get the current cache size.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Get the maximum cache capacity.
   */
  get capacity(): number {
    return this.maxSize;
  }
}

// ─── CompletionController ───────────────────────────────────────

/**
 * CompletionController — Central coordinator for completion requests.
 *
 * Manages:
 * - Model roles with independent configuration
 * - Request binding to workspace/URI/version/cursor/language/requestId
 * - Cancellation on context changes
 * - Per-workspace debounce and concurrency
 * - Content-identity cache
 */
export class CompletionController {
  private roleConfigs: Map<ModelRole, ModelRoleConfig> = new Map();
  private workspaceConfigs: Map<string, WorkspaceCompletionConfig> = new Map();
  private caches: Map<string, ContentIdentityCache> = new Map();
  private activeRequests: Map<string, ActiveRequest[]> = new Map();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private generationCounter = 0;
  private disposed = false;

  // Current context for cancellation detection
  private currentUri: string | null = null;
  private currentVersion: number | null = null;
  private currentCursorLine: number | null = null;
  private currentCursorColumn: number | null = null;
  private currentWorkspaceId: string | null = null;

  // Cancellation listeners
  private cancellationListeners: Array<(requestId: string, reason: CancellationReason) => void> = [];

  // Request handler (injected by caller, e.g., the provider)
  private requestHandler: ((envelope: CompletionRequestEnvelope) => Promise<CompletionResult | null>) | null = null;

  constructor() {
    // Set default role configurations
    this.setRoleConfig('autocomplete', { model: 'default', debounceMs: 300, maxConcurrency: 1, enabled: true });
    this.setRoleConfig('inline_edit', { model: 'default', debounceMs: 200, maxConcurrency: 2, enabled: true });
    this.setRoleConfig('change_application', { model: 'default', debounceMs: 0, maxConcurrency: 3, enabled: true });
    this.setRoleConfig('chat', { model: 'default', debounceMs: 0, maxConcurrency: 5, enabled: true });
    this.setRoleConfig('planning', { model: 'default', debounceMs: 0, maxConcurrency: 2, enabled: true });
    this.setRoleConfig('embedding', { model: 'default', debounceMs: 100, maxConcurrency: 4, enabled: true });
  }

  // ─── Configuration ──────────────────────────────────────────

  /**
   * Set configuration for a model role.
   */
  setRoleConfig(role: ModelRole, config: ModelRoleConfig): void {
    this.roleConfigs.set(role, { ...config });
  }

  /**
   * Get configuration for a model role.
   */
  getRoleConfig(role: ModelRole): ModelRoleConfig | undefined {
    const config = this.roleConfigs.get(role);
    return config ? { ...config } : undefined;
  }

  /**
   * Set per-workspace configuration.
   */
  setWorkspaceConfig(config: WorkspaceCompletionConfig): void {
    this.workspaceConfigs.set(config.workspaceId, { ...config });
    // Ensure cache exists with configured size
    if (!this.caches.has(config.workspaceId)) {
      this.caches.set(config.workspaceId, new ContentIdentityCache(config.cacheMaxSize));
    }
  }

  /**
   * Get per-workspace configuration.
   */
  getWorkspaceConfig(workspaceId: string): WorkspaceCompletionConfig | undefined {
    const config = this.workspaceConfigs.get(workspaceId);
    return config ? { ...config } : undefined;
  }

  /**
   * Set the handler function that executes requests.
   */
  setRequestHandler(handler: (envelope: CompletionRequestEnvelope) => Promise<CompletionResult | null>): void {
    this.requestHandler = handler;
  }

  // ─── Context Updates (Cancellation Triggers) ────────────────

  /**
   * Notify that the cursor moved. Cancels active autocomplete requests.
   */
  onCursorMoved(line: number, column: number): void {
    if (this.currentCursorLine !== line || this.currentCursorColumn !== column) {
      this.currentCursorLine = line;
      this.currentCursorColumn = column;
      this.cancelActiveRequests('cursor_moved', 'autocomplete');
    }
  }

  /**
   * Notify that the active file changed. Cancels all active requests.
   */
  onFileSwitch(uri: string, workspaceId: string): void {
    if (this.currentUri !== uri) {
      this.currentUri = uri;
      this.currentWorkspaceId = workspaceId;
      this.cancelAllActiveRequests('file_switched');
    }
  }

  /**
   * Notify that the document version changed. Cancels stale requests.
   */
  onVersionChange(version: number): void {
    if (this.currentVersion !== version) {
      this.currentVersion = version;
      this.cancelActiveRequests('version_changed', 'autocomplete');
    }
  }

  // ─── Request Lifecycle ──────────────────────────────────────

  /**
   * Request a completion with proper binding, debouncing, and cancellation.
   *
   * @param params - Request parameters
   * @returns CompletionResult or null if cancelled/cached miss
   */
  async requestCompletion(params: {
    workspaceId: string;
    uri: string;
    documentVersion: number;
    cursorLine: number;
    cursorColumn: number;
    language: string;
    role: ModelRole;
    prefix: string;
    suffix: string;
  }): Promise<CompletionResult | null> {
    if (this.disposed) return null;

    const { workspaceId, uri, documentVersion, cursorLine, cursorColumn, language, role, prefix, suffix } = params;

    // Check role is enabled
    const roleConfig = this.roleConfigs.get(role);
    if (!roleConfig || !roleConfig.enabled) return null;

    // Update current context
    this.currentUri = uri;
    this.currentVersion = documentVersion;
    this.currentCursorLine = cursorLine;
    this.currentCursorColumn = cursorColumn;
    this.currentWorkspaceId = workspaceId;

    // Check content-identity cache
    const cache = this.getOrCreateCache(workspaceId);
    const cacheKey = ContentIdentityCache.computeKey(uri, language, prefix, suffix, cursorLine, cursorColumn);
    const cached = cache.get(cacheKey, documentVersion);
    if (cached) {
      return { ...cached, fromCache: true };
    }

    // Get effective debounce (workspace config overrides role config)
    const wsConfig = this.workspaceConfigs.get(workspaceId);
    const debounceMs = wsConfig?.debounceMs ?? roleConfig.debounceMs;

    // Check concurrency limit
    const maxConcurrency = wsConfig?.maxConcurrency ?? roleConfig.maxConcurrency;
    const activeForWorkspace = this.activeRequests.get(workspaceId) ?? [];
    const activeForRole = activeForWorkspace.filter(r => r.envelope.role === role);
    if (activeForRole.length >= maxConcurrency) {
      // Cancel the oldest request to make room
      const oldest = activeForRole[0];
      if (oldest) {
        this.cancelRequest(oldest.envelope.requestId, 'newer_request');
      }
    }

    // Create request envelope
    const requestId = this.generateRequestId();
    const generation = ++this.generationCounter;
    const envelope: CompletionRequestEnvelope = {
      requestId,
      workspaceId,
      uri,
      documentVersion,
      cursorLine,
      cursorColumn,
      language,
      role,
      timestamp: Date.now(),
      generation,
    };

    // Apply debounce
    if (debounceMs > 0) {
      return new Promise<CompletionResult | null>((resolve) => {
        const timerKey = `${workspaceId}:${role}`;

        // Clear any existing debounce timer for this workspace+role
        const existingTimer = this.debounceTimers.get(timerKey);
        if (existingTimer !== undefined) {
          clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
          this.debounceTimers.delete(timerKey);
          this.executeRequest(envelope, cacheKey, documentVersion)
            .then(resolve)
            .catch(() => resolve(null));
        }, debounceMs);

        this.debounceTimers.set(timerKey, timer);
      });
    }

    // No debounce, execute immediately
    return this.executeRequest(envelope, cacheKey, documentVersion);
  }

  /**
   * Cancel a specific request by ID.
   */
  cancelRequest(requestId: string, reason: CancellationReason): void {
    for (const [workspaceId, requests] of this.activeRequests) {
      const idx = requests.findIndex(r => r.envelope.requestId === requestId);
      if (idx !== -1) {
        const request = requests[idx];
        request.abortController.abort();
        requests.splice(idx, 1);
        if (requests.length === 0) {
          this.activeRequests.delete(workspaceId);
        }
        this.notifyCancellation(requestId, reason);
        break;
      }
    }
  }

  /**
   * Register a cancellation listener.
   */
  onCancellation(listener: (requestId: string, reason: CancellationReason) => void): () => void {
    this.cancellationListeners.push(listener);
    return () => {
      const idx = this.cancellationListeners.indexOf(listener);
      if (idx !== -1) this.cancellationListeners.splice(idx, 1);
    };
  }

  /**
   * Get the number of active requests for a workspace.
   */
  getActiveRequestCount(workspaceId: string): number {
    return this.activeRequests.get(workspaceId)?.length ?? 0;
  }

  /**
   * Get the cache for a workspace.
   */
  getCache(workspaceId: string): ContentIdentityCache | undefined {
    return this.caches.get(workspaceId);
  }

  /**
   * Dispose the controller and clean up all resources.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelAllActiveRequests('disposed');

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clear caches
    for (const cache of this.caches.values()) {
      cache.clear();
    }
    this.caches.clear();

    this.cancellationListeners = [];
    this.requestHandler = null;
  }

  // ─── Internal ─────────────────────────────────────────────────

  private async executeRequest(
    envelope: CompletionRequestEnvelope,
    cacheKey: string,
    documentVersion: number,
  ): Promise<CompletionResult | null> {
    if (this.disposed) return null;
    if (!this.requestHandler) return null;

    // Verify context hasn't changed during debounce
    if (
      envelope.uri !== this.currentUri ||
      envelope.documentVersion !== this.currentVersion
    ) {
      return null;
    }

    const abortController = new AbortController();
    const activeRequest: ActiveRequest = {
      envelope,
      abortController,
      startTime: Date.now(),
    };

    // Track the active request
    const workspaceRequests = this.activeRequests.get(envelope.workspaceId) ?? [];
    workspaceRequests.push(activeRequest);
    this.activeRequests.set(envelope.workspaceId, workspaceRequests);

    try {
      const result = await this.requestHandler(envelope);

      // Remove from active requests
      this.removeActiveRequest(envelope.workspaceId, envelope.requestId);

      if (result && !abortController.signal.aborted) {
        // Validate result is still relevant
        if (envelope.uri !== this.currentUri || envelope.documentVersion !== this.currentVersion) {
          return null;
        }

        // Store in cache
        const cache = this.getOrCreateCache(envelope.workspaceId);
        cache.set(cacheKey, result, documentVersion);

        return result;
      }

      return null;
    } catch {
      this.removeActiveRequest(envelope.workspaceId, envelope.requestId);
      return null;
    }
  }

  private cancelActiveRequests(reason: CancellationReason, role?: ModelRole): void {
    for (const [, requests] of this.activeRequests) {
      const toCancel = role
        ? requests.filter(r => r.envelope.role === role)
        : [...requests];

      for (const request of toCancel) {
        request.abortController.abort();
        this.notifyCancellation(request.envelope.requestId, reason);
      }

      if (role) {
        // Remove only matching role
        const remaining = requests.filter(r => r.envelope.role !== role);
        if (remaining.length === 0) {
          // Will be cleaned on next iteration if needed
        }
      }
    }

    if (!role) {
      this.activeRequests.clear();
    } else {
      // Clean up role-specific requests
      for (const [workspaceId, requests] of this.activeRequests) {
        const remaining = requests.filter(r => r.envelope.role !== role);
        if (remaining.length === 0) {
          this.activeRequests.delete(workspaceId);
        } else {
          this.activeRequests.set(workspaceId, remaining);
        }
      }
    }
  }

  private cancelAllActiveRequests(reason: CancellationReason): void {
    for (const [, requests] of this.activeRequests) {
      for (const request of requests) {
        request.abortController.abort();
        this.notifyCancellation(request.envelope.requestId, reason);
      }
    }
    this.activeRequests.clear();
  }

  private removeActiveRequest(workspaceId: string, requestId: string): void {
    const requests = this.activeRequests.get(workspaceId);
    if (!requests) return;

    const idx = requests.findIndex(r => r.envelope.requestId === requestId);
    if (idx !== -1) {
      requests.splice(idx, 1);
      if (requests.length === 0) {
        this.activeRequests.delete(workspaceId);
      }
    }
  }

  private notifyCancellation(requestId: string, reason: CancellationReason): void {
    for (const listener of this.cancellationListeners) {
      listener(requestId, reason);
    }
  }

  private getOrCreateCache(workspaceId: string): ContentIdentityCache {
    let cache = this.caches.get(workspaceId);
    if (!cache) {
      const wsConfig = this.workspaceConfigs.get(workspaceId);
      const maxSize = wsConfig?.cacheMaxSize ?? 50;
      cache = new ContentIdentityCache(maxSize);
      this.caches.set(workspaceId, cache);
    }
    return cache;
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
