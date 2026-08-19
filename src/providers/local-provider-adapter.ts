/**
 * Local provider adapter — the local-endpoint sibling of
 * `createLLMProxyAdapter`.
 *
 * The adapter exposes two surfaces for a resolved local route:
 *
 *   1. `LLMProviderAdapter` compatibility — `chatCompletion` and
 *      `streamCompletion` yield the same shapes as every other adapter in
 *      the registry, so existing callers (ProviderRegistry, fallback chain,
 *      pipeline utilities, and legacy code) work unchanged for
 *      Ollama/llama.cpp/OpenMythos.
 *   2. A canonical `stream()` method that yields provider-neutral canonical
 *      wire frames (`ProxyStreamFrame` values whose `data` is a canonical
 *      `ProxyWireEventV1`). Downstream code can pipe these frames through
 *      the shared `StreamEventNormalizer` used for cloud responses so
 *      local and cloud routes share ONE projection contract.
 *
 * Requirements 2.7 and 5.9 dictate the invariants enforced here:
 *
 *  - The adapter has no access to a `ProxyCredentialBoundary` and never
 *    calls `ProxyCredentialService.resolve()`. The `LocalProviderTransport`
 *    it uses fails closed on any non-local endpoint, so a bad config cannot
 *    turn this path into a cloud call.
 *  - Outgoing HTTP requests carry no `Authorization: Bearer <proxy-token>`
 *    header. Only user-configured self-hosted headers may appear, and only
 *    when a caller explicitly opts in through `extraHeaders`.
 */

import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  CompletionResult,
  LLMProviderAdapter,
} from './provider-registry.js';
import type {
  LocalInferenceRequest,
  LocalInferenceResponse,
} from './local-provider-transport.js';
import { LocalProviderTransport, DEFAULT_LOCAL_PROVIDER_URLS } from './local-provider-transport.js';
import type { ProxyStreamFrame } from './proxy-stream-decoder.js';

export interface LocalProviderAdapterOptions {
  /**
   * A pre-constructed transport. Preferred in production so multiple
   * requests share one `fetch` capability. Tests may either share one
   * transport or let the factory construct one from `baseUrl`.
   */
  readonly transport?: LocalProviderTransport;
  /** Logical local provider identifier (e.g. `'ollama'`). */
  readonly provider: string;
  /** Logical local model identifier (e.g. `'llama3'`). */
  readonly model: string;
  /**
   * Configured base URL for the local endpoint. Required when `transport`
   * is not provided. Callers that already have a transport instance may
   * omit this; the transport itself owns the endpoint invariant.
   */
  readonly baseUrl?: string;
  /**
   * Provider-agnostic supplier for request identity. Called once per
   * `chatCompletion`/`streamCompletion` invocation so streaming callers
   * can generate a fresh `requestId` per attempt without threading it
   * through the LLMProviderAdapter interface.
   */
  readonly requestContext: () => LocalRequestContext;
  /** Optional display name. Defaults to `${provider} ${model} (local)`. */
  readonly name?: string;
  /** Optional adapter id. Defaults to `neuronest-local:${provider}:${model}`. */
  readonly id?: string;
  /**
   * Optional health probe. When absent, `isAvailable` returns `true` — the
   * transport itself refuses non-local endpoints, so absence of a probe
   * does not permit cloud requests.
   */
  readonly isAvailable?: () => boolean | Promise<boolean>;
  /**
   * Optional user-configured extra headers for a self-hosted deployment.
   * Only consulted when the factory constructs its own transport from
   * `baseUrl`.
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Optional fetch implementation for tests. Only consulted when the
   * factory constructs its own transport from `baseUrl`.
   */
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface LocalRequestContext {
  readonly requestId: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly attempt?: number;
}

/**
 * Adapter surface exposed for local routes. Extends the standard
 * `LLMProviderAdapter` compatibility shape with `stream()` returning
 * canonical wire frames.
 */
export interface LocalProviderAdapter extends LLMProviderAdapter {
  /**
   * Marker discriminating this adapter as local. Callers that inspect
   * adapters (for example, to assert no Proxy Credential is attached) can
   * check this field without pattern-matching on names.
   */
  readonly transportClass: 'local-provider';
  /**
   * Emit canonical `ProxyStreamFrame` events for one streaming request.
   * The wire event shapes match the canonical wire contract accepted by
   * `StreamEventNormalizer`, so cloud and local routes share one
   * downstream projection pipeline.
   */
  streamCanonicalFrames(
    messages: readonly ChatMessage[],
    options?: CompletionOptions,
  ): AsyncIterable<ProxyStreamFrame>;
}

export function createLocalProviderAdapter(
  options: LocalProviderAdapterOptions,
): LocalProviderAdapter {
  const transport =
    options.transport ??
    new LocalProviderTransport({
      baseUrl: options.baseUrl ?? defaultBaseUrlFor(options.provider),
      ...(options.extraHeaders === undefined ? {} : { extraHeaders: options.extraHeaders }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  const id = options.id ?? `neuronest-local:${options.provider}:${options.model}`;
  const name = options.name ?? `${options.provider} ${options.model} (local)`;

  function buildRequest(
    messages: readonly ChatMessage[],
    stream: boolean,
    completionOptions?: CompletionOptions,
  ): LocalInferenceRequest {
    const context = options.requestContext();
    const request: LocalInferenceRequest = {
      requestId: context.requestId,
      ...(context.conversationId === undefined
        ? {}
        : { conversationId: context.conversationId }),
      ...(context.turnId === undefined ? {} : { turnId: context.turnId }),
      ...(context.attempt === undefined ? {} : { attempt: context.attempt }),
      provider: options.provider,
      model: options.model,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream,
      ...(completionOptions?.temperature === undefined
        ? {}
        : { temperature: completionOptions.temperature }),
      ...(completionOptions?.maxTokens === undefined
        ? {}
        : { maxTokens: completionOptions.maxTokens }),
      ...(completionOptions?.stopSequences === undefined
        ? {}
        : { stopSequences: completionOptions.stopSequences }),
    };
    return request;
  }

  function toCompletionResult(response: LocalInferenceResponse): CompletionResult {
    return {
      content: response.content,
      tokensUsed: {
        prompt: response.usage?.promptTokens ?? 0,
        completion: response.usage?.completionTokens ?? 0,
      },
      finishReason: mapFinishReason(response.finishReason),
    };
  }

  return {
    id,
    name,
    transportClass: 'local-provider',

    async chatCompletion(
      messages: ChatMessage[],
      completionOptions?: CompletionOptions,
    ): Promise<CompletionResult> {
      const response = await transport.complete(
        buildRequest(messages, false, completionOptions),
      );
      return toCompletionResult(response);
    },

    async *streamCompletion(
      messages: ChatMessage[],
      completionOptions?: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      const request = buildRequest(messages, true, completionOptions);
      for await (const frame of transport.stream(request)) {
        const parsed = safeParseWireEvent(frame);
        if (!parsed) continue;
        if (parsed.type === 'answer.delta' && typeof parsed.delta === 'string' && parsed.delta.length > 0) {
          yield { content: parsed.delta, done: false };
        }
        // reasoning/usage/terminal events are intentionally omitted from
        // the compatibility surface — they exist in the canonical stream
        // and are consumed by the projection pipeline.
      }
      yield { content: '', done: true };
    },

    async *streamCanonicalFrames(
      messages: readonly ChatMessage[],
      completionOptions?: CompletionOptions,
    ): AsyncIterable<ProxyStreamFrame> {
      const request = buildRequest(messages, true, completionOptions);
      for await (const frame of transport.stream(request)) {
        yield frame;
      }
    },

    countTokens(text: string): number {
      // Local models don't return a canonical token count for arbitrary
      // strings; the pipeline's standard 4-chars/token heuristic matches
      // the rest of the adapter surface.
      return Math.ceil(text.length / 4);
    },

    async isAvailable(): Promise<boolean> {
      return options.isAvailable === undefined ? true : options.isAvailable();
    },
  };
}

function defaultBaseUrlFor(provider: string): string {
  const key = provider.toLowerCase();
  const url = DEFAULT_LOCAL_PROVIDER_URLS[key];
  if (url) return url;
  throw new Error(
    `createLocalProviderAdapter: no default base URL for provider '${provider}'. ` +
      'Pass an explicit baseUrl or a pre-constructed transport.',
  );
}

function mapFinishReason(
  finish: LocalInferenceResponse['finishReason'],
): CompletionResult['finishReason'] {
  return finish === 'length' || finish === 'tool_call' ? finish : 'stop';
}

function safeParseWireEvent(frame: ProxyStreamFrame): { type?: string; delta?: unknown } | undefined {
  try {
    const parsed = JSON.parse(frame.data) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      ...(typeof record.type === 'string' ? { type: record.type } : {}),
      ...(record.delta !== undefined ? { delta: record.delta } : {}),
    };
  } catch {
    return undefined;
  }
}
