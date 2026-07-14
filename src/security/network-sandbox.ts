/**
 * NetworkSandbox — Policy-based network access control for agent operations.
 *
 * Intercepts all outbound HTTP/HTTPS requests initiated during agent tool execution
 * by patching global `fetch` and Node.js `http`/`https` modules. Evaluates each
 * intercepted request against an active policy containing allow/deny rules by domain,
 * IP range, and port. Provides three configurable presets and logs all blocked
 * requests to the network_requests database table.
 *
 * Integrates as Layer 8 in the existing security model (after content scanning,
 * before external requests leave the process).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';

// ─── Types ──────────────────────────────────────────────────────

/** A single network policy rule */
export interface NetworkPolicyRule {
  id: string;
  /** 'allow' permits matching requests; 'deny' blocks them */
  action: 'allow' | 'deny';
  /** Domain pattern — supports wildcards: '*.example.com', 'example.com' */
  domain?: string;
  /** IP range in CIDR notation or exact IP: '10.0.0.0/8', '192.168.1.1' */
  ipRange?: string;
  /** Port number or range: 443, '8000-9000' */
  port?: number | string;
  /** Human-readable description of this rule */
  description?: string;
}

/** Network policy preset names */
export type NetworkPolicyPreset = 'permissive' | 'standard' | 'strict';

/** Full network policy configuration */
export interface NetworkPolicy {
  /** Which preset is active */
  preset: NetworkPolicyPreset;
  /** Allow rules (evaluated before deny in standard mode) */
  allowRules: NetworkPolicyRule[];
  /** Deny rules */
  denyRules: NetworkPolicyRule[];
  /** Custom allowlist for strict mode */
  strictAllowlist?: string[];
}

/** Logged network request record */
export interface NetworkRequestLog {
  id: string;
  sessionId: string;
  agentId: string | undefined;
  method: string;
  url: string;
  domain: string;
  headers: Record<string, string> | undefined;
  action: 'allowed' | 'blocked';
  policyRule: string | undefined;
  reason: string | undefined;
  timestamp: number;
}

/** Result of evaluating a request against the active policy */
export interface PolicyEvaluationResult {
  allowed: boolean;
  matchedRule?: NetworkPolicyRule;
  reason: string;
}

/** Context for the current interception scope */
export interface InterceptionContext {
  sessionId: string;
  agentId?: string;
}

// ─── Known Exfiltration Targets (Standard Preset) ───────────────

/**
 * Domains commonly used for data exfiltration or unauthorized data transfer.
 * Blocked in 'standard' mode.
 */
const KNOWN_EXFILTRATION_DOMAINS: string[] = [
  '*.ngrok.io',
  '*.ngrok-free.app',
  '*.pipedream.net',
  '*.webhook.site',
  '*.requestbin.com',
  '*.hookbin.com',
  '*.burpcollaborator.net',
  '*.oastify.com',
  '*.interact.sh',
  '*.canarytokens.com',
  '*.dnslog.cn',
  '*.ceye.io',
  '*.requestcatcher.com',
  '*.mockbin.org',
  '*.postbin.io',
  '*.bin.sh',
  '*.transfer.sh',
  '*.file.io',
  '*.paste.ee',
  '*.hastebin.com',
  '*.dpaste.org',
];

// ─── Preset Policies ────────────────────────────────────────────

/**
 * Permissive preset: allow all traffic, log only.
 * Suitable for development environments where full network access is needed.
 */
function createPermissivePolicy(): NetworkPolicy {
  return {
    preset: 'permissive',
    allowRules: [
      { id: 'permissive-allow-all', action: 'allow', domain: '*', description: 'Allow all outbound traffic' },
    ],
    denyRules: [],
  };
}

/**
 * Standard preset: block known exfiltration targets, allow everything else.
 * Default for most enterprise environments.
 */
function createStandardPolicy(): NetworkPolicy {
  const denyRules: NetworkPolicyRule[] = KNOWN_EXFILTRATION_DOMAINS.map((domain, idx) => ({
    id: `standard-deny-${idx}`,
    action: 'deny' as const,
    domain,
    description: `Block known exfiltration target: ${domain}`,
  }));

  // Also block common exfiltration ports
  denyRules.push({
    id: 'standard-deny-irc',
    action: 'deny',
    port: 6667,
    description: 'Block IRC port (common C2 channel)',
  });

  return {
    preset: 'standard',
    allowRules: [],
    denyRules,
  };
}

/**
 * Strict preset: allowlist-only mode. Only explicitly allowed domains/ports pass.
 * For high-security environments.
 */
function createStrictPolicy(allowlist?: string[]): NetworkPolicy {
  const defaultAllowlist = [
    'api.openai.com',
    'api.anthropic.com',
    'api.cohere.com',
    'generativelanguage.googleapis.com',
    'api.github.com',
    'registry.npmjs.org',
    'pypi.org',
  ];

  const domains = allowlist ?? defaultAllowlist;
  const allowRules: NetworkPolicyRule[] = domains.map((domain, idx) => ({
    id: `strict-allow-${idx}`,
    action: 'allow' as const,
    domain,
    description: `Allowlisted domain: ${domain}`,
  }));

  return {
    preset: 'strict',
    allowRules,
    denyRules: [],
    strictAllowlist: domains,
  };
}

// ─── Policy Evaluation Engine ───────────────────────────────────

/**
 * Check if a domain matches a pattern (supports wildcards).
 * Examples:
 *   '*.example.com' matches 'sub.example.com', 'deep.sub.example.com'
 *   'example.com' matches only 'example.com'
 *   '*' matches everything
 */
export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === '*') return true;

  const normalizedDomain = domain.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();

  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedDomain === suffix || normalizedDomain.endsWith('.' + suffix);
  }

  return normalizedDomain === normalizedPattern;
}

/**
 * Check if a port matches a rule's port specification.
 * Supports exact number or range string 'start-end'.
 */
export function portMatchesRule(port: number, rulePort: number | string): boolean {
  if (typeof rulePort === 'number') {
    return port === rulePort;
  }

  // Range: 'start-end'
  const parts = rulePort.split('-');
  if (parts.length === 2) {
    const start = parseInt(parts[0]!, 10);
    const end = parseInt(parts[1]!, 10);
    if (!isNaN(start) && !isNaN(end)) {
      return port >= start && port <= end;
    }
  }

  return false;
}

/**
 * Check if a given IP matches a CIDR range or exact IP.
 * Supports IPv4 only for now.
 */
export function ipMatchesRange(ip: string, cidr: string): boolean {
  if (!cidr.includes('/')) {
    // Exact match
    return ip === cidr;
  }

  const [rangeIp, prefixStr] = cidr.split('/');
  if (!rangeIp || !prefixStr) return false;
  const prefix = parseInt(prefixStr, 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) return false;

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(rangeIp);
  if (ipNum === null || rangeNum === null) return false;

  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let num = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (isNaN(octet) || octet < 0 || octet > 255) return null;
    num = (num << 8) | octet;
  }
  return num >>> 0;
}

/**
 * Check if a request matches a specific policy rule.
 */
export function requestMatchesRule(
  rule: NetworkPolicyRule,
  domain: string,
  port: number,
  ip?: string,
): boolean {
  let matches = false;

  // A rule must match ALL specified criteria (domain AND/OR port AND/OR IP)
  let criteriaCount = 0;
  let matchCount = 0;

  if (rule.domain) {
    criteriaCount++;
    if (domainMatchesPattern(domain, rule.domain)) matchCount++;
  }

  if (rule.port !== undefined) {
    criteriaCount++;
    if (portMatchesRule(port, rule.port)) matchCount++;
  }

  if (rule.ipRange && ip) {
    criteriaCount++;
    if (ipMatchesRange(ip, rule.ipRange)) matchCount++;
  }

  // All specified criteria must match
  matches = criteriaCount > 0 && matchCount === criteriaCount;
  return matches;
}

/**
 * Evaluate a request against the active network policy.
 */
export function evaluatePolicy(
  policy: NetworkPolicy,
  domain: string,
  port: number,
  ip?: string,
): PolicyEvaluationResult {
  const defaultPort = port || 443;

  switch (policy.preset) {
    case 'permissive':
      // Allow everything
      return { allowed: true, reason: 'Permissive policy: all traffic allowed' };

    case 'standard':
      // Check deny rules first — if matched, block
      for (const rule of policy.denyRules) {
        if (requestMatchesRule(rule, domain, defaultPort, ip)) {
          return {
            allowed: false,
            matchedRule: rule,
            reason: rule.description || `Blocked by deny rule: ${rule.id}`,
          };
        }
      }
      // Everything else is allowed
      return { allowed: true, reason: 'Standard policy: request not in deny list' };

    case 'strict':
      // Check allow rules — only explicitly allowed domains pass
      for (const rule of policy.allowRules) {
        if (requestMatchesRule(rule, domain, defaultPort, ip)) {
          return {
            allowed: true,
            matchedRule: rule,
            reason: rule.description || `Allowed by rule: ${rule.id}`,
          };
        }
      }
      // Everything else is blocked
      return {
        allowed: false,
        reason: `Strict policy: domain '${domain}' not in allowlist`,
      };

    default:
      return { allowed: false, reason: 'Unknown policy preset' };
  }
}

// ─── Request Logger ─────────────────────────────────────────────

/** Logger interface for persisting network request records */
export interface NetworkRequestLogger {
  log(entry: NetworkRequestLog): void;
  getEntries(sessionId: string, limit?: number): NetworkRequestLog[];
}

/**
 * In-memory logger implementation.
 * Production deployments should replace with a SQLite-backed implementation
 * writing to the network_requests table.
 */
export class InMemoryNetworkRequestLogger implements NetworkRequestLogger {
  private entries: NetworkRequestLog[] = [];
  private maxEntries = 5000;

  log(entry: NetworkRequestLog): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-Math.floor(this.maxEntries * 0.8));
    }
  }

  getEntries(sessionId: string, limit?: number): NetworkRequestLog[] {
    const filtered = this.entries.filter(e => e.sessionId === sessionId);
    return limit ? filtered.slice(-limit) : filtered;
  }

  getAllEntries(): NetworkRequestLog[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}

// ─── NetworkSandbox Singleton ───────────────────────────────────

/**
 * NetworkSandbox — the main class that intercepts HTTP/HTTPS requests and
 * enforces network policies during agent tool execution.
 *
 * Lazy-initialized singleton. Patches global fetch and http/https modules
 * when interception is activated, and restores originals when deactivated.
 */
export class NetworkSandbox {
  private static instance: NetworkSandbox | null = null;

  private policy: NetworkPolicy;
  private logger: NetworkRequestLogger;
  private intercepting = false;
  private context: InterceptionContext | null = null;

  // Store original implementations for restore
  private originalFetch: typeof globalThis.fetch | null = null;
  private originalHttpRequest: typeof http.request | null = null;
  private originalHttpsRequest: typeof https.request | null = null;
  private originalHttpGet: typeof http.get | null = null;
  private originalHttpsGet: typeof https.get | null = null;

  constructor(logger?: NetworkRequestLogger) {
    this.policy = createStandardPolicy();
    this.logger = logger ?? new InMemoryNetworkRequestLogger();
  }

  /** Get or create singleton instance */
  static getInstance(logger?: NetworkRequestLogger): NetworkSandbox {
    if (!NetworkSandbox.instance) {
      NetworkSandbox.instance = new NetworkSandbox(logger);
    }
    return NetworkSandbox.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (NetworkSandbox.instance) {
      NetworkSandbox.instance.deactivate();
    }
    NetworkSandbox.instance = null;
  }

  // ─── Policy Management ──────────────────────────────────────────

  /** Set the active network policy preset */
  setPreset(preset: NetworkPolicyPreset, strictAllowlist?: string[]): void {
    switch (preset) {
      case 'permissive':
        this.policy = createPermissivePolicy();
        break;
      case 'standard':
        this.policy = createStandardPolicy();
        break;
      case 'strict':
        this.policy = createStrictPolicy(strictAllowlist);
        break;
    }
  }

  /** Get the current active policy */
  getPolicy(): NetworkPolicy {
    return this.policy;
  }

  /** Set a fully custom policy */
  setPolicy(policy: NetworkPolicy): void {
    this.policy = policy;
  }

  /** Add a custom allow rule */
  addAllowRule(rule: Omit<NetworkPolicyRule, 'action'>): void {
    this.policy.allowRules.push({ ...rule, action: 'allow' });
  }

  /** Add a custom deny rule */
  addDenyRule(rule: Omit<NetworkPolicyRule, 'action'>): void {
    this.policy.denyRules.push({ ...rule, action: 'deny' });
  }

  // ─── Interception Lifecycle ─────────────────────────────────────

  /** Is interception currently active? */
  isActive(): boolean {
    return this.intercepting;
  }

  /**
   * Activate HTTP interception for a given agent execution context.
   * Patches global fetch and http/https request methods.
   */
  activate(context: InterceptionContext): void {
    if (this.intercepting) return;

    this.context = context;
    this.intercepting = true;
    this.patchFetch();
    this.patchHttp();
    this.patchHttps();
  }

  /**
   * Deactivate HTTP interception and restore original implementations.
   */
  deactivate(): void {
    if (!this.intercepting) return;

    this.restoreFetch();
    this.restoreHttp();
    this.restoreHttps();
    this.intercepting = false;
    this.context = null;
  }

  // ─── Request Evaluation ─────────────────────────────────────────

  /**
   * Evaluate a request against the active policy and log accordingly.
   * Returns whether the request should be allowed.
   */
  evaluateRequest(
    method: string,
    url: string,
    headers?: Record<string, string>,
  ): PolicyEvaluationResult {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      // Invalid URL — block it
      const result: PolicyEvaluationResult = {
        allowed: false,
        reason: `Invalid URL: ${url}`,
      };
      this.logRequest(method, url, 'unknown', 'blocked', result.reason, undefined);
      return result;
    }

    const domain = parsedUrl.hostname;
    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80);

    const result = evaluatePolicy(this.policy, domain, port);

    this.logRequest(
      method,
      url,
      domain,
      result.allowed ? 'allowed' : 'blocked',
      result.reason,
      result.matchedRule?.id,
      headers,
    );

    return result;
  }

  // ─── Logging ────────────────────────────────────────────────────

  private logRequest(
    method: string,
    url: string,
    domain: string,
    action: 'allowed' | 'blocked',
    reason?: string,
    policyRule?: string,
    headers?: Record<string, string>,
  ): void {
    const entry: NetworkRequestLog = {
      id: randomUUID(),
      sessionId: this.context?.sessionId ?? 'unknown',
      agentId: this.context?.agentId,
      method,
      url,
      domain,
      headers,
      action,
      policyRule,
      reason,
      timestamp: Date.now(),
    };
    this.logger.log(entry);
  }

  /** Get logged requests for a session */
  getRequestLog(sessionId: string, limit?: number): NetworkRequestLog[] {
    return this.logger.getEntries(sessionId, limit);
  }

  /** Get the logger instance */
  getLogger(): NetworkRequestLogger {
    return this.logger;
  }

  // ─── Fetch Patching ─────────────────────────────────────────────

  private patchFetch(): void {
    this.originalFetch = globalThis.fetch;

    const sandbox = this;
    // Use `any` for fetch input types since the project doesn't include DOM lib
    // but Node.js 18+ provides fetch globally
    globalThis.fetch = function interceptedFetch(
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      const { method, url } = sandbox.extractFetchDetails(input, init);
      const headers = sandbox.extractHeaders(init?.headers as unknown);
      const result = sandbox.evaluateRequest(method, url, headers);

      if (!result.allowed) {
        return Promise.reject(
          new NetworkSandboxError(
            `Network request blocked by sandbox policy: ${result.reason}`,
            url,
            method,
          ),
        );
      }

      return sandbox.originalFetch!.call(globalThis, input, init);
    } as typeof globalThis.fetch;
  }

  private restoreFetch(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  private extractFetchDetails(
    input: string | URL | Request,
    init?: RequestInit,
  ): { method: string; url: string } {
    let url: string;
    let method = init?.method ?? 'GET';

    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else {
      // Request object
      url = (input as { url: string }).url;
      method = (input as { method?: string }).method || method;
    }

    return { method: method.toUpperCase(), url };
  }

  private extractHeaders(headers?: unknown): Record<string, string> | undefined {
    if (!headers) return undefined;

    const result: Record<string, string> = {};

    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2) {
          result[String(entry[0])] = String(entry[1]);
        }
      }
    } else if (typeof headers === 'object' && headers !== null) {
      // Check for forEach method (Headers-like)
      if ('forEach' in headers && typeof (headers as Record<string, unknown>)['forEach'] === 'function') {
        (headers as { forEach: (cb: (v: string, k: string) => void) => void }).forEach(
          (value: string, key: string) => { result[key] = value; },
        );
      } else {
        // Plain object
        for (const [key, value] of Object.entries(headers)) {
          result[key] = String(value);
        }
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  // ─── HTTP/HTTPS Module Patching ─────────────────────────────────
  //
  // Node.js http/https modules have non-configurable properties in some
  // environments. We use Object.defineProperty with configurable: true
  // to safely override, and fall back to prototype patching if needed.

  private patchHttp(): void {
    this.originalHttpRequest = http.request;
    this.originalHttpGet = http.get;

    const sandbox = this;

    const interceptedRequest = function(this: typeof http, ...args: unknown[]): http.ClientRequest {
      const { method, url } = sandbox.extractHttpDetails(args);
      const result = sandbox.evaluateRequest(method, url);

      if (!result.allowed) {
        throw new NetworkSandboxError(
          `Network request blocked by sandbox policy: ${result.reason}`,
          url,
          method,
        );
      }

      return sandbox.originalHttpRequest!.apply(http, args as Parameters<typeof http.request>);
    };

    const interceptedGet = function(this: typeof http, ...args: unknown[]): http.ClientRequest {
      const { url } = sandbox.extractHttpDetails(args);
      const result = sandbox.evaluateRequest('GET', url);

      if (!result.allowed) {
        throw new NetworkSandboxError(
          `Network request blocked by sandbox policy: ${result.reason}`,
          url,
          'GET',
        );
      }

      return sandbox.originalHttpGet!.apply(http, args as Parameters<typeof http.get>);
    };

    this.safeDefineProperty(http, 'request', interceptedRequest);
    this.safeDefineProperty(http, 'get', interceptedGet);
  }

  private restoreHttp(): void {
    if (this.originalHttpRequest) {
      this.safeDefineProperty(http, 'request', this.originalHttpRequest);
      this.originalHttpRequest = null;
    }
    if (this.originalHttpGet) {
      this.safeDefineProperty(http, 'get', this.originalHttpGet);
      this.originalHttpGet = null;
    }
  }

  private patchHttps(): void {
    this.originalHttpsRequest = https.request;
    this.originalHttpsGet = https.get;

    const sandbox = this;

    const interceptedRequest = function(this: typeof https, ...args: unknown[]): http.ClientRequest {
      const { method, url } = sandbox.extractHttpDetails(args, true);
      const result = sandbox.evaluateRequest(method, url);

      if (!result.allowed) {
        throw new NetworkSandboxError(
          `Network request blocked by sandbox policy: ${result.reason}`,
          url,
          method,
        );
      }

      return sandbox.originalHttpsRequest!.apply(https, args as Parameters<typeof https.request>);
    };

    const interceptedGet = function(this: typeof https, ...args: unknown[]): http.ClientRequest {
      const { url } = sandbox.extractHttpDetails(args, true);
      const result = sandbox.evaluateRequest('GET', url);

      if (!result.allowed) {
        throw new NetworkSandboxError(
          `Network request blocked by sandbox policy: ${result.reason}`,
          url,
          'GET',
        );
      }

      return sandbox.originalHttpsGet!.apply(https, args as Parameters<typeof https.get>);
    };

    this.safeDefineProperty(https, 'request', interceptedRequest);
    this.safeDefineProperty(https, 'get', interceptedGet);
  }

  private restoreHttps(): void {
    if (this.originalHttpsRequest) {
      this.safeDefineProperty(https, 'request', this.originalHttpsRequest);
      this.originalHttpsRequest = null;
    }
    if (this.originalHttpsGet) {
      this.safeDefineProperty(https, 'get', this.originalHttpsGet);
      this.originalHttpsGet = null;
    }
  }

  /**
   * Safely redefine a property on a module object.
   * Uses Object.defineProperty with configurable: true to allow future restores.
   * Falls back to direct assignment if defineProperty fails.
   */
  private safeDefineProperty(target: object, property: string, value: unknown): void {
    try {
      Object.defineProperty(target, property, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      // Fallback: direct assignment (may fail on frozen modules)
      try {
        (target as Record<string, unknown>)[property] = value;
      } catch {
        // Cannot patch this module — interception will rely on fetch only
      }
    }
  }

  /**
   * Extract method and URL from http.request/http.get arguments.
   * Handles the multiple overloaded signatures of these functions.
   */
  private extractHttpDetails(
    args: unknown[],
    isHttps = false,
  ): { method: string; url: string } {
    const protocol = isHttps ? 'https:' : 'http:';
    let method = 'GET';
    let url = '';

    const first = args[0];

    if (typeof first === 'string') {
      url = first;
      // Check if second arg is options with method
      const second = args[1];
      if (second && typeof second === 'object' && 'method' in second) {
        method = (second as { method?: string }).method || method;
      }
    } else if (first instanceof URL) {
      url = first.toString();
      const second = args[1];
      if (second && typeof second === 'object' && 'method' in second) {
        method = (second as { method?: string }).method || method;
      }
    } else if (first && typeof first === 'object') {
      // Options object
      const opts = first as {
        hostname?: string;
        host?: string;
        port?: number | string;
        path?: string;
        method?: string;
        protocol?: string;
      };
      method = opts.method || method;
      const host = opts.hostname || opts.host || 'localhost';
      const port = opts.port ? `:${opts.port}` : '';
      const path = opts.path || '/';
      const proto = opts.protocol || protocol;
      url = `${proto}//${host}${port}${path}`;
    }

    return { method: method.toUpperCase(), url };
  }
}

// ─── Error Class ────────────────────────────────────────────────

/**
 * Error thrown when a network request is blocked by the sandbox policy.
 */
export class NetworkSandboxError extends Error {
  readonly url: string;
  readonly method: string;

  constructor(message: string, url: string, method: string) {
    super(message);
    this.name = 'NetworkSandboxError';
    this.url = url;
    this.method = method;
  }
}

// ─── Factory Functions ──────────────────────────────────────────

/** Create a fresh NetworkSandbox with the specified preset */
export function createNetworkSandbox(
  preset: NetworkPolicyPreset = 'standard',
  logger?: NetworkRequestLogger,
): NetworkSandbox {
  const sandbox = new NetworkSandbox(logger);
  sandbox.setPreset(preset);
  return sandbox;
}

/** Get the preset policies for inspection/configuration */
export function getPresetPolicy(preset: NetworkPolicyPreset, strictAllowlist?: string[]): NetworkPolicy {
  switch (preset) {
    case 'permissive':
      return createPermissivePolicy();
    case 'standard':
      return createStandardPolicy();
    case 'strict':
      return createStrictPolicy(strictAllowlist);
  }
}
