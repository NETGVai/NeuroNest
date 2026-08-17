/**
 * Web Retrieval Service — Provider-neutral safe web retrieval with provenance.
 *
 * Enforces scheme/host/port/address/credential/scope policy, revalidates
 * DNS-connected addresses and redirects, applies configured limits, appends
 * provenance metadata, and returns redacted errors.
 *
 * Requirements: 24.1–24.8
 *
 * - 24.1: Provider-neutral results with source URL, timestamp, media type, digest, citation
 * - 24.2: Apply scheme, host, port, allow/deny-list, credential-stripping, scope policy
 * - 24.3: Block loopback, link-local, private, metadata-service addresses
 * - 24.4: Reapply destination and credential policy at every redirect hop
 * - 24.5: Validate connected address before sending request data
 * - 24.6: Enforce response byte, decoded byte, media type, duration, redirect limits
 * - 24.7: Append durable provenance (policy decision, redirect chain, addresses, digest, citation)
 * - 24.8: Return structured redacted error on violation
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import type { ScopeDescriptorV1 } from '../contracts/scope';
import type {
  WebRetrievalPolicy,
  WebRetrievalLimits,
  WebRetrievalRequest,
  WebRetrievalResult,
  WebRetrievalError,
  WebRetrievalConfig,
  RedirectHop,
  RetrievalProvenance,
  AddressClassification,
  DnsRevalidationResult,
} from './web-retrieval-schemas';
import type { ExecutionWorldPolicy } from './execution-world-policy';

// ─── DNS Resolver Interface ─────────────────────────────────────

/**
 * Interface for DNS resolution (injectable for testing).
 */
export interface DnsResolver {
  resolve(hostname: string): Promise<string[]>;
}

// ─── HTTP Fetcher Interface ─────────────────────────────────────

/**
 * Minimal HTTP response shape for provider-neutral retrieval.
 */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
  redirected?: boolean;
  url?: string;
}

/**
 * Interface for HTTP fetching (injectable for testing).
 * Must NOT follow redirects automatically — the service handles them manually.
 */
export interface HttpFetcher {
  fetch(
    url: string,
    options: {
      method: string;
      headers: Record<string, string>;
      signal?: AbortSignal;
      redirect: 'manual';
    },
  ): Promise<HttpResponse>;
}

// ─── Scope Checker Interface ────────────────────────────────────

/**
 * Interface for verifying web_retrieval is permitted in the Execution_World.
 * Requirement 24.8: Scope enforcement.
 */
export interface ScopeChecker {
  isWebRetrievalPermitted(executionWorldId: string, scope: ScopeDescriptorV1): boolean;
}

// ─── Service Configuration ──────────────────────────────────────

export interface WebRetrievalServiceConfig {
  /** Retrieval policy. */
  policy: WebRetrievalPolicy;
  /** Retrieval limits. */
  limits: WebRetrievalLimits;
  /** DNS resolver (injectable). */
  dnsResolver: DnsResolver;
  /** HTTP fetcher (injectable). */
  httpFetcher: HttpFetcher;
  /** Scope checker for Execution_World enforcement. */
  scopeChecker: ScopeChecker;
}

// ─── Address Classification ─────────────────────────────────────

/**
 * Classifies an IP address or hostname into security categories.
 * Requirement 24.3: Block loopback, link-local, private-network, metadata-service.
 */
export function classifyAddress(address: string): AddressClassification {
  const normalized = address.toLowerCase().trim();

  // Loopback
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized.startsWith('127.')
  ) {
    return 'loopback';
  }

  // IPv6 loopback
  if (normalized === '0:0:0:0:0:0:0:1' || normalized === '::1') {
    return 'loopback';
  }

  // Cloud metadata service addresses (must check before link-local since 169.254.169.254 is in link-local range)
  if (
    normalized === '169.254.169.254' ||
    normalized === 'metadata.google.internal' ||
    normalized === 'metadata.goog' ||
    normalized === '100.100.100.200' // Alibaba Cloud metadata
  ) {
    return 'metadata_service';
  }

  // Link-local IPv4
  if (normalized.startsWith('169.254.')) {
    return 'link_local';
  }

  // Link-local IPv6
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe80::')) {
    return 'link_local';
  }

  // Private RFC 1918 ranges
  if (normalized.startsWith('10.')) {
    return 'private';
  }
  if (normalized.startsWith('192.168.')) {
    return 'private';
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) {
    return 'private';
  }

  // IPv6 unique local (fc00::/7)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return 'private';
  }

  // 0.0.0.0 and unspecified
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
    return 'loopback';
  }

  return 'public';
}

/**
 * Returns true if the address classification is denied by policy.
 */
export function isAddressDenied(classification: AddressClassification): boolean {
  return classification !== 'public';
}

// ─── URL Parsing Utilities ──────────────────────────────────────

/**
 * Extracts the scheme from a URL.
 */
function extractScheme(url: string): string {
  try {
    return new URL(url).protocol.replace(/:$/, '');
  } catch {
    return '';
  }
}

/**
 * Extracts the hostname from a URL.
 */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Extracts the port from a URL (returns default ports for http/https if not explicit).
 */
function extractPort(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      return parseInt(parsed.port, 10);
    }
    if (parsed.protocol === 'https:') return 443;
    if (parsed.protocol === 'http:') return 80;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Checks if two URLs share the same origin (scheme + host + port).
 */
function isSameOrigin(url1: string, url2: string): boolean {
  try {
    const a = new URL(url1);
    const b = new URL(url2);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

/**
 * Checks if a URL contains embedded credentials (user:pass@host).
 */
function hasEmbeddedCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== '' || parsed.password !== '';
  } catch {
    return false;
  }
}

/**
 * Strips embedded credentials from a URL.
 */
function stripEmbeddedCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

// ─── Header Utilities ───────────────────────────────────────────

/** Headers that carry credentials and should be stripped per policy. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
]);

/**
 * Strips credential-carrying headers from a header map.
 * Requirement 24.4: Strip credentials/cookies.
 */
function stripCredentialHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!CREDENTIAL_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Strips sensitive headers from response headers before returning.
 */
function redactResponseHeaders(headers: Record<string, string>): Record<string, string> {
  const sensitiveResponse = new Set(['set-cookie', 'www-authenticate', 'proxy-authenticate']);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!sensitiveResponse.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

// ─── Pattern Matching ───────────────────────────────────────────

/**
 * Matches a hostname against a list of patterns (supports simple wildcards).
 */
function matchesHostPattern(hostname: string, patterns: string[]): boolean {
  const normalized = hostname.toLowerCase();
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (p === normalized) return true;
    // Wildcard: *.example.com matches sub.example.com
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // .example.com
      if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
        return true;
      }
    }
  }
  return false;
}

// ─── Citation ID Generation ─────────────────────────────────────

let citationCounter = 0;

/**
 * Generates a unique citation identity for retrieval provenance.
 */
function generateCitationId(): string {
  return `cite_${Date.now()}_${++citationCounter}`;
}

// ─── Content Hashing ────────────────────────────────────────────

/**
 * Computes a SHA-256 digest of content for provenance.
 */
function computeContentDigest(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Web Retrieval Service ──────────────────────────────────────

/**
 * Provider-neutral authority for safe web retrieval with provenance.
 *
 * Enforces scheme/host/port/address/credential/scope policy, revalidates
 * DNS-connected addresses and redirects, applies configured limits, appends
 * provenance, and returns redacted errors.
 */
export class WebRetrievalService {
  private readonly config: WebRetrievalServiceConfig;

  constructor(config: WebRetrievalServiceConfig) {
    this.config = config;
  }

  // ─── Main Retrieval Entry Point ─────────────────────────────

  /**
   * Performs a safe web retrieval with full policy enforcement and provenance.
   *
   * Returns either a successful result with provenance or a redacted error.
   */
  async retrieve(
    request: WebRetrievalRequest,
  ): Promise<WebRetrievalResult | WebRetrievalError> {
    const startTime = Date.now();
    const redirectChain: RedirectHop[] = [];
    let currentUrl = request.url;
    let resolvedAddresses: string[] = [];

    // ─── Requirement 24.8: Scope enforcement ────────────────
    if (
      !this.config.scopeChecker.isWebRetrievalPermitted(
        request.executionWorldId,
        request.scope,
      )
    ) {
      return this.makeError(request, 'scope_denied', 'Web retrieval is not permitted in this execution scope', 'scope_check');
    }

    // ─── Pre-request URL Policy Checks ──────────────────────

    // Credential stripping from URL (Requirement 24.4)
    if (this.config.policy.stripCredentials && hasEmbeddedCredentials(currentUrl)) {
      currentUrl = stripEmbeddedCredentials(currentUrl);
    }

    // Validate the initial URL against policy
    const initialCheck = this.validateUrl(currentUrl, request);
    if (initialCheck) return initialCheck;

    // ─── DNS Revalidation (Requirement 24.5) ────────────────

    const hostname = extractHostname(currentUrl);
    const dnsResult = await this.revalidateDns(hostname);
    if (!dnsResult.allAllowed && this.config.policy.denyPrivateAddresses) {
      return this.makeError(
        request,
        'dns_revalidation_failed',
        'DNS resolution returned disallowed address range',
        'dns_address_revalidation',
      );
    }
    resolvedAddresses = dnsResult.resolvedAddresses;

    // ─── Prepare Request Headers ────────────────────────────

    let headers: Record<string, string> = { ...(request.headers ?? {}) };
    if (this.config.policy.stripCredentials) {
      headers = stripCredentialHeaders(headers);
    }

    // ─── Execute with Redirect Following ────────────────────

    const { limits } = this.config;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), limits.timeoutMs);

    try {
      let redirectCount = 0;

      while (true) {
        // Check redirect limit (Requirement 24.6)
        if (redirectCount > limits.maxRedirects) {
          return this.makeError(
            request,
            'redirect_limit_exceeded',
            `Redirect limit of ${limits.maxRedirects} exceeded`,
            'redirect_count_limit',
            { redirectChain, resolvedAddresses, currentUrl, startTime },
          );
        }

        // Timeout check
        if (Date.now() - startTime > limits.timeoutMs) {
          return this.makeError(
            request,
            'timeout_exceeded',
            'Request duration exceeded configured timeout',
            'duration_limit',
            { redirectChain, resolvedAddresses, currentUrl, startTime },
          );
        }

        // Execute the fetch
        let response: HttpResponse;
        try {
          response = await this.config.httpFetcher.fetch(currentUrl, {
            method: request.method ?? 'GET',
            headers,
            signal: abortController.signal,
            redirect: 'manual',
          });
        } catch (err: unknown) {
          if (abortController.signal.aborted) {
            return this.makeError(
              request,
              'timeout_exceeded',
              'Request duration exceeded configured timeout',
              'duration_limit',
              { redirectChain, resolvedAddresses, currentUrl, startTime },
            );
          }
          return this.makeError(
            request,
            'network_error',
            'Network request failed',
            'network_fetch',
            { redirectChain, resolvedAddresses, currentUrl, startTime },
          );
        }

        // Handle redirect responses (3xx)
        if (response.status >= 300 && response.status < 400 && response.headers['location']) {
          const redirectTarget = this.resolveRedirectUrl(
            currentUrl,
            response.headers['location'],
          );

          // Requirement 24.4: Reapply policy at every redirect hop
          const redirectCheck = this.validateUrl(redirectTarget, request);
          if (redirectCheck) return redirectCheck;

          // DNS revalidation on redirect destination (Requirement 24.5)
          const redirectHostname = extractHostname(redirectTarget);
          const redirectDns = await this.revalidateDns(redirectHostname);
          if (!redirectDns.allAllowed && this.config.policy.denyPrivateAddresses) {
            return this.makeError(
              request,
              'redirect_policy_violated',
              'Redirect destination resolved to disallowed address',
              'redirect_dns_revalidation',
              { redirectChain, resolvedAddresses, currentUrl, startTime },
            );
          }

          // Record the redirect hop
          const hopClassification = redirectDns.resolvedAddresses.length > 0
            ? classifyAddress(redirectDns.resolvedAddresses[0])
            : 'public' as AddressClassification;

          redirectChain.push({
            fromUrl: currentUrl,
            toUrl: redirectTarget,
            statusCode: response.status,
            addressClassification: hopClassification,
          });

          // Strip credentials on cross-origin redirect (Requirement 24.4)
          if (
            this.config.policy.stripCredentialsOnCrossOriginRedirect &&
            !isSameOrigin(currentUrl, redirectTarget)
          ) {
            headers = stripCredentialHeaders(headers);
          }

          resolvedAddresses = [...resolvedAddresses, ...redirectDns.resolvedAddresses];
          currentUrl = redirectTarget;
          redirectCount++;
          continue;
        }

        // ─── Response Validation ────────────────────────────

        // Media type check (Requirement 24.6)
        const contentType = response.headers['content-type'] ?? '';
        const mediaType = contentType.split(';')[0].trim().toLowerCase();
        if (
          limits.allowedMediaTypes.length > 0 &&
          mediaType &&
          !limits.allowedMediaTypes.includes(mediaType)
        ) {
          return this.makeError(
            request,
            'media_type_denied',
            'Response media type is not in the allowed list',
            'media_type_allowlist',
            { redirectChain, resolvedAddresses, currentUrl, startTime },
          );
        }

        // Response size check (Requirement 24.6)
        const bodyBuffer = typeof response.body === 'string'
          ? Buffer.from(response.body, 'utf-8')
          : response.body;
        const bodyBytes = bodyBuffer.length;

        let truncated = false;
        let finalBody: string;

        if (bodyBytes > limits.maxResponseBytes) {
          truncated = true;
          finalBody = bodyBuffer.subarray(0, limits.maxResponseBytes).toString('utf-8');
        } else {
          finalBody = bodyBuffer.toString('utf-8');
        }

        // Decoded size check
        if (Buffer.byteLength(finalBody, 'utf-8') > limits.maxDecodedBytes) {
          truncated = true;
          // Re-truncate at decoded limit
          const encoder = new TextEncoder();
          let encoded = encoder.encode(finalBody);
          if (encoded.length > limits.maxDecodedBytes) {
            encoded = encoded.subarray(0, limits.maxDecodedBytes);
            finalBody = new TextDecoder().decode(encoded);
          }
        }

        // ─── Build Provenance (Requirement 24.7) ────────────

        const durationMs = Date.now() - startTime;
        const contentDigest = computeContentDigest(finalBody);
        const citationId = generateCitationId();
        const finalHostname = extractHostname(currentUrl);
        const connectedClassification = resolvedAddresses.length > 0
          ? classifyAddress(resolvedAddresses[resolvedAddresses.length - 1])
          : 'public' as AddressClassification;

        const provenance: RetrievalProvenance = {
          resolvedUrl: currentUrl,
          requestedUrl: request.url,
          resolvedHost: finalHostname,
          connectedAddressClassification: connectedClassification,
          resolvedAddresses,
          redirectChain,
          redirectCount: redirectChain.length,
          policyDecision: 'allowed',
          contentDigest,
          citationId,
          mediaType: mediaType || undefined,
          responseSizeBytes: bodyBytes,
          durationMs,
          retrievedAt: new Date().toISOString(),
        };

        // ─── Build Result ───────────────────────────────────

        const result: WebRetrievalResult = {
          schemaVersion: 1,
          requestId: request.requestId,
          correlationId: request.correlationId,
          statusCode: response.status,
          headers: redactResponseHeaders(response.headers),
          body: finalBody,
          bodyBytes: Buffer.byteLength(finalBody, 'utf-8'),
          truncated,
          provenance,
        };

        return result;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── DNS Revalidation ───────────────────────────────────────

  /**
   * Resolves DNS and validates that all resolved addresses are allowed.
   * Requirement 24.5: Validate connected address before sending request data.
   */
  async revalidateDns(hostname: string): Promise<DnsRevalidationResult> {
    let resolvedAddresses: string[];
    try {
      resolvedAddresses = await this.config.dnsResolver.resolve(hostname);
    } catch {
      // If DNS resolution fails, treat as empty (will fail on connect)
      resolvedAddresses = [];
    }

    const classifications = resolvedAddresses.map(classifyAddress);
    const deniedAddresses = resolvedAddresses.filter((_, i) => isAddressDenied(classifications[i]));
    const allAllowed = deniedAddresses.length === 0;

    return {
      hostname,
      resolvedAddresses,
      classifications,
      allAllowed,
      deniedAddresses,
    };
  }

  // ─── URL Validation ─────────────────────────────────────────

  /**
   * Validates a URL against the configured policy.
   * Returns a redacted error if the URL violates policy, or null if valid.
   *
   * Requirements 24.1, 24.2: Scheme, host, port, deny-list enforcement.
   */
  validateUrl(
    url: string,
    request: WebRetrievalRequest,
  ): WebRetrievalError | null {
    const { policy } = this.config;

    // Scheme check (Requirement 24.1)
    const scheme = extractScheme(url);
    if (!policy.allowedSchemes.includes(scheme)) {
      return this.makeError(
        request,
        'scheme_denied',
        `URL scheme "${scheme}" is not in the allowed schemes list`,
        'scheme_allowlist',
      );
    }

    // Host checks (Requirement 24.2)
    const hostname = extractHostname(url);

    // Deny list takes precedence
    if (policy.deniedHosts.length > 0 && matchesHostPattern(hostname, policy.deniedHosts)) {
      return this.makeError(
        request,
        'host_denied',
        'Host is in the denied hosts list',
        'host_denylist',
      );
    }

    // Allow list check (if non-empty, host must be in it)
    if (policy.allowedHosts.length > 0 && !matchesHostPattern(hostname, policy.allowedHosts)) {
      return this.makeError(
        request,
        'host_denied',
        'Host is not in the allowed hosts list',
        'host_allowlist',
      );
    }

    // Port checks
    const port = extractPort(url);
    if (policy.deniedPorts.length > 0 && policy.deniedPorts.includes(port)) {
      return this.makeError(
        request,
        'port_denied',
        'Port is in the denied ports list',
        'port_denylist',
      );
    }
    if (policy.allowedPorts.length > 0 && !policy.allowedPorts.includes(port)) {
      return this.makeError(
        request,
        'port_denied',
        'Port is not in the allowed ports list',
        'port_allowlist',
      );
    }

    // Embedded credential check (Requirement 24.4)
    if (policy.stripCredentials && hasEmbeddedCredentials(url)) {
      return this.makeError(
        request,
        'credential_policy_violated',
        'URL contains embedded credentials which are not permitted',
        'credential_strip_policy',
      );
    }

    // Direct address classification check for hostname (Requirement 24.3)
    if (policy.denyPrivateAddresses) {
      const classification = classifyAddress(hostname);
      if (isAddressDenied(classification)) {
        return this.makeError(
          request,
          'private_address_denied',
          'Target resolves to a disallowed address range',
          'address_classification_check',
        );
      }
    }

    return null;
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Resolves a redirect location relative to the current URL.
   */
  private resolveRedirectUrl(currentUrl: string, location: string): string {
    try {
      return new URL(location, currentUrl).toString();
    } catch {
      return location;
    }
  }

  /**
   * Creates a structured, redacted error response.
   * Requirement 24.8: No secrets or internal info leaked.
   */
  private makeError(
    request: WebRetrievalRequest,
    errorKind: WebRetrievalError['errorKind'],
    redactedMessage: string,
    violatedRule: string,
    context?: {
      redirectChain?: RedirectHop[];
      resolvedAddresses?: string[];
      currentUrl?: string;
      startTime?: number;
    },
  ): WebRetrievalError {
    const error: WebRetrievalError = {
      schemaVersion: 1,
      requestId: request.requestId,
      correlationId: request.correlationId,
      errorKind,
      redactedMessage,
      violatedRule,
      stopped: true,
    };

    // Attach partial provenance if context is available
    if (context) {
      error.partialProvenance = {
        requestedUrl: request.url,
        resolvedUrl: context.currentUrl,
        resolvedAddresses: context.resolvedAddresses,
        redirectChain: context.redirectChain,
        redirectCount: context.redirectChain?.length,
        policyDecision: 'denied',
        durationMs: context.startTime ? Date.now() - context.startTime : undefined,
        retrievedAt: new Date().toISOString(),
      };
    }

    return error;
  }
}
