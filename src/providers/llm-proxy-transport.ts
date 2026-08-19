import {
  ProxyErrorV1Schema,
  ProxyInferenceRequestV1Schema,
  ProxyInferenceResponseV1Schema,
  resolveProxyCapabilityUrl,
  validateProxyRedirect,
  type ProxyCapabilityEndpointV1,
  type ProxyErrorV1,
  type ProxyInferenceRequestV1,
  type ProxyInferenceResponseV1,
} from '../provider-routing/proxy-contracts.js';
import {
  classifyProxyError,
  type ClassifiedProxyError,
  type HeadersLike,
  type ProxyErrorRequestContext,
} from './proxy-error-classifier.js';
import {
  ProxyStreamDecoder,
  type ProxyStreamDecoderOptions,
  type ProxyStreamFrame,
} from './proxy-stream-decoder.js';

/** Maximum buffered JSON body accepted from the proxy. */
export const MAX_PROXY_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_PROXY_REDIRECTS = 2;

/** Main-process-only credential boundary implemented by ProxyCredentialService. */
export interface ProxyCredentialBoundary {
  resolveAtBoundary(): string | undefined;
}

export type LLMProxyTransportErrorCode =
  | 'missing_credential'
  | 'network'
  | 'redirect_rejected'
  | 'proxy_error'
  | 'invalid_response'
  | 'invalid_stream';

export class LLMProxyTransportError extends Error {
  readonly code: LLMProxyTransportErrorCode;
  readonly status?: number;
  readonly proxyError?: ProxyErrorV1;
  /**
   * Typed classification produced by
   * {@link import('./proxy-error-classifier.js').classifyProxyError}. Attached
   * for every transport failure that reaches the throw site so downstream
   * callers can emit redacted diagnostics and pick a retry policy without
   * re-inspecting the underlying HTTP shape.
   *
   * Absent only for schema-level validation failures raised before the
   * transport has enough request context to classify (e.g. a stream flag
   * mismatch on the request itself).
   */
  readonly classified?: ClassifiedProxyError;

  constructor(
    message: string,
    code: LLMProxyTransportErrorCode,
    options: {
      status?: number;
      proxyError?: ProxyErrorV1;
      cause?: unknown;
      classified?: ClassifiedProxyError;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LLMProxyTransportError';
    this.code = code;
    this.status = options.status;
    this.proxyError = options.proxyError;
    this.classified = options.classified;
  }
}

export interface LLMProxyTransportDependencies {
  credentialBoundary: ProxyCredentialBoundary;
  fetchImpl?: typeof globalThis.fetch;
  maxRedirects?: number;
  maxJsonResponseBytes?: number;
  streamDecoderOptions?: ProxyStreamDecoderOptions;
}

export interface LLMProxyRequestOptions {
  signal?: AbortSignal;
  /** A path accepted only after parsing the signed/validated capability contract. */
  capability?: ProxyCapabilityEndpointV1;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function redirectLimit(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_MAX_PROXY_REDIRECTS;
}

/**
 * The only cloud-capable HTTP transport for NeuroNest inference.
 *
 * Credentials are resolved inside performFetch immediately before each HTTP
 * operation and are never retained on the transport instance or added to
 * request bodies, errors, response metadata, or adapter configuration.
 */
export class LLMProxyTransport {
  private readonly credentialBoundary: ProxyCredentialBoundary;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly maxRedirects: number;
  private readonly maxJsonResponseBytes: number;
  private readonly streamDecoderOptions: ProxyStreamDecoderOptions;

  constructor(dependencies: LLMProxyTransportDependencies) {
    this.credentialBoundary = dependencies.credentialBoundary;
    this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
    this.maxRedirects = redirectLimit(dependencies.maxRedirects);
    this.maxJsonResponseBytes = positiveInteger(
      dependencies.maxJsonResponseBytes,
      MAX_PROXY_JSON_RESPONSE_BYTES,
    );
    this.streamDecoderOptions = dependencies.streamDecoderOptions ?? {};
  }

  async complete(
    request: ProxyInferenceRequestV1,
    options: LLMProxyRequestOptions = {},
  ): Promise<ProxyInferenceResponseV1> {
    const parsedRequest = ProxyInferenceRequestV1Schema.parse(request);
    if (parsedRequest.stream) {
      throw new LLMProxyTransportError(
        'A non-streaming proxy operation requires stream=false.',
        'invalid_response',
      );
    }

    const response = await this.post(parsedRequest, 'application/json', options);
    const payload = await this.readJson(response, parsedRequest);
    const parsedResponse = ProxyInferenceResponseV1Schema.safeParse(payload);
    if (!parsedResponse.success) {
      throw new LLMProxyTransportError(
        'The proxy returned an invalid inference response.',
        'invalid_response',
        { status: response.status },
      );
    }

    if (
      parsedResponse.data.requestId !== parsedRequest.requestId ||
      parsedResponse.data.provider !== parsedRequest.provider ||
      parsedResponse.data.model !== parsedRequest.model
    ) {
      throw new LLMProxyTransportError(
        'The proxy response did not match the requested route.',
        'invalid_response',
        { status: response.status },
      );
    }

    return parsedResponse.data;
  }

  async *stream(
    request: ProxyInferenceRequestV1,
    options: LLMProxyRequestOptions = {},
  ): AsyncIterable<ProxyStreamFrame> {
    const parsedRequest = ProxyInferenceRequestV1Schema.parse(request);
    if (!parsedRequest.stream) {
      throw new LLMProxyTransportError(
        'A streaming proxy operation requires stream=true.',
        'invalid_stream',
      );
    }

    const response = await this.post(parsedRequest, 'text/event-stream', options);
    if (!response.body) {
      throw new LLMProxyTransportError(
        'The proxy stream returned no response body.',
        'invalid_stream',
        {
          status: response.status,
          classified: classifyProxyError(
            {
              kind: 'stream',
              httpStatus: response.status,
              headers: response.headers,
            },
            buildClassifierContext(parsedRequest),
          ),
        },
      );
    }

    const decoder = new ProxyStreamDecoder(this.streamDecoderOptions);
    const reader = response.body.getReader();
    const streamContext = buildClassifierContext(parsedRequest);
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        for (const result of decoder.push(next.value)) {
          if (!result.ok) {
            throw new LLMProxyTransportError(result.error.summary, 'invalid_stream', {
              status: response.status,
              classified: classifyProxyError(
                {
                  kind: 'stream',
                  httpStatus: response.status,
                  headers: response.headers,
                  decodeSummary: result.error.summary,
                },
                streamContext,
              ),
            });
          }
          yield result.frame;
        }
      }

      for (const result of decoder.finish()) {
        if (!result.ok) {
          throw new LLMProxyTransportError(result.error.summary, 'invalid_stream', {
            status: response.status,
            classified: classifyProxyError(
              {
                kind: 'stream',
                httpStatus: response.status,
                headers: response.headers,
                decodeSummary: result.error.summary,
              },
              streamContext,
            ),
          });
        }
        yield result.frame;
      }
    } catch (error) {
      if (error instanceof LLMProxyTransportError) throw error;
      throw new LLMProxyTransportError('The proxy stream could not be read.', 'invalid_stream', {
        status: response.status,
        cause: error,
        classified: classifyProxyError(
          {
            kind: 'stream',
            httpStatus: response.status,
            headers: response.headers,
            cause: error,
          },
          streamContext,
        ),
      });
    } finally {
      reader.releaseLock();
    }
  }

  private async post(
    request: ProxyInferenceRequestV1,
    accept: 'application/json' | 'text/event-stream',
    options: LLMProxyRequestOptions,
  ): Promise<Response> {
    const body = JSON.stringify(request);
    const capabilities = options.capability === undefined ? [] : [options.capability];
    let url = resolveProxyCapabilityUrl(options.capability);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const response = await this.performFetch(url, body, accept, options.signal, request);
      if (response.status < 300 || response.status >= 400) {
        if (!response.ok) await this.throwProxyError(response, request);
        return response;
      }

      const location = response.headers.get('location');
      if (
        redirectCount >= this.maxRedirects ||
        (response.status !== 307 && response.status !== 308) ||
        location === null
      ) {
        throw new LLMProxyTransportError(
          'The proxy returned a disallowed redirect.',
          'redirect_rejected',
          {
            status: response.status,
            classified: classifyProxyError(
              {
                kind: 'transport-mismatch',
                reason: 'disallowed-redirect',
              },
              buildClassifierContext(request),
            ),
          },
        );
      }

      try {
        url = validateProxyRedirect(url, location, capabilities);
      } catch (error) {
        throw new LLMProxyTransportError(
          'The proxy returned a disallowed redirect.',
          'redirect_rejected',
          {
            status: response.status,
            cause: error,
            classified: classifyProxyError(
              {
                kind: 'transport-mismatch',
                reason: 'invalid-redirect-target',
                cause: error,
              },
              buildClassifierContext(request),
            ),
          },
        );
      }
    }
  }

  private async performFetch(
    url: string,
    body: string,
    accept: string,
    signal?: AbortSignal,
    requestForContext?: ProxyInferenceRequestV1,
  ): Promise<Response> {
    // Keep the resolved value scoped to this single network operation.
    const credential = this.credentialBoundary.resolveAtBoundary();
    if (!credential) {
      throw new LLMProxyTransportError(
        'A valid NeuroNest proxy credential is required.',
        'missing_credential',
        requestForContext === undefined
          ? {}
          : {
              classified: classifyProxyError(
                { kind: 'network' },
                buildClassifierContext(requestForContext),
              ),
            },
      );
    }

    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          accept,
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body,
      });
    } catch (error) {
      throw new LLMProxyTransportError('The NeuroNest proxy request failed.', 'network', {
        cause: error,
        ...(requestForContext === undefined
          ? {}
          : {
              classified: classifyProxyError(
                { kind: 'network', cause: error },
                buildClassifierContext(requestForContext),
              ),
            }),
      });
    }
  }

  private async throwProxyError(
    response: Response,
    request: ProxyInferenceRequestV1,
  ): Promise<never> {
    const payload = await this.readBoundedJson(response).catch(() => undefined);
    const parsed = ProxyErrorV1Schema.safeParse(payload);
    const proxyError = parsed.success ? parsed.data : undefined;
    const context = buildClassifierContext(request);
    const classified = classifyProxyError(
      {
        kind: 'http',
        httpStatus: response.status,
        headers: response.headers,
        proxyErrorBody: payload,
      },
      context,
    );

    if (proxyError?.requestId !== undefined && proxyError.requestId !== request.requestId) {
      throw new LLMProxyTransportError(
        'The proxy returned an uncorrelated error response.',
        'invalid_response',
        {
          status: response.status,
          classified: classifyProxyError(
            {
              kind: 'transport-mismatch',
              reason: 'uncorrelated-response',
            },
            context,
          ),
        },
      );
    }

    throw new LLMProxyTransportError(
      // Do NOT surface the proxy body's free-form `message`; it is discarded
      // in favor of the classifier's allowlisted summary because the body
      // can carry user prompt/response echoes.
      classified.summary,
      'proxy_error',
      { status: response.status, proxyError, classified },
    );
  }

  private async readJson(response: Response, request: ProxyInferenceRequestV1): Promise<unknown> {
    const payload = await this.readBoundedJson(response);
    const proxyError = ProxyErrorV1Schema.safeParse(payload);
    if (proxyError.success) {
      const context = buildClassifierContext(request);
      if (
        proxyError.data.requestId !== undefined &&
        proxyError.data.requestId !== request.requestId
      ) {
        throw new LLMProxyTransportError(
          'The proxy returned an uncorrelated error response.',
          'invalid_response',
          {
            status: response.status,
            classified: classifyProxyError(
              { kind: 'transport-mismatch', reason: 'uncorrelated-response' },
              context,
            ),
          },
        );
      }
      const classified = classifyProxyError(
        {
          kind: 'http',
          httpStatus: proxyError.data.status,
          headers: response.headers,
          proxyErrorBody: payload,
        },
        context,
      );
      throw new LLMProxyTransportError(classified.summary, 'proxy_error', {
        status: proxyError.data.status,
        proxyError: proxyError.data,
        classified,
      });
    }
    return payload;
  }

  private async readBoundedJson(response: Response): Promise<unknown> {
    const text = await this.readBoundedText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new LLMProxyTransportError(
        'The proxy returned malformed JSON.',
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
          throw new LLMProxyTransportError(
            'The proxy JSON response exceeded the configured limit.',
            'invalid_response',
            { status: response.status },
          );
        }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      if (error instanceof LLMProxyTransportError) throw error;
      throw new LLMProxyTransportError(
        'The proxy response could not be decoded.',
        'invalid_response',
        { status: response.status, cause: error },
      );
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Derive a classifier context from the validated proxy request. Every
 * field is a stable identifier or a bounded enum drawn from the parsed
 * request; no credential value, prompt, or response content is inspected.
 */
function buildClassifierContext(
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

// Re-export the classifier types for callers that import from the transport.
export type { ClassifiedProxyError, HeadersLike, ProxyErrorRequestContext };
