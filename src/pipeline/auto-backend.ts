/**
 * Auto Backend — Detects LLM provider from model string and manages fallback routing.
 *
 * Provider detection rules:
 * - `gpt-*`, `o1-*`, `o3-*` → openai
 * - `claude-*` → anthropic
 * - `deepseek-*` → deepseek
 * - `gemini-*` → gemini
 * - `llama-*`, `mistral-*`, `phi-*`, `qwen-*` → ollama
 * - `grok-*` → grok
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import { getProviderCatalogEntry } from './provider-catalog.js';

// ─── Interfaces ─────────────────────────────────────────────────

/** Configuration for the Auto Backend router */
export interface AutoBackendConfig {
  modelString: string;
  apiKeys: Record<string, string>; // provider → key
  maxFallbacks: number; // Default: 2
}

/** Result of provider detection from a model string */
export interface ProviderDetection {
  provider: string;
  model: string;
  baseUrl: string;
  fallbackChain: string[]; // Ordered fallback providers
}

// ─── Provider Prefix Rules ──────────────────────────────────────

/** Maps model name prefixes to their provider */
const PREFIX_RULES: Array<{ prefixes: string[]; provider: string }> = [
  { prefixes: ['gpt', 'o1', 'o3'], provider: 'openai' },
  { prefixes: ['claude'], provider: 'anthropic' },
  { prefixes: ['deepseek'], provider: 'deepseek' },
  { prefixes: ['gemini'], provider: 'gemini' },
  { prefixes: ['llama', 'mistral', 'phi', 'qwen'], provider: 'ollama' },
  { prefixes: ['grok'], provider: 'grok' },
];

// ─── Fallback Chains ────────────────────────────────────────────

/**
 * Defines the ordered fallback chain for each provider.
 * When a primary provider fails, the system tries these alternatives in order.
 */
const FALLBACK_CHAINS: Record<string, string[]> = {
  openai: ['anthropic', 'deepseek'],
  anthropic: ['openai', 'deepseek'],
  deepseek: ['openai', 'anthropic'],
  gemini: ['openai', 'anthropic'],
  ollama: ['openai', 'deepseek'],
  grok: ['openai', 'anthropic'],
};

// ─── Default Base URLs ──────────────────────────────────────────

/** Default API base URLs per provider (uses provider-catalog when available) */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  ollama: 'http://localhost:11434/v1',
  grok: 'https://api.x.ai/v1',
};

// ─── Provider Detection ─────────────────────────────────────────

/**
 * Detect the LLM provider from a model string by matching known prefixes.
 *
 * The function normalizes the model string to lowercase and checks each
 * prefix rule. If no prefix matches, defaults to 'openai' as fallback provider.
 *
 * @param modelString - The model identifier (e.g. "gpt-4o", "claude-3.5-sonnet")
 * @returns ProviderDetection with provider, model, baseUrl, and fallbackChain
 */
export function detectProvider(modelString: string): ProviderDetection {
  const normalizedModel = modelString.trim().toLowerCase();

  // Match against known prefix rules
  for (const rule of PREFIX_RULES) {
    for (const prefix of rule.prefixes) {
      if (normalizedModel === prefix || normalizedModel.startsWith(`${prefix}-`) || normalizedModel.startsWith(`${prefix}:`)) {
        const provider = rule.provider;
        const baseUrl = resolveBaseUrl(provider);
        const fallbackChain = FALLBACK_CHAINS[provider] || [];

        return {
          provider,
          model: modelString,
          baseUrl,
          fallbackChain,
        };
      }
    }
  }

  // Default to openai if no prefix matches
  return {
    provider: 'openai',
    model: modelString,
    baseUrl: resolveBaseUrl('openai'),
    fallbackChain: FALLBACK_CHAINS['openai'] || [],
  };
}

/**
 * Resolve the base URL for a provider using the provider catalog first,
 * falling back to the hardcoded defaults.
 */
function resolveBaseUrl(provider: string): string {
  const catalogEntry = getProviderCatalogEntry(provider);
  if (catalogEntry) {
    return catalogEntry.endpoint;
  }
  return DEFAULT_BASE_URLS[provider] || DEFAULT_BASE_URLS['openai'];
}

/**
 * Get the fallback chain for a given provider.
 *
 * @param provider - The provider identifier
 * @returns Ordered array of fallback provider names
 */
export function getFallbackChain(provider: string): string[] {
  return FALLBACK_CHAINS[provider] || [];
}

// ─── Fallback Execution ─────────────────────────────────────────

/**
 * Determines whether an error is a retriable connection/server error.
 * Connection errors, timeouts, and 5xx server errors trigger fallback.
 */
function isRetriableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // Connection errors
    if (msg.includes('econnrefused') || msg.includes('econnreset') || msg.includes('enotfound')) {
      return true;
    }
    // Timeout errors
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('esockettimedout')) {
      return true;
    }
    // 5xx server errors (commonly embedded in error messages from HTTP clients)
    if (/\b5\d{2}\b/.test(msg) || msg.includes('internal server error') || msg.includes('service unavailable') || msg.includes('bad gateway')) {
      return true;
    }
  }
  return true; // Default: treat all errors as retriable for fallback purposes
}

/**
 * Execute an LLM call with automatic fallback to alternative providers on failure.
 *
 * The function first attempts the primary provider detected from `config.modelString`.
 * On connection errors, timeouts, or server errors (5xx), it attempts the fallback
 * chain in order, up to `config.maxFallbacks` (default 2) attempts.
 *
 * @param config - The AutoBackendConfig with modelString, apiKeys, and maxFallbacks
 * @param executeFn - A function that executes the LLM call given a provider and baseUrl
 * @returns An object with the result and the provider that served the request
 * @throws The last error encountered if all providers fail, with a message listing all attempted providers
 *
 * Requirements: 6.2, 6.3, 6.4
 */
export async function executeWithFallback<T>(
  config: AutoBackendConfig,
  executeFn: (provider: string, baseUrl: string) => Promise<T>,
): Promise<{ result: T; provider: string }> {
  const detection = detectProvider(config.modelString);
  const maxFallbacks = config.maxFallbacks ?? 2;

  // Build the ordered list of providers to attempt: primary + fallback chain (limited)
  const providersToAttempt: Array<{ provider: string; baseUrl: string }> = [
    { provider: detection.provider, baseUrl: detection.baseUrl },
  ];

  const fallbackProviders = detection.fallbackChain.slice(0, maxFallbacks);
  for (const fallbackProvider of fallbackProviders) {
    const baseUrl = resolveBaseUrl(fallbackProvider);
    providersToAttempt.push({ provider: fallbackProvider, baseUrl });
  }

  const attemptedProviders: string[] = [];
  let lastError: Error | undefined;

  for (const { provider, baseUrl } of providersToAttempt) {
    attemptedProviders.push(provider);
    try {
      const result = await executeFn(provider, baseUrl);
      // Log which provider served the request
      console.log(`[AutoBackend] Request served by provider: ${provider}`);
      return { result, provider };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.log(`[AutoBackend] Provider "${provider}" failed: ${lastError.message}`);

      // If this is the primary and we have no retriable error, still try fallbacks
      // (we treat all errors as retriable for maximum resilience)
      if (!isRetriableError(error)) {
        // Non-retriable errors still get fallback attempts per design
      }
    }
  }

  // All providers failed — throw descriptive error
  throw new Error(
    `[AutoBackend] All providers failed. Attempted: [${attemptedProviders.join(', ')}]. ` +
    `Last error: ${lastError?.message ?? 'Unknown error'}`,
  );
}
