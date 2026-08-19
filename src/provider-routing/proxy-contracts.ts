import { z } from 'zod';

/**
 * Validated contracts for NeuroNest cloud-proxy inference boundaries.
 *
 * Provider credentials are deliberately absent. Every schema is strict so a
 * legacy provider key, arbitrary endpoint, prompt-bearing diagnostic, or other
 * undeclared field is rejected rather than forwarded.
 *
 * Requirements: 5.3–5.7, 7.8, 8.9
 */

export const PROXY_CONTRACT_VERSION = 1 as const;
export const NEURONEST_PROXY_ORIGIN = 'https://llm.neuronest.cc' as const;
export const DEFAULT_PROXY_CAPABILITY_PATH = '/v1/chat/completions' as const;
export const DEFAULT_PROXY_INFERENCE_URL =
  `${NEURONEST_PROXY_ORIGIN}${DEFAULT_PROXY_CAPABILITY_PATH}` as const;
export const MAX_PROXY_RETRY_AFTER_MS = 86_400_000;

const IdentifierSchema = z.string().min(1).max(256);
const RevisionSchema = z.number().int().nonnegative().finite();
const ModelRoleSchema = z.enum([
  'planning',
  'chat',
  'autocomplete',
  'code_editing',
  'change_application',
  'embedding',
  'reranking',
  'review',
  'summarization',
]);
const InferenceInvocationSourceSchema = z.enum([
  'chat',
  'agent',
  'tool-assisted',
  'background',
  'retry',
]);
const EditionSchema = z.enum(['community', 'professional', 'enterprise']);

function parseUrl(raw: string, base?: string): URL | undefined {
  if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) return undefined;
  try {
    return base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return undefined;
  }
}

function isCredentialFreeCanonicalProxyUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    url.hostname === 'llm.neuronest.cc' &&
    url.port === '' &&
    url.username === '' &&
    url.password === ''
  );
}

function isProxyOriginInput(raw: string): boolean {
  const url = parseUrl(raw);
  return (
    url !== undefined &&
    isCredentialFreeCanonicalProxyUrl(url) &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
  );
}

/** Accepts normalized equivalents of the one production proxy origin. */
export const ProxyOriginV1Schema = z
  .string()
  .superRefine((raw, context) => {
    if (!isProxyOriginInput(raw)) {
      context.addIssue({
        code: 'custom',
        message: `proxy origin must normalize to ${NEURONEST_PROXY_ORIGIN}`,
      });
    }
  })
  .transform(() => NEURONEST_PROXY_ORIGIN);
export type ProxyOriginV1 = z.infer<typeof ProxyOriginV1Schema>;

/**
 * A capability path is relative to the canonical proxy origin. Percent
 * encoding, dot segments, query strings, fragments, and ambiguous separators
 * are forbidden so validation cannot disagree with the HTTP client's parser.
 */
export const ProxyCapabilityPathV1Schema = z
  .string()
  .min(1)
  .max(512)
  .superRefine((path, context) => {
    const valid =
      path.startsWith('/v1/') &&
      !path.endsWith('/') &&
      !path.includes('//') &&
      !path.includes('\\') &&
      !path.includes('?') &&
      !path.includes('#') &&
      !path.includes('%') &&
      !/[\u0000-\u001f\u007f]/u.test(path) &&
      path
        .split('/')
        .slice(1)
        .every(
          (segment) =>
            segment.length > 0 &&
            segment !== '.' &&
            segment !== '..' &&
            /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(segment),
        );

    if (!valid) {
      context.addIssue({
        code: 'custom',
        message: 'proxy capability path must be a normalized absolute /v1/ path',
      });
    }
  });
export type ProxyCapabilityPathV1 = z.infer<typeof ProxyCapabilityPathV1Schema>;

/** Request-time model capabilities communicated to the proxy. */
export const ProxyCapabilityMetadataV1Schema = z
  .object({
    reasoning: z.boolean().optional(),
    tools: z.boolean().optional(),
    structuredOutput: z.boolean().optional(),
  })
  .strict();
export type ProxyCapabilityMetadataV1 = z.infer<typeof ProxyCapabilityMetadataV1Schema>;

/**
 * A capability endpoint may only enter routing after its NeuroNest contract
 * has been authenticated by the caller and this strict metadata has parsed.
 * It carries a relative path, never a user-configurable origin.
 */
export const ProxyCapabilityEndpointV1Schema = z
  .object({
    schemaVersion: z.literal(PROXY_CONTRACT_VERSION),
    capability: z.string().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/u),
    path: ProxyCapabilityPathV1Schema,
    contractId: IdentifierSchema,
    contractRevision: RevisionSchema,
  })
  .strict();
export type ProxyCapabilityEndpointV1 = z.infer<typeof ProxyCapabilityEndpointV1Schema>;

export const ProxyProviderNeutralMessageV1Schema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(1_000_000),
  })
  .strict();
export type ProxyProviderNeutralMessageV1 = z.infer<
  typeof ProxyProviderNeutralMessageV1Schema
>;

export const ProxyInferenceRequestV1Schema = z
  .object({
    schemaVersion: z.literal(PROXY_CONTRACT_VERSION),
    requestId: IdentifierSchema,
    conversationId: IdentifierSchema,
    turnId: IdentifierSchema,
    attempt: z.number().int().nonnegative().finite(),
    provider: IdentifierSchema,
    model: IdentifierSchema,
    stream: z.boolean(),
    modelRole: ModelRoleSchema,
    invocationSource: InferenceInvocationSourceSchema,
    messages: z.array(ProxyProviderNeutralMessageV1Schema).min(1).max(512),
    capabilities: ProxyCapabilityMetadataV1Schema.optional(),
    clientContext: z
      .object({
        edition: EditionSchema,
        entitlementRevision: RevisionSchema,
        applicationVersion: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
export type ProxyInferenceRequestV1 = z.infer<typeof ProxyInferenceRequestV1Schema>;

export const ProxyUsageV1Schema = z
  .object({
    promptTokens: z.number().int().nonnegative().finite(),
    completionTokens: z.number().int().nonnegative().finite(),
    totalTokens: z.number().int().nonnegative().finite(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.promptTokens + usage.completionTokens !== usage.totalTokens) {
      context.addIssue({
        code: 'custom',
        path: ['totalTokens'],
        message: 'totalTokens must equal promptTokens plus completionTokens',
      });
    }
  });
export type ProxyUsageV1 = z.infer<typeof ProxyUsageV1Schema>;

/** Validated non-streaming response; streaming frames are defined separately. */
export const ProxyInferenceResponseV1Schema = z
  .object({
    schemaVersion: z.literal(PROXY_CONTRACT_VERSION),
    requestId: IdentifierSchema,
    correlationId: IdentifierSchema,
    provider: IdentifierSchema,
    model: IdentifierSchema,
    content: z.string().max(1_000_000),
    finishReason: z.enum(['stop', 'length', 'tool_call', 'content_filter']),
    usage: ProxyUsageV1Schema.optional(),
  })
  .strict();
export type ProxyInferenceResponseV1 = z.infer<typeof ProxyInferenceResponseV1Schema>;

export const ProxyErrorCodeV1Schema = z.enum([
  'authentication',
  'entitlement',
  'quota',
  'rate_limit',
  'invalid_request',
  'network',
  'stream',
  'upstream',
  'internal',
]);
export type ProxyErrorCodeV1 = z.infer<typeof ProxyErrorCodeV1Schema>;

export const ProxyErrorV1Schema = z
  .object({
    schemaVersion: z.literal(PROXY_CONTRACT_VERSION),
    requestId: IdentifierSchema.optional(),
    correlationId: IdentifierSchema,
    code: ProxyErrorCodeV1Schema,
    status: z.number().int().min(400).max(599),
    message: z.string().min(1).max(4_096),
    retryAfterMs: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_PROXY_RETRY_AFTER_MS)
      .optional(),
  })
  .strict()
  .superRefine((error, context) => {
    if (error.retryAfterMs !== undefined && error.status !== 429) {
      context.addIssue({
        code: 'custom',
        path: ['retryAfterMs'],
        message: 'retryAfterMs is only valid for a 429 proxy response',
      });
    }
  });
export type ProxyErrorV1 = z.infer<typeof ProxyErrorV1Schema>;

export const ProxyInferenceResultV1Schema = z.union([
  ProxyInferenceResponseV1Schema,
  ProxyErrorV1Schema,
]);
export type ProxyInferenceResultV1 = z.infer<typeof ProxyInferenceResultV1Schema>;

/** Allowlisted diagnostics contain route identity only, never request content. */
export const ProxyRouteDiagnosticsV1Schema = z
  .object({
    schemaVersion: z.literal(PROXY_CONTRACT_VERSION),
    correlationId: IdentifierSchema,
    routeId: IdentifierSchema,
    edition: EditionSchema,
    provider: IdentifierSchema,
    model: IdentifierSchema,
    modelRole: ModelRoleSchema,
    invocationSource: InferenceInvocationSourceSchema,
    streaming: z.boolean(),
    proxyStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();
export type ProxyRouteDiagnosticsV1 = z.infer<typeof ProxyRouteDiagnosticsV1Schema>;

function allowedCapabilityPaths(
  capabilities: readonly ProxyCapabilityEndpointV1[],
): ReadonlySet<string> {
  return new Set([
    DEFAULT_PROXY_CAPABILITY_PATH,
    ...capabilities.map((capability) => capability.path),
  ]);
}

function parseAllowedProxyEndpoint(
  raw: string,
  capabilities: readonly ProxyCapabilityEndpointV1[],
  base?: string,
): URL | undefined {
  const url = parseUrl(raw, base);
  if (
    url === undefined ||
    !isCredentialFreeCanonicalProxyUrl(url) ||
    url.search !== '' ||
    url.hash !== '' ||
    !ProxyCapabilityPathV1Schema.safeParse(url.pathname).success ||
    !allowedCapabilityPaths(capabilities).has(url.pathname)
  ) {
    return undefined;
  }
  return url;
}

/**
 * Resolves only the default endpoint or a path present in parsed capability
 * metadata. Bare user-provided paths and origins are never accepted.
 */
export function resolveProxyCapabilityUrl(
  capability?: ProxyCapabilityEndpointV1,
): string {
  if (capability === undefined) return DEFAULT_PROXY_INFERENCE_URL;
  const parsed = ProxyCapabilityEndpointV1Schema.parse(capability);
  return `${NEURONEST_PROXY_ORIGIN}${parsed.path}`;
}

export const ProxyRedirectV1Schema = z
  .object({
    schemaVersion: z.literal(PROXY_CONTRACT_VERSION),
    sourceUrl: z.string().min(1).max(2_048),
    location: z.string().min(1).max(2_048),
    capabilities: z.array(ProxyCapabilityEndpointV1Schema).max(64).default([]),
  })
  .strict()
  .superRefine((redirect, context) => {
    const source = parseAllowedProxyEndpoint(redirect.sourceUrl, redirect.capabilities);
    if (source === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['sourceUrl'],
        message: 'redirect source must be an explicitly allowed NeuroNest proxy endpoint',
      });
      return;
    }

    const target = parseAllowedProxyEndpoint(
      redirect.location,
      redirect.capabilities,
      source.toString(),
    );
    if (target === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['location'],
        message: 'redirect target must remain on an explicitly allowed NeuroNest proxy endpoint',
      });
    }
  });
export type ProxyRedirectV1 = z.infer<typeof ProxyRedirectV1Schema>;

/** Returns the normalized same-origin redirect target or rejects fail-closed. */
export function validateProxyRedirect(
  sourceUrl: string,
  location: string,
  capabilities: readonly ProxyCapabilityEndpointV1[] = [],
): string {
  const parsed = ProxyRedirectV1Schema.parse({
    schemaVersion: PROXY_CONTRACT_VERSION,
    sourceUrl,
    location,
    capabilities,
  });
  return new URL(parsed.location, parsed.sourceUrl).toString();
}
