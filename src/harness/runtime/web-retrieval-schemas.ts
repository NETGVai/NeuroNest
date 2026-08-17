/**
 * Web Retrieval Schemas — Zod contracts for safe, provider-neutral web retrieval.
 *
 * Defines canonical types for Web_Retrieval_Service:
 * - Retrieval policy: scheme allowlist, host/port allowlist and denylist, credential rules
 * - Retrieval limits: response size, decoded size, timeout, redirect count, media type
 * - Retrieval requests and results with provenance
 * - Redacted error envelopes
 * - Address classification (loopback, link-local, private, metadata, public)
 *
 * Requirements: 24.1–24.8
 */

import { z } from 'zod';
import { IdentifierSchema, TimestampSchema, IntegrityHashSchema } from '../contracts/primitives';
import { ScopeDescriptorV1Schema } from '../contracts/scope';

// ─── Address Classification ─────────────────────────────────────

/**
 * Classification of resolved IP addresses (Requirement 24.3).
 */
export const AddressClassificationSchema = z.enum([
  'loopback',
  'link_local',
  'private',
  'metadata_service',
  'public',
]);

export type AddressClassification = z.infer<typeof AddressClassificationSchema>;

// ─── Retrieval Policy ───────────────────────────────────────────

/**
 * Policy applied to web retrieval requests (Requirement 24.2).
 * Configures scheme, host, port, address, and credential rules.
 */
export const WebRetrievalPolicySchema = z.object({
  /** Allowed URL schemes (default: ['https']). Requirement 24.1. */
  allowedSchemes: z.array(z.string().min(1)).min(1).default(['https']),
  /** Allowed hosts (empty = all non-denied hosts allowed). */
  allowedHosts: z.array(z.string()).default([]),
  /** Denied hosts (takes precedence over allowedHosts). */
  deniedHosts: z.array(z.string()).default([]),
  /** Allowed ports (empty = default port for scheme). */
  allowedPorts: z.array(z.number().int().positive().max(65535)).default([]),
  /** Denied ports. */
  deniedPorts: z.array(z.number().int().positive().max(65535)).default([]),
  /** Deny private/loopback/link-local/metadata addresses. Requirement 24.3. */
  denyPrivateAddresses: z.boolean().default(true),
  /** Strip credentials/cookies from requests. Requirement 24.4. */
  stripCredentials: z.boolean().default(true),
  /** Strip credentials on redirect to unrelated host. Requirement 24.4. */
  stripCredentialsOnCrossOriginRedirect: z.boolean().default(true),
});

export type WebRetrievalPolicy = z.infer<typeof WebRetrievalPolicySchema>;

// ─── Retrieval Limits ───────────────────────────────────────────

/**
 * Configured resource limits for web retrieval (Requirement 24.6).
 */
export const WebRetrievalLimitsSchema = z.object({
  /** Maximum response body bytes. */
  maxResponseBytes: z.number().int().positive().finite().default(10_485_760),
  /** Maximum decoded body bytes. */
  maxDecodedBytes: z.number().int().positive().finite().default(10_485_760),
  /** Maximum total request duration in milliseconds. */
  timeoutMs: z.number().int().positive().finite().default(30_000),
  /** Maximum number of redirects to follow. Requirement 24.4. */
  maxRedirects: z.number().int().nonnegative().finite().default(5),
  /** Allowed media types (empty = all allowed). */
  allowedMediaTypes: z.array(z.string()).default([]),
});

export type WebRetrievalLimits = z.infer<typeof WebRetrievalLimitsSchema>;

// ─── Retrieval Request ──────────────────────────────────────────

/**
 * A web retrieval request submitted to Web_Retrieval_Service.
 */
export const WebRetrievalRequestSchema = z.object({
  /** Unique request identity. */
  requestId: IdentifierSchema,
  /** The target URL to retrieve. */
  url: z.string().url(),
  /** The HTTP method (GET by default for retrieval). */
  method: z.enum(['GET', 'HEAD']).default('GET'),
  /** Execution world for scope enforcement (Requirement 24.8). */
  executionWorldId: IdentifierSchema,
  /** Scope descriptor of the requester. */
  scope: ScopeDescriptorV1Schema,
  /** Custom headers (credentials are stripped per policy). */
  headers: z.record(z.string(), z.string()).optional(),
  /** Correlation ID for tracing. */
  correlationId: IdentifierSchema.optional(),
});

export type WebRetrievalRequest = z.infer<typeof WebRetrievalRequestSchema>;

// ─── Redirect Hop Record ────────────────────────────────────────

/**
 * Record of a single redirect hop for provenance (Requirement 24.7).
 */
export const RedirectHopSchema = z.object({
  /** The URL that issued the redirect. */
  fromUrl: z.string(),
  /** The redirect destination URL. */
  toUrl: z.string(),
  /** HTTP status code of the redirect response. */
  statusCode: z.number().int(),
  /** Classification of the resolved address at this hop. */
  addressClassification: AddressClassificationSchema,
});

export type RedirectHop = z.infer<typeof RedirectHopSchema>;

// ─── Retrieval Provenance ───────────────────────────────────────

/**
 * Provenance metadata appended to retrieval results (Requirement 24.7).
 * Captures policy decision, redirect chain, connected address, content digest,
 * and citation identity.
 */
export const RetrievalProvenanceSchema = z.object({
  /** The final resolved URL after all redirects. */
  resolvedUrl: z.string(),
  /** The original requested URL. */
  requestedUrl: z.string(),
  /** Host of the final resolved URL. */
  resolvedHost: z.string(),
  /** Classification of the connected address. */
  connectedAddressClassification: AddressClassificationSchema,
  /** Resolved IP addresses connected to. */
  resolvedAddresses: z.array(z.string()),
  /** Full redirect chain. */
  redirectChain: z.array(RedirectHopSchema),
  /** Number of redirects followed. */
  redirectCount: z.number().int().nonnegative(),
  /** The policy decision applied. */
  policyDecision: z.enum(['allowed', 'denied']),
  /** Content digest (integrity hash). */
  contentDigest: IntegrityHashSchema.optional(),
  /** Citation identity for attribution. */
  citationId: IdentifierSchema,
  /** Media type of the response. */
  mediaType: z.string().optional(),
  /** Response size in bytes. */
  responseSizeBytes: z.number().int().nonnegative(),
  /** Retrieval duration in milliseconds. */
  durationMs: z.number().nonnegative(),
  /** Retrieval timestamp. */
  retrievedAt: TimestampSchema,
});

export type RetrievalProvenance = z.infer<typeof RetrievalProvenanceSchema>;

// ─── Retrieval Result ───────────────────────────────────────────

/**
 * Successful retrieval result with provenance (Requirement 24.1, 24.7).
 */
export const WebRetrievalResultSchema = z.object({
  /** Schema version. */
  schemaVersion: z.literal(1),
  /** Request identity. */
  requestId: IdentifierSchema,
  /** Correlation ID. */
  correlationId: IdentifierSchema.optional(),
  /** HTTP status code of the final response. */
  statusCode: z.number().int(),
  /** Response headers (credential/cookie headers redacted). */
  headers: z.record(z.string(), z.string()),
  /** Response body (bounded by limits). */
  body: z.string(),
  /** Body byte length. */
  bodyBytes: z.number().int().nonnegative(),
  /** Whether the body was truncated due to limits. */
  truncated: z.boolean(),
  /** Full provenance metadata. */
  provenance: RetrievalProvenanceSchema,
});

export type WebRetrievalResult = z.infer<typeof WebRetrievalResultSchema>;

// ─── Redacted Error ─────────────────────────────────────────────

/**
 * Redacted retrieval error (Requirement 24.8).
 * No secrets, internal addresses, or sensitive information are exposed.
 */
export const WebRetrievalErrorSchema = z.object({
  /** Schema version. */
  schemaVersion: z.literal(1),
  /** Request identity. */
  requestId: IdentifierSchema,
  /** Correlation ID. */
  correlationId: IdentifierSchema.optional(),
  /** Error category. */
  errorKind: z.enum([
    'scheme_denied',
    'host_denied',
    'port_denied',
    'private_address_denied',
    'dns_revalidation_failed',
    'redirect_policy_violated',
    'redirect_limit_exceeded',
    'response_size_exceeded',
    'decoded_size_exceeded',
    'timeout_exceeded',
    'media_type_denied',
    'scope_denied',
    'network_error',
    'credential_policy_violated',
  ]),
  /** Redacted human-readable description (no secrets or internal info). */
  redactedMessage: z.string(),
  /** The policy rule that triggered the error. */
  violatedRule: z.string(),
  /** Whether retrieval was stopped (always true for errors). */
  stopped: z.literal(true),
  /** Partial provenance available at error time. */
  partialProvenance: RetrievalProvenanceSchema.partial().optional(),
});

export type WebRetrievalError = z.infer<typeof WebRetrievalErrorSchema>;

// ─── DNS Revalidation Record ────────────────────────────────────

/**
 * Result of DNS revalidation check (Requirement 24.5).
 */
export const DnsRevalidationResultSchema = z.object({
  /** Hostname resolved. */
  hostname: z.string(),
  /** Resolved addresses. */
  resolvedAddresses: z.array(z.string()),
  /** Classification of each resolved address. */
  classifications: z.array(AddressClassificationSchema),
  /** Whether all resolved addresses passed policy. */
  allAllowed: z.boolean(),
  /** Addresses that were denied. */
  deniedAddresses: z.array(z.string()),
});

export type DnsRevalidationResult = z.infer<typeof DnsRevalidationResultSchema>;

// ─── Web Retrieval Configuration ────────────────────────────────

/**
 * Full configuration for Web_Retrieval_Service.
 * Combines policy and limits (both from validated Settings_Service revisions).
 */
export const WebRetrievalConfigSchema = z.object({
  /** Network access policy. */
  policy: WebRetrievalPolicySchema,
  /** Resource limits. */
  limits: WebRetrievalLimitsSchema,
});

export type WebRetrievalConfig = z.infer<typeof WebRetrievalConfigSchema>;
