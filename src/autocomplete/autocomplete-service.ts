/**
 * AutocompleteService — Core orchestrator for inline autocomplete.
 *
 * Coordinates FIMProvider, ContextualSkip, and ErrorBackoff to deliver
 * debounced ghost-text completions in the Monaco editor. Routes all
 * completion context through FirewallEngine before sending to the provider.
 * Uses the 'fast' tier from provider registry for model selection.
 *
 * Follows NeuroNest's lazy-initialized singleton pattern.
 *
 * Requirements: 1.1, 1.2, 1.5, 1.7, 1.8
 */

import { FIMProvider, type EditorState, type FIMPrompt, type FIMProviderFormat } from './fim-provider.js';
import { ContextualSkip, type LineContext } from './contextual-skip.js';
import { ErrorBackoff } from './error-backoff.js';

// ─── Types ──────────────────────────────────────────────────────

/** Result from a completion request */
export interface CompletionResult {
  /** The suggested completion text */
  text: string;
  /** Provider that generated the completion */
  providerId: string;
  /** Model used */
  model: string;
  /** Latency in milliseconds */
  latencyMs: number;
}

/** Reason for a request being skipped/cancelled */
export type SkipReason =
  | 'disabled'
  | 'contextual_skip'
  | 'backoff'
  | 'firewall_blocked'
  | 'cancelled'
  | 'debounce_superseded'
  | 'no_provider';

/** Result from an autocomplete attempt (either success or skip) */
export interface AutocompleteResult {
  /** Whether a completion was returned */
  success: boolean;
  /** The completion, if successful */
  completion?: CompletionResult;
  /** Reason for skip, if unsuccessful */
  skipReason?: SkipReason;
  /** Additional detail about the skip */
  skipDetail?: string;
}

/** Status of the autocomplete service */
export type AutocompleteStatus = 'enabled' | 'disabled' | 'loading' | 'backoff';

/** Configuration for the autocomplete service */
export interface AutocompleteServiceConfig {
  /** Debounce delay in milliseconds (default: 300) */
  debounceMs: number;
  /** Provider ID to use for completions */
  providerId: string;
  /** Model to use (resolved from 'fast' tier if not specified) */
  model?: string;
  /** FIM format for the provider */
  fimFormat: FIMProviderFormat;
  /** Whether the service is enabled */
  enabled: boolean;
}

/** Interface for the FirewallEngine evaluate method */
export interface FirewallEvaluator {
  evaluate(input: string, opts?: { agentId?: string; projectId?: string }): {
    passed: boolean;
    blocked: boolean;
    sanitized: string;
  };
}

/** Interface for the LLM completion provider */
export interface CompletionProvider {
  /** Send a FIM completion request */
  complete(prompt: FIMPrompt, providerId: string, model: string): Promise<string>;
}

/** Interface for the provider registry (fast tier resolver) */
export interface TierResolver {
  /** Resolve the provider and model for the 'fast' tier */
  resolveFastTier(): { providerId: string; model: string } | null;
}

/** IPC notification sender for status bar updates */
export interface StatusBarNotifier {
  /** Notify the renderer of status changes */
  notifyStatusChange(status: AutocompleteStatus): void;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default configuration */
export const DEFAULT_AUTOCOMPLETE_CONFIG: AutocompleteServiceConfig = {
  debounceMs: 300,
  providerId: 'default',
  fimFormat: 'openai',
  enabled: false, // Disabled by default, activated via feature flag
};

// ─── AutocompleteService ────────────────────────────────────────

/**
 * AutocompleteService — Core orchestrator for inline ghost-text completions.
 *
 * Manages the full lifecycle of a completion request:
 * 1. Debounce (300ms pause after last keystroke)
 * 2. Contextual skip check (suppress in strings/imports)
 * 3. Error backoff check (pause after consecutive failures)
 * 4. Firewall evaluation (secrets scanning on FIM context)
 * 5. Provider request (using 'fast' tier model)
 * 6. Cancellation support (abort in-flight when user types again)
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 */
export class AutocompleteService {
  private static instance: AutocompleteService | null = null;

  private config: AutocompleteServiceConfig;
  private fimProvider: FIMProvider;
  private contextualSkip: ContextualSkip;
  private errorBackoff: ErrorBackoff;

  private firewall: FirewallEvaluator | null = null;
  private completionProvider: CompletionProvider | null = null;
  private tierResolver: TierResolver | null = null;
  private statusBarNotifier: StatusBarNotifier | null = null;

  // Debounce state
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequestId: number = 0;
  /** Resolver for the currently pending debounced promise (allows external cancellation) */
  private pendingResolve: ((result: AutocompleteResult) => void) | null = null;

  // Cancellation state
  private abortController: AbortController | null = null;

  // Status tracking
  private _status: AutocompleteStatus = 'disabled';

  private constructor(config?: Partial<AutocompleteServiceConfig>) {
    this.config = { ...DEFAULT_AUTOCOMPLETE_CONFIG, ...config };
    this.fimProvider = FIMProvider.getInstance();
    this.contextualSkip = ContextualSkip.getInstance();
    this.errorBackoff = ErrorBackoff.getInstance();
    this._status = this.config.enabled ? 'enabled' : 'disabled';
  }

  /** Get or create the singleton instance */
  static getInstance(config?: Partial<AutocompleteServiceConfig>): AutocompleteService {
    if (!AutocompleteService.instance) {
      AutocompleteService.instance = new AutocompleteService(config);
    }
    return AutocompleteService.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (AutocompleteService.instance) {
      AutocompleteService.instance.dispose();
    }
    AutocompleteService.instance = null;
  }

  // ─── Dependency Injection ─────────────────────────────────────

  /** Inject the firewall evaluator */
  setFirewall(firewall: FirewallEvaluator): void {
    this.firewall = firewall;
  }

  /** Inject the completion provider */
  setCompletionProvider(provider: CompletionProvider): void {
    this.completionProvider = provider;
  }

  /** Inject the tier resolver for fast-tier model selection */
  setTierResolver(resolver: TierResolver): void {
    this.tierResolver = resolver;
  }

  /** Inject the status bar notifier for IPC updates */
  setStatusBarNotifier(notifier: StatusBarNotifier): void {
    this.statusBarNotifier = notifier;
  }

  // ─── Configuration ────────────────────────────────────────────

  /** Update configuration at runtime */
  updateConfig(config: Partial<AutocompleteServiceConfig>): void {
    this.config = { ...this.config, ...config };
    if (config.enabled !== undefined) {
      this._status = config.enabled ? 'enabled' : 'disabled';
      this.notifyStatus();
    }
  }

  /** Get current configuration */
  getConfig(): Readonly<AutocompleteServiceConfig> {
    return { ...this.config };
  }

  // ─── Toggle State Management ──────────────────────────────────

  /** Enable the autocomplete service */
  enable(): void {
    this.config.enabled = true;
    this._status = 'enabled';
    this.notifyStatus();
  }

  /** Disable the autocomplete service */
  disable(): void {
    this.config.enabled = false;
    this._status = 'disabled';
    this.cancelPending();
    this.notifyStatus();
  }

  /** Toggle enabled/disabled state */
  toggle(): boolean {
    if (this.config.enabled) {
      this.disable();
    } else {
      this.enable();
    }
    return this.config.enabled;
  }

  /** Get current status */
  get status(): AutocompleteStatus {
    return this._status;
  }

  /** Check if the service is enabled */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  // ─── Core Request Flow ────────────────────────────────────────

  /**
   * Trigger a debounced completion request.
   *
   * Called on each keystroke. Resets the debounce timer and cancels any
   * in-flight request. After 300ms of inactivity, triggers the actual
   * completion request.
   *
   * @param editorState - Current Monaco editor state
   * @param lineContext - Current line context for skip analysis
   * @returns Promise resolving to the autocomplete result after debounce
   */
  requestCompletion(
    editorState: EditorState,
    lineContext: LineContext,
  ): Promise<AutocompleteResult> {
    // Immediately reject if disabled
    if (!this.config.enabled) {
      return Promise.resolve({
        success: false,
        skipReason: 'disabled',
        skipDetail: 'Autocomplete is disabled',
      });
    }

    // Cancel any pending debounce or in-flight request
    this.cancelPending();

    // Increment request ID to track this specific request
    const requestId = ++this.pendingRequestId;

    return new Promise<AutocompleteResult>((resolve) => {
      // Store the resolver so cancelPending() can resolve this promise externally
      this.pendingResolve = resolve;

      this.debounceTimer = setTimeout(() => {
        // Clear the pending resolver since the timer has fired
        this.pendingResolve = null;

        // If a newer request has been issued, this one is superseded
        if (requestId !== this.pendingRequestId) {
          resolve({
            success: false,
            skipReason: 'debounce_superseded',
            skipDetail: 'Superseded by a newer keystroke',
          });
          return;
        }

        // Execute the actual completion
        this.executeCompletion(editorState, lineContext, requestId)
          .then(resolve)
          .catch(() => {
            resolve({
              success: false,
              skipReason: 'cancelled',
              skipDetail: 'Request failed unexpectedly',
            });
          });
      }, this.config.debounceMs);
    });
  }

  /**
   * Cancel any pending or in-flight completion request.
   *
   * Called when the user types again (invalidating the current suggestion)
   * or when the service is disabled.
   */
  cancelPending(): void {
    // Clear debounce timer
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Resolve the pending promise with a superseded result
    if (this.pendingResolve) {
      this.pendingResolve({
        success: false,
        skipReason: 'debounce_superseded',
        skipDetail: 'Superseded by a newer keystroke',
      });
      this.pendingResolve = null;
    }

    // Abort in-flight request
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // ─── Internal Completion Logic ────────────────────────────────

  /**
   * Execute the full completion pipeline after debounce.
   *
   * Steps:
   * 1. Contextual skip check
   * 2. Error backoff check
   * 3. Build FIM prompt
   * 4. Firewall evaluation
   * 5. Send to provider
   * 6. Record success/failure
   */
  private async executeCompletion(
    editorState: EditorState,
    lineContext: LineContext,
    requestId: number,
  ): Promise<AutocompleteResult> {
    // Step 1: Contextual skip check
    const skipDecision = this.contextualSkip.shouldSkip(lineContext);
    if (skipDecision.shouldSkip) {
      return {
        success: false,
        skipReason: 'contextual_skip',
        skipDetail: skipDecision.reason,
      };
    }

    // Step 2: Resolve provider/model
    const resolved = this.resolveProviderModel();
    if (!resolved) {
      return {
        success: false,
        skipReason: 'no_provider',
        skipDetail: 'No completion provider or fast-tier model available',
      };
    }

    // Step 3: Error backoff check
    const backoffResult = this.errorBackoff.canRequest(resolved.providerId);
    if (!backoffResult.allowed) {
      this._status = 'backoff';
      this.notifyStatus();
      return {
        success: false,
        skipReason: 'backoff',
        skipDetail: backoffResult.reason,
      };
    }

    // Step 4: Build FIM prompt
    const fimPrompt = this.fimProvider.buildPrompt(editorState, this.config.fimFormat);

    // Step 5: Firewall evaluation (pass completion context through FirewallEngine)
    if (this.firewall) {
      const firewallResult = this.firewall.evaluate(fimPrompt.prompt);
      if (firewallResult.blocked) {
        return {
          success: false,
          skipReason: 'firewall_blocked',
          skipDetail: 'Completion context blocked by FirewallEngine (secrets detected)',
        };
      }
    }

    // Step 6: Send to provider
    if (!this.completionProvider) {
      return {
        success: false,
        skipReason: 'no_provider',
        skipDetail: 'No completion provider configured',
      };
    }

    // Check if request was cancelled before making the async call
    if (requestId !== this.pendingRequestId) {
      return {
        success: false,
        skipReason: 'cancelled',
        skipDetail: 'Request cancelled before provider call',
      };
    }

    // Set up abort controller for this request
    this.abortController = new AbortController();
    this._status = 'loading';
    this.notifyStatus();

    const startTime = Date.now();

    try {
      const completionText = await this.completionProvider.complete(
        fimPrompt,
        resolved.providerId,
        resolved.model,
      );

      // Check if the request was cancelled while waiting for the response
      if (requestId !== this.pendingRequestId) {
        return {
          success: false,
          skipReason: 'cancelled',
          skipDetail: 'Request cancelled while waiting for provider response',
        };
      }

      // Record success
      this.errorBackoff.recordSuccess(resolved.providerId);
      this._status = 'enabled';
      this.notifyStatus();

      const latencyMs = Date.now() - startTime;

      return {
        success: true,
        completion: {
          text: completionText,
          providerId: resolved.providerId,
          model: resolved.model,
          latencyMs,
        },
      };
    } catch (error: unknown) {
      // Check if it was an intentional abort
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          skipReason: 'cancelled',
          skipDetail: 'Request aborted',
        };
      }

      // Record failure for backoff tracking
      this.errorBackoff.recordFailure(resolved.providerId);

      // Check if we're now in backoff
      const isBackedOff = this.errorBackoff.isInBackoff(resolved.providerId);
      this._status = isBackedOff ? 'backoff' : 'enabled';
      this.notifyStatus();

      return {
        success: false,
        skipReason: 'cancelled',
        skipDetail: `Provider error: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      this.abortController = null;
    }
  }

  // ─── Provider/Model Resolution ────────────────────────────────

  /**
   * Resolve the provider and model to use for completion.
   *
   * Priority:
   * 1. Explicit config.providerId + config.model
   * 2. Fast-tier from TierResolver
   * 3. null (no provider available)
   */
  private resolveProviderModel(): { providerId: string; model: string } | null {
    // If explicit model is configured, use it
    if (this.config.model) {
      return {
        providerId: this.config.providerId,
        model: this.config.model,
      };
    }

    // Try fast-tier resolution
    if (this.tierResolver) {
      const resolved = this.tierResolver.resolveFastTier();
      if (resolved) {
        return resolved;
      }
    }

    // Fallback to config providerId with no model (will fail if provider needs model)
    if (this.config.providerId !== 'default') {
      return {
        providerId: this.config.providerId,
        model: '',
      };
    }

    return null;
  }

  // ─── Status Notifications ─────────────────────────────────────

  /** Notify the renderer of a status change via IPC */
  private notifyStatus(): void {
    if (this.statusBarNotifier) {
      this.statusBarNotifier.notifyStatusChange(this._status);
    }
  }

  // ─── Cleanup ──────────────────────────────────────────────────

  /** Clean up timers and abort controllers */
  dispose(): void {
    this.cancelPending();
    this._status = 'disabled';
  }
}
