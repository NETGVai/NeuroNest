import { z } from 'zod';
import {
  PROXY_CONTRACT_VERSION,
  ProxyErrorV1Schema,
  ProxyInferenceRequestV1Schema,
  type ProxyCapabilityMetadataV1,
  type ProxyInferenceRequestV1,
} from '../provider-routing/proxy-contracts.js';
import type {
  InferenceInvocationSource,
  ModelRole,
} from '../provider-routing/types.js';
import type {
  ChatMessage,
  CompletionChunk,
  CompletionOptions,
  CompletionResult,
  LLMProviderAdapter,
} from './provider-registry.js';
import {
  LLMProxyTransportError,
  type LLMProxyTransport,
} from './llm-proxy-transport.js';
import {
  classifyProxyError,
  type ProxyErrorRequestContext,
} from './proxy-error-classifier.js';

const CanonicalAnswerDeltaSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('answer.delta'),
    blockId: z.string().min(1),
    blockIndex: z.number().int().nonnegative(),
    delta: z.string().min(1),
    contentType: z.enum(['text', 'code', 'markdown']).optional(),
  })
  .strict();

const CanonicalTerminalSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.enum([
      'response.completed',
      'response.stopped',
      'response.interrupted',
      'response.failed',
    ]),
  })
  .passthrough();

const OpenAICompatibleChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z
              .object({
                content: z.string().nullable().optional(),
              })
              .passthrough()
              .optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export interface LLMProxyAdapterRequestContext {
  requestId: string;
  conversationId: string;
  turnId: string;
  attempt: number;
  modelRole: ModelRole;
  invocationSource: InferenceInvocationSource;
  capabilities?: ProxyCapabilityMetadataV1;
  clientContext: {
    edition: 'community' | 'professional' | 'enterprise';
    entitlementRevision: number;
    applicationVersion: string;
  };
}

export interface LLMProxyAdapterOptions {
  transport: LLMProxyTransport;
  provider: string;
  model: string;
  requestContext: () => LLMProxyAdapterRequestContext;
  id?: string;
  name?: string;
  isAvailable?: () => boolean | Promise<boolean>;
}

function createRequest(
  options: LLMProxyAdapterOptions,
  messages: ChatMessage[],
  stream: boolean,
): ProxyInferenceRequestV1 {
  const context = options.requestContext();
  return ProxyInferenceRequestV1Schema.parse({
    schemaVersion: PROXY_CONTRACT_VERSION,
    ...context,
    provider: options.provider,
    model: options.model,
    stream,
    messages,
  });
}

function mapFinishReason(
  finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter',
): CompletionResult['finishReason'] {
  return finishReason === 'length' || finishReason === 'tool_call' ? finishReason : 'stop';
}

function streamFailure(
  raw: unknown,
  context: ProxyErrorRequestContext,
): LLMProxyTransportError | undefined {
  const proxyError = ProxyErrorV1Schema.safeParse(raw);
  if (proxyError.success) {
    const classified = classifyProxyError(
      {
        kind: 'http',
        httpStatus: proxyError.data.status,
        proxyErrorBody: raw,
      },
      context,
    );
    return new LLMProxyTransportError(classified.summary, 'proxy_error', {
      status: proxyError.data.status,
      proxyError: proxyError.data,
      classified,
    });
  }

  const terminal = CanonicalTerminalSchema.safeParse(raw);
  if (
    terminal.success &&
    (terminal.data.type === 'response.interrupted' || terminal.data.type === 'response.failed')
  ) {
    return new LLMProxyTransportError('The proxy stream ended with a failure.', 'invalid_stream', {
      classified: classifyProxyError(
        {
          kind: 'stream',
          decodeSummary: 'The proxy stream ended with a failure.',
        },
        context,
      ),
    });
  }
  return undefined;
}

/**
 * Build a classifier context from the adapter's per-request proxy request.
 * Every field is a stable identifier or a bounded enum drawn from the
 * validated request object; no credential value, prompt content, or
 * response content is inspected.
 */
function adapterClassifierContext(
  request: ProxyInferenceRequestV1,
): ProxyErrorRequestContext {
  return {
    provider: request.provider,
    model: request.model,
    edition: request.clientContext.edition,
    invocationSource: request.invocationSource,
    requestType: request.stream ? 'streaming' : 'non-streaming',
    fallbackCorrelationId: request.requestId,
  };
}

/**
 * Provider-registry compatibility adapter backed exclusively by LLMProxyTransport.
 *
 * The adapter intentionally contains no base URL, proxy credential, or provider
 * API-key option. Canonical callers can consume transport.stream() directly to
 * preserve reasoning/tool/task frames; this compatibility surface exposes only
 * answer chunks because LLMProviderAdapter predates structured stream events.
 */
export function createLLMProxyAdapter(options: LLMProxyAdapterOptions): LLMProviderAdapter {
  const id = options.id ?? `neuronest-proxy:${options.provider}:${options.model}`;
  const name = options.name ?? `${options.provider} ${options.model} via NeuroNest`;

  return {
    id,
    name,

    async chatCompletion(
      messages: ChatMessage[],
      _completionOptions?: CompletionOptions,
    ): Promise<CompletionResult> {
      const response = await options.transport.complete(createRequest(options, messages, false));
      return {
        content: response.content,
        tokensUsed: {
          prompt: response.usage?.promptTokens ?? 0,
          completion: response.usage?.completionTokens ?? 0,
        },
        finishReason: mapFinishReason(response.finishReason),
      };
    },

    async *streamCompletion(
      messages: ChatMessage[],
      _completionOptions?: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      const request = createRequest(options, messages, true);
      const streamClassifierContext = adapterClassifierContext(request);
      let terminalSeen = false;

      for await (const frame of options.transport.stream(request)) {
        if (frame.data === '[DONE]') {
          terminalSeen = true;
          continue;
        }

        let raw: unknown;
        try {
          raw = JSON.parse(frame.data) as unknown;
        } catch (error) {
          throw new LLMProxyTransportError(
            'The proxy stream returned malformed JSON.',
            'invalid_stream',
            {
              cause: error,
              classified: classifyProxyError(
                {
                  kind: 'stream',
                  decodeSummary: 'The proxy stream returned malformed JSON.',
                  cause: error,
                },
                streamClassifierContext,
              ),
            },
          );
        }

        const failure = streamFailure(raw, streamClassifierContext);
        if (failure !== undefined) throw failure;

        const canonicalAnswer = CanonicalAnswerDeltaSchema.safeParse(raw);
        if (canonicalAnswer.success) {
          yield { content: canonicalAnswer.data.delta, done: false };
          continue;
        }

        const canonicalTerminal = CanonicalTerminalSchema.safeParse(raw);
        if (canonicalTerminal.success) {
          terminalSeen = true;
          continue;
        }

        const compatibleChunk = OpenAICompatibleChunkSchema.safeParse(raw);
        if (compatibleChunk.success) {
          const choice = compatibleChunk.data.choices[0];
          const content = choice?.delta?.content;
          if (content) yield { content, done: false };
          if (choice?.finish_reason) terminalSeen = true;
          continue;
        }

        // Structured reasoning/tool/task frames are valid canonical inputs for
        // the normalizer but have no representation in CompletionChunk.
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'schemaVersion' in raw &&
          'type' in raw
        ) {
          continue;
        }

        throw new LLMProxyTransportError(
          'The proxy stream returned an unsupported frame.',
          'invalid_stream',
          {
            classified: classifyProxyError(
              {
                kind: 'stream',
                decodeSummary: 'The proxy stream returned an unsupported frame.',
              },
              streamClassifierContext,
            ),
          },
        );
      }

      yield { content: '', done: true };
      void terminalSeen;
    },

    countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },

    async isAvailable(): Promise<boolean> {
      return options.isAvailable === undefined ? true : options.isAvailable();
    },
  };
}
