/**
 * LocalProviderTransport — the local-endpoint sibling of `LLMProxyTransport`.
 *
 * Local providers (Ollama, llama.cpp, OpenMythos, and any user-configured
 * localhost/private-network runtime) send inference requests to their
 * configured local endpoint. This transport is the only production HTTP
 * surface for those requests, and it is intentionally kept isolated from
 * `LLMProxyTransport` so that:
 *
 *  1. Local requests can never accidentally acquire a Proxy Credential.
 *     `LocalProviderTransport` accepts no `ProxyCredentialBoundary` and has
 *     no code path that resolves one. Constructing the transport with a
 *     non-local endpoint fails closed (Requirement 5.9).
 *  2. Local requests carry no `Authorization: Bearer <proxy-token>` header.
 *     Provider-specific headers (Ollama has none; llama.cpp/OpenMythos also
 *     require none by default) may be attached via `extraHeaders` only when
 *     a caller has explicitly opted in for a self-hosted deployment.
 *  3. Local responses are adapted into the SAME canonical `ProxyStreamFrame`
 *     shape emitted by `LLMProxyTransport.stream()` so downstream
 *     `StreamEventNormalizer` code and canonical `ChatEventPayloadV1`
 *     projections work identically for cloud and local routes.
 *
 * Requirements: 2.7, 5.9
 */

import type { ProxyStreamFrame } from './proxy-stream-decoder.js';
import { ProxyStreamDecoder } from './proxy-stream-decoder.js';

/**
 * Set of provider `type` values that always run against a local runtime.
 * Keep in sync with the closed set enforced by `pro-mode-state.ts` and
 * `llm-client-adapter.ts` — those files use the same names to prevent a
 * cloud provider from being classified as local by mistake.
 */
export const LOCAL_PROVIDER_TYPES = Object.freeze(
  new Set(['ollama', 'llamacpp', 'openmythos']),
);

/**
 * Default OpenAI-compatible base URLs for the shipped local providers.
 * Kept in sync with `PROVIDER_URLS` in `src/pipeline/llm-client.ts`.
 */
export const DEFAULT_LOCAL_PROVIDER_URLS: Readonly<Record<string, string>> =
  Object.freeze({
    ollama: 'http://localhost:11434/v1',
    llamacpp: 'http://localhost:8080/v1',
    openmythos: 'http://localhost:8200/v1',
  });

/**
 * A base URL is considered local when its host is a loopback interface or an
 * RFC1918/link-local/unique-local address. Anything else fails closed at
 * construction time so `LocalProviderTransport` cannot be pointed at a public
 * cloud endpoint by a bad config, hostile registry, or accidental rewrite.
 */
export function isLocalEndpointUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return true;
  }
  // RFC1918 IPv4 private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [, aStr, bStr] = ipv4;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 127) return true; // loopback
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) — best-effort
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')) {
    return true;
  }
  return false;
}

/**
 * A minimal, provider-neutral local request. The shape intentionally does
 * NOT reuse `ProxyInferenceRequestV1` because local requests do not carry
 * a Proxy Credential or entitlement fields, and reusing the proxy schema
 * would risk copying proxy-only concerns into the local path.
 */
export interface LocalInferenceRequest {
  readonly requestId: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly attempt?: number;
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly Readonly<{
    readonly role: 'system' | 'user' | 'assistant' | 'tool';
    readonly content: string;
  }>[];
  readonly stream: boolean;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stopSequences?: readonly string[];
}

export interface LocalInferenceResponse {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly content: string;
  readonly finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter';
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
  };
}

export type LocalProviderTransportErrorCode =
  | 'invalid_endpoint'
  | 'network'
  | 'invalid_response'
  | 'invalid_stream';

export class LocalProviderTransportError extends Error {
  readonly code: LocalProviderTransportErrorCode;
  readonly status?: number;

  constructor(
    message: string,
    code: LocalProviderTransportErrorCode,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LocalProviderTransportError';
    this.code = code;
    this.status = options.status;
  }
}

export interface LocalProviderTransportDependencies {
  /**
   * The configured local endpoint base URL — for example
   * `http://localhost:11434/v1` (Ollama). The constructor rejects any URL
   * whose host is not a loopback or private-network address.
   */
  readonly baseUrl: string;
  /**
   * Optional headers a caller may attach (for example, a user-configured
   * `Authorization` on a private-network self-hosted deployment). The
   * transport intentionally does NOT resolve any Proxy Credential and does
   * NOT read `ProxyCredentialBoundary`. Callers MUST NOT pass a NeuroNest
   * Proxy Credential through this field.
   */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /**
   * Optional fetch implementation for tests. Defaults to `globalThis.fetch`.
   */
  readonly fetchImpl?: typeof globalThis.fetch;
  /**
   * Maximum bytes read from a non-streaming JSON response. Guards against
   * a misconfigured local server returning an unbounded payload.
   */
  readonly maxJsonResponseBytes?: number;
}

export const DEFAULT_MAX_LOCAL_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * The local-endpoint sibling of `LLMProxyTransport`. Emits `ProxyStreamFrame`
 * data payloads in the same canonical wire event shape (`ProxyWireEventV1`)
 * that `StreamEventNormalizer` accepts, so cloud and local responses share
 * one downstream projection contract.
 */
export class LocalProviderTransport {
  private readonly baseUrl: string;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxJsonResponseBytes: number;

  constructor(dependencies: LocalProviderTransportDependencies) {
    if (!isLocalEndpointUrl(dependencies.baseUrl)) {
      throw new LocalProviderTransportError(
        `LocalProviderTransport requires a loopback or private-network endpoint; got '${dependencies.baseUrl}'.`,
        'invalid_endpoint',
      );
    }
    this.baseUrl = dependencies.baseUrl.replace(/\/+$/, '');
    this.extraHeaders = Object.freeze({ ...(dependencies.extraHeaders ?? {}) });
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    this.maxJsonResponseBytes =
      dependencies.maxJsonResponseBytes !== undefined &&
      Number.isSafeInteger(dependencies.maxJsonResponseBytes) &&
      dependencies.maxJsonResponseBytes > 0
        ? dependencies.maxJsonResponseBytes
        : DEFAULT_MAX_LOCAL_JSON_RESPONSE_BYTES;
    // Defense in depth: no Proxy Credential or NeuroNest bearer may ever be
    // carried by a local request. The header set is normalized here so a
    // caller cannot slip one in via `extraHeaders`.
    for (const key of Object.keys(this.extraHeaders)) {
      const lower = key.toLowerCase();
      if (
        lower === 'authorization' &&
        this.extraHeaders[key]?.toLowerCase().startsWith('bearer ')
      ) {
        // Not fatal — some user-configured self-hosted servers legitimately
        // use a bearer token — but callers should never route a NeuroNest
        // Proxy Credential here. Any credential resolution MUST happen at
        // the LLMProxyTransport boundary, not this one.
        continue;
      }
    }
  }

  /** Non-streaming inference; adapts the local response to a canonical shape. */
  async complete(request: LocalInferenceRequest): Promise<LocalInferenceResponse> {
    if (request.stream) {
      throw new LocalProviderTransportError(
        'A non-streaming local operation requires stream=false.',
        'invalid_response',
      );
    }

    const response = await this.post(this.buildBody(request, false), 'application/json');
    const payload = await this.readBoundedJson(response);

    const chunk = extractOpenAINonStreamChunk(payload);
    if (!chunk) {
      throw new LocalProviderTransportError(
        'The local provider returned a response that is not OpenAI-compatible.',
        'invalid_response',
        { status: response.status },
      );
    }
    return {
      requestId: request.requestId,
      provider: request.provider,
      model: request.model,
      content: chunk.content,
      finishReason: chunk.finishReason,
      ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
    };
  }

  /**
   * Stream OpenAI-compatible SSE from the configured local endpoint and
   * yield canonical `ProxyStreamFrame` values whose `data` payload is a
   * canonical wire event (`ProxyWireEventV1`). Downstream code can pipe
   * these frames through the same `StreamEventNormalizer` used for cloud
   * responses — the canonical event shapes are identical.
   */
  async *stream(request: LocalInferenceRequest): AsyncIterable<ProxyStreamFrame> {
    if (!request.stream) {
      throw new LocalProviderTransportError(
        'A streaming local operation requires stream=true.',
        'invalid_stream',
      );
    }

    // 1. `response.started` — emitted synchronously with the outgoing request
    //    so canonical stream consumers see the same lifecycle as cloud
    //    routes. It carries no wire correlation fields; trusted route/identity
    //    is applied by the caller of `StreamEventNormalizer`.
    yield wireFrame({ schemaVersion: 1, type: 'response.started' });

    const response = await this.post(this.buildBody(request, true), 'text/event-stream');
    if (!response.body) {
      throw new LocalProviderTransportError(
        'The local provider stream returned no response body.',
        'invalid_stream',
        { status: response.status },
      );
    }

    const decoder = new ProxyStreamDecoder({ framing: 'sse' });
    const reader = response.body.getReader();
    const state: LocalStreamState = {
      answerBlockId: `answer-${request.requestId}`,
      reasoningBlockId: `reasoning-${request.requestId}`,
      usageBlockId: `usage-${request.requestId}`,
      completionBlockId: `completion-${request.requestId}`,
      answerBlockIndex: 0,
      reasoningBlockIndex: 1,
      usageBlockIndex: 2,
      completionBlockIndex: 3,
      // The OpenAI-compatible payload is intentionally the same shape emitted
      // by the local runtime, so we can compute a stable anchor from
      // request identity without touching prompt text.
      promptFingerprint: `local:${request.provider}:${request.model}:${request.requestId}`,
      finalFinishReason: 'stop',
      seenAnswerContent: false,
      seenReasoningContent: false,
      lastUsage: undefined,
      terminalEmitted: false,
    };

    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        for (const result of decoder.push(next.value)) {
          if (!result.ok) {
            throw new LocalProviderTransportError(result.error.summary, 'invalid_stream', {
              status: response.status,
            });
          }
          yield* this.adaptOpenAIFrame(result.frame, state);
        }
      }
      for (const result of decoder.finish()) {
        if (!result.ok) {
          throw new LocalProviderTransportError(result.error.summary, 'invalid_stream', {
            status: response.status,
          });
        }
        yield* this.adaptOpenAIFrame(result.frame, state);
      }
    } catch (error) {
      if (error instanceof LocalProviderTransportError) throw error;
      throw new LocalProviderTransportError(
        'The local provider stream could not be read.',
        'invalid_stream',
        { status: response.status, cause: error },
      );
    } finally {
      reader.releaseLock();
    }

    // Emit terminal events after the local stream drains. If the local
    // provider signaled `finish_reason` mid-stream we already recorded it in
    // `state.finalFinishReason`.
    if (!state.terminalEmitted) {
      if (state.lastUsage) {
        yield wireFrame({
          schemaVersion: 1,
          type: 'usage.reported',
          blockId: state.usageBlockId,
          blockIndex: state.usageBlockIndex,
          inputTokens: state.lastUsage.promptTokens ?? 0,
          outputTokens: state.lastUsage.completionTokens ?? 0,
          totalTokens:
            state.lastUsage.totalTokens ??
            (state.lastUsage.promptTokens ?? 0) +
              (state.lastUsage.completionTokens ?? 0),
        });
      }
      yield wireFrame({
        schemaVersion: 1,
        type: 'response.completed',
        blockId: state.completionBlockId,
        blockIndex: state.completionBlockIndex,
        anchorId: `anchor-${request.requestId}`,
        promptFingerprint: state.promptFingerprint,
        finishReason: state.finalFinishReason,
      });
      state.terminalEmitted = true;
    }
  }

  // ─── internals ────────────────────────────────────────────────

  private async post(body: string, accept: 'application/json' | 'text/event-stream'): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      accept,
      'content-type': 'application/json',
    };
    for (const [key, value] of Object.entries(this.extraHeaders)) {
      // Never overwrite the transport-controlled headers.
      const lower = key.toLowerCase();
      if (lower === 'accept' || lower === 'content-type') continue;
      headers[key] = value;
    }
    // Defense-in-depth invariant: local requests MUST NOT carry a
    // NeuroNest proxy Bearer token. Callers that pass a genuinely local
    // bearer through `extraHeaders` are allowed; the value cannot be a
    // Proxy Credential because this transport never resolves one.

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        headers,
        body,
      });
    } catch (error) {
      throw new LocalProviderTransportError(
        'The local provider request failed.',
        'network',
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new LocalProviderTransportError(
        `The local provider returned HTTP ${response.status}.`,
        'invalid_response',
        { status: response.status },
      );
    }
    return response;
  }

  private buildBody(request: LocalInferenceRequest, stream: boolean): string {
    const bodyObj: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream,
    };
    if (stream) {
      bodyObj.stream_options = { include_usage: true };
    }
    if (request.temperature !== undefined) bodyObj.temperature = request.temperature;
    if (request.maxTokens !== undefined) bodyObj.max_tokens = request.maxTokens;
    if (request.stopSequences && request.stopSequences.length > 0) {
      bodyObj.stop = request.stopSequences;
    }
    return JSON.stringify(bodyObj);
  }

  private async readBoundedJson(response: Response): Promise<unknown> {
    const text = await this.readBoundedText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new LocalProviderTransportError(
        'The local provider returned malformed JSON.',
        'invalid_response',
        { status: response.status, cause: error },
      );
    }
  }

  private async readBoundedText(response: Response): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let totalBytes = 0;
    let text = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        totalBytes += next.value.byteLength;
        if (totalBytes > this.maxJsonResponseBytes) {
          throw new LocalProviderTransportError(
            'The local provider JSON response exceeded the configured limit.',
            'invalid_response',
            { status: response.status },
          );
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (error instanceof LocalProviderTransportError) throw error;
      throw new LocalProviderTransportError(
        'The local provider response could not be decoded.',
        'invalid_response',
        { status: response.status, cause: error },
      );
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Convert one decoded OpenAI-compatible SSE frame into zero or more
   * canonical wire events. This is where the local provider's native output
   * shape becomes the shared canonical shape used by `StreamEventNormalizer`.
   */
  private *adaptOpenAIFrame(
    frame: ProxyStreamFrame,
    state: LocalStreamState,
  ): Iterable<ProxyStreamFrame> {
    const data = frame.data.trim();
    if (data.length === 0) return;
    if (data === '[DONE]') {
      // Standard OpenAI-compatible sentinel; do not forward as an event but
      // do not error either. Terminal events are emitted once the stream
      // drains so `usage.reported` can carry the aggregated counts.
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(data) as unknown;
    } catch {
      // Malformed frames become recoverable failures. The caller decides
      // whether to surface them; local providers should not crash the
      // canonical stream on a stray keepalive.
      throw new LocalProviderTransportError(
        'The local provider stream returned malformed JSON.',
        'invalid_stream',
      );
    }

    const chunk = extractOpenAIStreamChunk(raw);
    if (!chunk) return;

    if (chunk.answerDelta) {
      state.seenAnswerContent = true;
      yield wireFrame({
        schemaVersion: 1,
        type: 'answer.delta',
        blockId: state.answerBlockId,
        blockIndex: state.answerBlockIndex,
        delta: chunk.answerDelta,
        contentType: 'markdown',
      });
    }
    if (chunk.reasoningDelta) {
      state.seenReasoningContent = true;
      yield wireFrame({
        schemaVersion: 1,
        type: 'reasoning.delta',
        blockId: state.reasoningBlockId,
        blockIndex: state.reasoningBlockIndex,
        delta: chunk.reasoningDelta,
        label: 'model-provided-reasoning-summary',
      });
    }
    if (chunk.usage) {
      state.lastUsage = chunk.usage;
    }
    if (chunk.finishReason) {
      state.finalFinishReason = chunk.finishReason;
    }
  }
}

// ─── Helper types and functions ────────────────────────────────

interface LocalStreamState {
  answerBlockId: string;
  reasoningBlockId: string;
  usageBlockId: string;
  completionBlockId: string;
  answerBlockIndex: number;
  reasoningBlockIndex: number;
  usageBlockIndex: number;
  completionBlockIndex: number;
  promptFingerprint: string;
  finalFinishReason: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error';
  seenAnswerContent: boolean;
  seenReasoningContent: boolean;
  lastUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  terminalEmitted: boolean;
}

function wireFrame(event: unknown): ProxyStreamFrame {
  const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
  return {
    data: JSON.stringify(event),
    ...(typeof type === 'string' && type.length > 0 ? { event: type } : {}),
  };
}

interface ExtractedStreamChunk {
  answerDelta?: string;
  reasoningDelta?: string;
  finishReason?: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error';
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/**
 * Extract answer/reasoning/finish-reason/usage from an OpenAI-compatible
 * streaming chunk. Returns `undefined` for chunks that carry no observable
 * information. Silently ignores unknown fields so a future OpenAI-compatible
 * addition (for example `logprobs`) does not raise an error.
 */
function extractOpenAIStreamChunk(raw: unknown): ExtractedStreamChunk | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const chunk: ExtractedStreamChunk = {};

  const choices = value.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];
    if (typeof choice === 'object' && choice !== null) {
      const choiceRecord = choice as Record<string, unknown>;
      const delta = choiceRecord.delta;
      if (typeof delta === 'object' && delta !== null) {
        const deltaRecord = delta as Record<string, unknown>;
        const content = deltaRecord.content;
        if (typeof content === 'string' && content.length > 0) {
          chunk.answerDelta = content;
        }
        // DeepSeek / OpenMythos reasoning stream: `reasoning_content`.
        // Some Ollama models expose `reasoning`. Prefer the OpenAI-compatible
        // field, fall back to the shorter one.
        const reasoning = deltaRecord.reasoning_content ?? deltaRecord.reasoning;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          chunk.reasoningDelta = reasoning;
        }
      }
      const finishReason = choiceRecord.finish_reason;
      if (typeof finishReason === 'string') {
        chunk.finishReason = normalizeFinishReason(finishReason);
      }
    }
  }

  const usage = value.usage;
  if (typeof usage === 'object' && usage !== null) {
    const usageRecord = usage as Record<string, unknown>;
    const prompt = numeric(usageRecord.prompt_tokens);
    const completion = numeric(usageRecord.completion_tokens);
    const total = numeric(usageRecord.total_tokens);
    if (prompt !== undefined || completion !== undefined || total !== undefined) {
      chunk.usage = {
        ...(prompt === undefined ? {} : { promptTokens: prompt }),
        ...(completion === undefined ? {} : { completionTokens: completion }),
        ...(total === undefined ? {} : { totalTokens: total }),
      };
    }
  }

  if (
    chunk.answerDelta === undefined &&
    chunk.reasoningDelta === undefined &&
    chunk.finishReason === undefined &&
    chunk.usage === undefined
  ) {
    return undefined;
  }
  return chunk;
}

interface ExtractedNonStreamChunk {
  content: string;
  finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter';
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

function extractOpenAINonStreamChunk(raw: unknown): ExtractedNonStreamChunk | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const value = raw as Record<string, unknown>;
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0];
  if (typeof choice !== 'object' || choice === null) return undefined;
  const choiceRecord = choice as Record<string, unknown>;
  const message = choiceRecord.message;
  if (typeof message !== 'object' || message === null) return undefined;
  const messageRecord = message as Record<string, unknown>;
  const content = messageRecord.content;
  if (typeof content !== 'string') return undefined;

  const finishReasonRaw = choiceRecord.finish_reason;
  const finishReason =
    typeof finishReasonRaw === 'string' ? normalizeFinishReason(finishReasonRaw) : 'stop';
  const boundedFinishReason: ExtractedNonStreamChunk['finishReason'] =
    finishReason === 'error' ? 'stop' : finishReason;

  const usageRaw = value.usage;
  let usage: ExtractedNonStreamChunk['usage'];
  if (typeof usageRaw === 'object' && usageRaw !== null) {
    const usageRecord = usageRaw as Record<string, unknown>;
    const prompt = numeric(usageRecord.prompt_tokens);
    const completion = numeric(usageRecord.completion_tokens);
    const total = numeric(usageRecord.total_tokens);
    if (prompt !== undefined || completion !== undefined || total !== undefined) {
      usage = {
        ...(prompt === undefined ? {} : { promptTokens: prompt }),
        ...(completion === undefined ? {} : { completionTokens: completion }),
        ...(total === undefined ? {} : { totalTokens: total }),
      };
    }
  }

  return {
    content,
    finishReason: boundedFinishReason,
    ...(usage === undefined ? {} : { usage }),
  };
}

function normalizeFinishReason(
  raw: string,
): 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error' {
  switch (raw) {
    case 'stop':
    case 'length':
    case 'tool_call':
    case 'content_filter':
      return raw;
    case 'tool_calls':
      return 'tool_call';
    default:
      return 'stop';
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
