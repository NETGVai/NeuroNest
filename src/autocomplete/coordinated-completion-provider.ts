/**
 * CoordinatedCompletionProvider — autocomplete `CompletionProvider`
 * implementation that routes every FIM completion through the coordinated
 * inference client.
 *
 * `AutocompleteService` (a lazy singleton) accepts a `CompletionProvider`
 * via dependency injection. Historically that provider ran per-provider
 * client construction directly, which meant cloud completions could
 * bypass the NeuroNest proxy. This provider closes that gap by delegating
 * to `CoordinatedInferenceClient`: cloud completions land on
 * `LLMProxyTransport` and local completions land on the registered local
 * adapter, both with route metadata preserved for logical provider/model
 * attribution.
 *
 * Requirements: 5.1, 5.2, 5.4, 5.7, 5.9, 8.8
 *
 * Behavior contract:
 *  - `complete()` returns the assistant text or throws a typed error
 *    consistent with the existing `CompletionProvider` contract; callers
 *    already treat throws as provider errors that feed backoff.
 *  - The provider never constructs an inference client itself. It only
 *    invokes `CoordinatedInferenceClient.resolveClient()` per call, which
 *    runs preflight (credential + entitlement) before every request.
 *  - `modelRole` is fixed to `'autocomplete'`; `invocationSource` defaults
 *    to `'chat'` because completions are user-typing-driven UI activity,
 *    but callers may override it (e.g. background prefetch scenarios).
 */

import type { AppEdition } from '../shared/app-bootstrap-contracts.js';
import type {
  CoordinatedInferenceClient,
  CoordinatedInferenceOutcome,
  CoordinatedRequestContext,
} from '../provider-routing/coordinated-inference-client.js';
import type {
  InferenceInvocationSource,
  RoutingConstraints,
} from '../provider-routing/types.js';
import type { CompletionProvider } from './autocomplete-service.js';
import type { FIMPrompt } from './fim-provider.js';

// ─── Types ───────────────────────────────────────────────────────

/**
 * Error thrown when the coordinated inference client fails closed for a
 * completion request. Autocomplete backoff already treats provider throws
 * as failures, so this preserves that contract while surfacing the exact
 * coordinator failure code for diagnostics.
 */
export class CoordinatedCompletionError extends Error {
  readonly failureCode: string;

  constructor(message: string, failureCode: string) {
    super(message);
    this.name = 'CoordinatedCompletionError';
    this.failureCode = failureCode;
  }
}

/**
 * Callback that produces the coordinator + per-request context every call.
 * The autocomplete singleton is process-wide, but the active edition or
 * conversation identity may change per keystroke, so the callback runs
 * per request instead of being captured at construction time.
 */
export interface CoordinatedCompletionContext {
  readonly edition: AppEdition;
  readonly invocationSource?: InferenceInvocationSource;
  readonly requestContext: CoordinatedRequestContext;
  /**
   * Additional routing constraints (max latency, cost, locality, etc.)
   * applied on top of the mandatory `{ role: 'autocomplete' }` selector.
   * Optional so callers can rely on capability-based defaults from the
   * provider route service.
   */
  readonly constraintOverrides?: Omit<RoutingConstraints, 'role'>;
}

export type CoordinatedCompletionContextResolver = (input: {
  readonly prompt: FIMPrompt;
  readonly providerId: string;
  readonly model: string;
}) => CoordinatedCompletionContext;

export interface CoordinatedCompletionProviderDependencies {
  readonly coordinatedClient: CoordinatedInferenceClient;
  readonly resolveContext: CoordinatedCompletionContextResolver;
  /**
   * Optional temperature and max-token overrides applied to every
   * completion request. Autocomplete uses low temperature by default.
   */
  readonly completionOptions?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
  };
}

// ─── Implementation ──────────────────────────────────────────────

/**
 * Concrete `CompletionProvider` for `AutocompleteService`.
 */
export class CoordinatedCompletionProvider implements CompletionProvider {
  private readonly coordinatedClient: CoordinatedInferenceClient;
  private readonly resolveContext: CoordinatedCompletionContextResolver;
  private readonly completionOptions: {
    readonly temperature: number;
    readonly maxTokens: number;
  };

  constructor(dependencies: CoordinatedCompletionProviderDependencies) {
    this.coordinatedClient = dependencies.coordinatedClient;
    this.resolveContext = dependencies.resolveContext;
    this.completionOptions = {
      temperature: dependencies.completionOptions?.temperature ?? 0.2,
      maxTokens: dependencies.completionOptions?.maxTokens ?? 128,
    };
  }

  async complete(
    prompt: FIMPrompt,
    providerId: string,
    model: string,
  ): Promise<string> {
    const context = this.resolveContext({ prompt, providerId, model });

    const outcome: CoordinatedInferenceOutcome = this.coordinatedClient.resolveClient({
      routing: {
        constraints: {
          role: 'autocomplete',
          lockedProviderId: providerId,
          ...(model.length > 0 ? { lockedModelId: model } : {}),
          ...(context.constraintOverrides ?? {}),
        },
        invocationSource: context.invocationSource ?? 'chat',
        streaming: false,
        edition: context.edition,
      },
      context: context.requestContext,
    });

    if (outcome.kind === 'failed-closed') {
      throw new CoordinatedCompletionError(
        outcome.explanation,
        outcome.failureCode,
      );
    }

    // The adapter shape returned by CoordinatedInferenceClient conforms to
    // the existing LLMProviderAdapter contract. Autocomplete only needs a
    // single non-streaming completion; the adapter handles the transport
    // detail (proxy vs local) internally.
    const result = await outcome.adapter.chatCompletion(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.prompt },
      ],
      {
        temperature: this.completionOptions.temperature,
        maxTokens: this.completionOptions.maxTokens,
        stopSequences: prompt.stopSequences,
      },
    );

    return result.content;
  }
}
