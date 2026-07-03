/**
 * LLM Client — Makes real API calls to configured model providers.
 * Uses OpenAI-compatible API format (works with OpenAI, DeepSeek, Anthropic, Ollama, Groq, Mistral).
 *
 * Supports optional **Professional Mode** routing through the NeuroNest LLM proxy
 * (see `.kiro/specs/llm-proxy-professional-mode/design.md`). When the
 * `professionalMode` config field is enabled, requests are sent to the proxy
 * endpoint with a single `Authorization: Bearer <Proxy_Auth_Token>` header plus
 * `X-Provider` / `X-Model` routing headers. No provider-specific authentication
 * headers (`x-api-key`, `anthropic-version`, `x-goog-api-key`) are attached in
 * proxy mode. The request body is identical to direct-provider mode.
 */

import OpenAI from 'openai';
import { getProviderCatalogEntry } from './provider-catalog.js';
import { maybeCompressMessages } from './headroom-compressor';
import {
  applyPromptCacheDiscipline,
  extractCacheMetrics,
  extractOpenAICacheMetrics,
  isAnthropicProvider,
  type CacheMetrics,
  type CacheMetricsStore,
} from './prompt-cache-discipline.js';

/**
 * Routing configuration for Professional Mode. When `enabled` is true, the
 * `LLMClient` swaps the per-provider base URL for `endpoint` and authenticates
 * with `authToken` rather than the provider-specific API key.
 */
export interface ProxyConfig {
  enabled: boolean;
  endpoint: string;
  authToken: string;
}

interface LLMConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  provider: string;
  /** Optional Professional Mode proxy routing config. */
  professionalMode?: ProxyConfig;
  /** When true, apply prompt cache discipline (canonical ordering + Anthropic cache_control). */
  promptCacheDiscipline?: boolean;
  /** Optional cache metrics store for logging provider cache hits. */
  cacheMetricsStore?: CacheMetricsStore;
  /** Optional session ID for cache metrics attribution. */
  sessionId?: string;
}

/**
 * Thrown when the proxy returns HTTP 402 (insufficient credits). The renderer
 * surfaces this as a balance top-up prompt rather than a generic error.
 */
export class InsufficientCreditsError extends Error {
  readonly balance?: number;
  constructor(message: string, balance?: number) {
    super(message);
    this.name = 'InsufficientCreditsError';
    if (balance !== undefined) {
      this.balance = balance;
    }
  }
}

/** Provider types that always run locally and must bypass the proxy. */
const LOCAL_PROVIDER_TYPES = new Set(['ollama', 'llamacpp', 'openmythos']);

/**
 * Returns true if the proxy routing should be used for this client request.
 * Centralized so the precedence order — auth-token validation BEFORE any
 * header construction or HTTP call — is consistent across `chat`/`chatStream`.
 */
function isProxyEnabled(cfg: LLMConfig): boolean {
  return cfg.professionalMode?.enabled === true;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * Optional trust metadata (F1: Untrusted_Source_Wrapper). Additive and
   * backward-compatible — messages produced before this field existed parse
   * identically. `trusted` marks whether the content originated from a trusted
   * operator (`true`/absent) or an untrusted external source (`false`);
   * `source` identifies the producing call site.
   */
  metadata?: { trusted?: boolean; source?: string };
}

interface LLMResponse {
  content: string;
  reasoning?: string;
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface StreamChunk {
  /** Token text fragment */
  content: string;
}

export interface StreamResult {
  /** Total tokens used (prompt + completion), if reported by the API */
  tokensUsed?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface StreamCallbacks {
  onToken: (chunk: StreamChunk) => void;
  onDone: (result: StreamResult) => void;
  onError: (error: { message: string; partialContent: string }) => void;
}

export interface ChatStreamOptions {
  temperature?: number;
  maxTokens?: number;
  nLoops?: number;
}

// Provider base URLs
export const PROVIDER_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  mistral: 'https://api.mistral.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  grok: 'https://api.x.ai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  ollama: 'http://localhost:11434/v1',
  llamacpp: 'http://localhost:8080/v1',
  openmythos: 'http://localhost:8200/v1'
};

/** Validate that n_loops is an integer in [1, 32]. */
export function validateNLoops(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 32;
}

/** Clamp n_loops to the valid range [1, 32]. */
export function clampNLoops(n: number): number {
  return Math.max(1, Math.min(32, Math.round(n)));
}

/** Determine the context token limit for a given model name. */
export function getContextLimit(modelName: string, isLocalModel: boolean): number {
  return modelName.includes('mythos') ? 8192
    : modelName.includes('gpt-4') || modelName.includes('gpt-4o') ? 128000
    : modelName.includes('gpt-3.5-turbo-16k') ? 16384
    : modelName.includes('gpt-3.5') ? 4096
    : modelName.includes('claude-3') ? 200000
    : modelName.includes('claude') ? 100000
    : modelName.includes('deepseek') ? 64000
    : modelName.includes('gemini') ? 128000
    : modelName.includes('mistral') && !isLocalModel ? 32000
    : modelName.includes('llama-3') || modelName.includes('llama3') ? 8192
    : modelName.includes('phi') ? 4096
    : modelName.includes('qwen') ? 32000
    : modelName.includes('codellama') ? 16384
    : modelName.includes('mixtral') ? 32000
    : isLocalModel ? 4096
    : 8192;
}

// ─── Special Token Sanitization ─────────────────────────────────────────
// Local models (Ollama, llama.cpp) can leak internal tokenizer artifacts
// into their output when they hit context limits or degenerate.

/** Known special tokens that should never appear in user-facing output */
const SPECIAL_TOKEN_PATTERNS = [
  /<\|end_of_context\|>/gi,
  /<\|eot_id\|>/gi,
  /<\|end\|>/gi,
  /<\|im_end\|>/gi,
  /<\|im_start\|>/gi,
  /<\|endoftext\|>/gi,
  /<\|pad\|>/gi,
  /<\|sep\|>/gi,
  /<\|assistant\|>/gi,
  /<\|user\|>/gi,
  /<\|system\|>/gi,
  /<lend_of_context\|>/gi,
  /<\/end_of_context\|>/gi,
  /<lend_of_context\/>/gi,
  /<\|end_of_context\/>/gi,
  /\[truncated\]/gi,
];

/** Stop sequences to send to local models to prevent token leakage */
const LOCAL_MODEL_STOP_SEQUENCES = [
  '<|end_of_context|>',
  '<|eot_id|>',
  '<|end|>',
  '<|im_end|>',
  '<|endoftext|>',
];

/**
 * Strip special tokens from LLM output.
 * Returns the cleaned content.
 */
function sanitizeModelOutput(content: string): string {
  let cleaned = content;
  for (const pattern of SPECIAL_TOKEN_PATTERNS) {
    cleaned = cleaned.replace(pattern, '');
  }
  // Collapse excessive newlines (4+ → 3) and excessive spaces (3+ → 1)
  // but do NOT trim — whitespace-only tokens (spaces, newlines) must be preserved
  // for streaming to maintain proper word separation
  cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n').replace(/ {3,}/g, ' ');
  return cleaned;
}

/**
 * Detect if model output is garbage (degenerate repetition, special token spam).
 * Returns an error message if garbage is detected, or null if output is valid.
 */
function detectGarbageOutput(content: string): string | null {
  if (!content || content.length === 0) return null;

  // Check for special token density — if >20% of content is special tokens, it's garbage
  let specialTokenChars = 0;
  for (const pattern of SPECIAL_TOKEN_PATTERNS) {
    const matches = content.match(pattern);
    if (matches) {
      specialTokenChars += matches.join('').length;
    }
  }
  if (content.length > 50 && specialTokenChars / content.length > 0.2) {
    return '⚠️ **Unable to process request: context window size exceeded.**\n\nThe model ran out of context space and produced invalid output. Try:\n- Using a shorter prompt\n- Reducing project context size\n- Switching to a model with a larger context window';
  }

  // Check for degenerate repetition — same 10+ char substring repeated 5+ times
  if (content.length > 100) {
    const chunk = content.slice(0, 200);
    for (let len = 10; len <= 50; len++) {
      const pattern = chunk.slice(0, len);
      if (!pattern.trim()) continue;
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');
      const matches = content.match(regex);
      if (matches && matches.length >= 5) {
        return '⚠️ **Unable to process request: model produced repetitive output.**\n\nThe model entered a degenerate loop. This typically happens when:\n- The context window is full\n- The model is too small for the task complexity\n- Insufficient memory available\n\nTry using a larger model or reducing the prompt size.';
      }
    }
  }

  return null;
}

export class LLMClient {
  private config: LLMConfig;
  private _activeRequest: any = null;
  /** Shared HTTP agents for connection pooling (keep-alive) */
  static _httpAgent: any = null;
  static _httpsAgent: any = null;
  private _aborted: boolean = false;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  async chat(messages: LLMMessage[], options?: { temperature?: number; maxTokens?: number; tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> }): Promise<LLMResponse> {
    // ─── Professional Mode pre-flight ─────────────────────────────────
    // Per Requirement 11.6, the auth-token check MUST happen BEFORE any header
    // construction or HTTP call so that no `X-Provider` / `X-Model` headers can
    // leak onto a network when the token is missing.
    const proxyMode = isProxyEnabled(this.config);
    if (proxyMode) {
      const token = this.config.professionalMode?.authToken;
      if (!token || token === '') {
        throw new Error('Professional mode is enabled but no proxy auth token is configured');
      }
    }

    // ─── Headroom prompt compression (Slice 1, flag-gated) ──────────────
    // Routes user/tool/assistant messages through the local Headroom proxy
    // for token-saving compression. System messages are protected upstream
    // (see headroom-compressor.isCompressibleMessage). When the flag is OFF
    // / the proxy is missing / the SDK errors, this returns the original
    // messages unchanged — no behavior change.
    const headroomResult = await maybeCompressMessages(messages as any, { model: this.config.model });
    if (headroomResult.compressed) {
      messages = headroomResult.messages as LLMMessage[];
      console.log(
        '[Headroom] chat() compressed:',
        headroomResult.tokensBefore, '→', headroomResult.tokensAfter,
        'tokens (saved', headroomResult.tokensBefore - headroomResult.tokensAfter,
        'in', headroomResult.durationMs, 'ms)',
      );
    }

    // ─── Prompt Cache Discipline (Requirement 18) ───────────────────────
    // When enabled, reorders messages to enforce stable prefix ordering
    // (system messages with sorted keys, no timestamps), and adds Anthropic
    // cache_control breakpoints. Volatile content stays in suffix only.
    if (this.config.promptCacheDiscipline) {
      messages = applyPromptCacheDiscipline(messages, this.config.provider) as LLMMessage[];
    }

    const baseUrl = proxyMode
      ? this.config.professionalMode!.endpoint
      : (this.config.baseUrl || PROVIDER_URLS[this.config.provider] || PROVIDER_URLS.openai);
    const url = baseUrl + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (proxyMode) {
      // Proxy mode: a single bearer + routing headers. No provider-specific
      // auth headers (x-api-key, anthropic-version, x-goog-api-key).
      headers['Authorization'] = 'Bearer ' + this.config.professionalMode!.authToken;
      headers['X-Provider'] = this.config.provider;
      headers['X-Model'] = this.config.model;
    } else {
      // Direct-provider mode: existing per-provider auth headers.
      if (this.config.apiKey) {
        headers['Authorization'] = 'Bearer ' + this.config.apiKey;
      }

      // Anthropic uses a different header
      if (this.config.provider === 'anthropic') {
        headers['x-api-key'] = this.config.apiKey || '';
        headers['anthropic-version'] = '2023-06-01';
      }
    }

    // Some models (o1, o3) need max_completion_tokens instead of max_tokens
    const modelName = this.config.model.toLowerCase();
    const needsCompletionTokens = modelName.startsWith('o1') || modelName.startsWith('o3') || modelName.includes('o1-') || modelName.includes('o3-');
    
    // Cap max_tokens to avoid exceeding model context windows.
    // Models with 8k context fail when prompt_tokens + max_tokens > 8192.
    // Agent prompts can be 4000+ tokens, so we need a dynamic cap.
    // Estimate prompt tokens: ~4 chars per token is a rough heuristic.
    const promptChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedPromptTokens = Math.ceil(promptChars / 3.2); // conservative: 3.2 chars/token for safety
    
    // Determine model context limit
    // Ollama/local models often have 8k or less — detect by provider or default conservatively
    const isLocalModel = this.config.provider === 'ollama' || this.config.provider === 'llamacpp' || this.config.provider === 'openmythos' ||
      !!(this.config.baseUrl && (this.config.baseUrl.includes('localhost') || this.config.baseUrl.includes('127.0.0.1')));
    
    const contextLimit = getContextLimit(modelName, isLocalModel);
    
    const requestedMaxTokens = options?.maxTokens ?? 2048;
    // Reserve space for prompt + 300 tokens headroom for safety
    const availableForCompletion = Math.max(256, contextLimit - estimatedPromptTokens - 300);
    const safeMaxTokens = Math.min(requestedMaxTokens, availableForCompletion);
    
    if (safeMaxTokens < requestedMaxTokens) {
      console.log(`[LLMClient] Context budget: model=${this.config.model} contextLimit=${contextLimit} promptTokens≈${estimatedPromptTokens} maxTokens capped ${requestedMaxTokens}→${safeMaxTokens}`);
    }
    
    const bodyObj: any = {
      model: this.config.model,
      messages: messages,
      stream: false,
    };
    if (needsCompletionTokens) {
      bodyObj.max_completion_tokens = safeMaxTokens;
    } else {
      bodyObj.temperature = options?.temperature ?? 0.7;
      bodyObj.max_tokens = safeMaxTokens;
    }
    // Add stop sequences for local models to prevent special token leakage
    if (isLocalModel) {
      bodyObj.stop = LOCAL_MODEL_STOP_SEQUENCES;
    }
    // Add tools for function calling if provided
    if (options?.tools && options.tools.length > 0) {
      bodyObj.tools = options.tools;
    }
    const body = JSON.stringify(bodyObj);

    const https = require('node:https');
    const http = require('node:http');
    const urlMod = new URL(url);
    const mod = urlMod.protocol === 'https:' ? https : http;

    // Local LLMs (Ollama, llama.cpp, OpenMythos) need much longer timeouts than cloud APIs
    const isLocalProvider = this.config.provider === 'ollama' || this.config.provider === 'llamacpp' || this.config.provider === 'openmythos' ||
      !!(this.config.baseUrl && (this.config.baseUrl.includes('localhost') || this.config.baseUrl.includes('127.0.0.1')));
    const socketTimeout = isLocalProvider ? 600000 : 120000; // 10 min local, 2 min cloud

    // Reuse HTTP connections (keep-alive) to avoid TCP+TLS handshake per request
    if (!LLMClient._httpAgent) {
      LLMClient._httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });
      LLMClient._httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });
    }
    const httpAgent = urlMod.protocol === 'https:' ? LLMClient._httpsAgent : LLMClient._httpAgent;

    // Retry logic for transient errors
    const maxRetries = isLocalProvider ? 2 : 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[LLMClient] Attempt ${attempt}/${maxRetries} - ${this.config.provider}/${this.config.model} to ${url} (timeout: ${socketTimeout / 1000}s)`);
        
        const result = await new Promise<LLMResponse>((resolve, reject) => {
          const req = mod.request(url, {
            method: 'POST',
            headers: headers,
            timeout: socketTimeout,
            agent: httpAgent,
          }, (res: any) => {
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);

                // ─── Proxy-specific status handling ─────────────────────
                // 402 → typed InsufficientCreditsError so renderer can show a
                // top-up prompt rather than a generic error envelope.
                if (res.statusCode === 402) {
                  const balance = typeof parsed?.balance === 'number' ? parsed.balance : undefined;
                  const message = (parsed?.error && (parsed.error.message || (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)))) || 'insufficient_credits';
                  console.error(`[LLMClient] Proxy 402 insufficient credits${balance != null ? ` (balance=${balance})` : ''}`);
                  reject(new InsufficientCreditsError(message, balance));
                  return;
                }
                // 429 → preserve any Retry-After hint in the thrown message so
                // downstream UI can surface it identically across modes.
                if (res.statusCode === 429) {
                  const retryAfter = res.headers?.['retry-after'];
                  const baseMsg = (parsed?.error?.message || (typeof parsed?.error === 'string' ? parsed.error : JSON.stringify(parsed?.error)) || 'rate_limited');
                  const errorMsg = retryAfter ? `${baseMsg} (retry after ${retryAfter}s)` : String(baseMsg);
                  console.error(`[LLMClient] HTTP 429 rate limited${retryAfter ? ` retry-after=${retryAfter}` : ''}`);
                  reject(new Error(errorMsg));
                  return;
                }

                if (parsed.error) {
                  const errorMsg = parsed.error.message || (typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error));
                  console.error(`[LLMClient] API Error (${res.statusCode}):`, errorMsg);
                  reject(new Error(errorMsg));
                  return;
                }
                const content = parsed.choices?.[0]?.message?.content || '';
                const reasoning = parsed.choices?.[0]?.message?.reasoning_content || undefined;
                const toolCalls = parsed.choices?.[0]?.message?.tool_calls || undefined;
                const tokens = parsed.usage?.total_tokens || 0;
                const promptTokens = parsed.usage?.prompt_tokens || undefined;
                const completionTokens = parsed.usage?.completion_tokens || undefined;

                // Sanitize output — strip special tokens that local models may leak
                const sanitizedContent = sanitizeModelOutput(content).trim();

                // Detect garbage output (context overflow, degenerate loops)
                const garbageError = detectGarbageOutput(content);
                if (garbageError) {
                  console.error('[LLMClient] Garbage output detected from', this.config.provider + '/' + this.config.model);
                  resolve({ content: garbageError, reasoning, tokensUsed: tokens, promptTokens, completionTokens });
                  return;
                }

                console.log(`[LLMClient] Success - ${sanitizedContent.length} chars, ${tokens} tokens${reasoning ? ', reasoning: ' + reasoning.length + ' chars' : ''}${toolCalls ? ', tool_calls: ' + toolCalls.length : ''}`);
                const llmResult: LLMResponse = { content: sanitizedContent, reasoning, tokensUsed: tokens, promptTokens, completionTokens };
                if (toolCalls && toolCalls.length > 0) {
                  llmResult.tool_calls = toolCalls;
                }

                // ─── Cache metrics logging (Requirement 18.4) ─────────────
                if (this.config.promptCacheDiscipline && parsed.usage) {
                  this._logCacheMetrics(parsed);
                }

                resolve(llmResult);
              } catch (e) {
                console.error('[LLMClient] Parse error:', e, 'Response:', data.slice(0, 200));
                reject(new Error('Failed to parse LLM response: ' + data.slice(0, 200)));
              }
            });
          });

          req.on('error', (e: any) => {
            console.error(`[LLMClient] Request error (attempt ${attempt}):`, e.message);
            reject(new Error('LLM request failed: ' + e.message));
          });

          req.on('timeout', () => {
            console.error(`[LLMClient] Request timeout after ${socketTimeout / 1000}s (attempt ${attempt}, provider: ${this.config.provider})`);
            req.destroy();
            reject(new Error(`Request timed out after ${socketTimeout / 1000}s`));
          });

          // Handle socket hang up specifically
          req.on('close', () => {
            if (!req.destroyed) {
              console.error(`[LLMClient] Connection closed unexpectedly (attempt ${attempt})`);
            }
          });

          // Store request for abort
          this._activeRequest = req;
          req.write(body);
          req.end();
        });

        // Success - return result
        return result;

      } catch (error: any) {
        lastError = error;
        const isRetryableError = error.message.includes('socket hang up') || 
                                error.message.includes('ECONNRESET') ||
                                error.message.includes('ENOTFOUND') ||
                                error.message.includes('ETIMEDOUT') ||
                                error.message.includes('timed out') ||
                                error.message.includes('Connection closed');

        console.error(`[LLMClient] Attempt ${attempt} failed:`, error.message);

        if (this._aborted) {
          console.log(`[LLMClient] Request was aborted, stopping retries`);
          throw new Error('Request aborted');
        }

        if (attempt < maxRetries && isRetryableError) {
          const baseDelay = isLocalProvider ? 3000 : 1000;
          const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), isLocalProvider ? 15000 : 5000);
          console.log(`[LLMClient] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable error or max retries reached
        break;
      }
    }

    // All retries failed
    const errorMsg = lastError?.message || 'Unknown error';
    console.error(`[LLMClient] All ${maxRetries} attempts failed. Last error:`, errorMsg);
    
    // Provide more specific error messages based on the error type
    if (errorMsg.includes('socket hang up')) {
      throw new Error(`socket hang up - The ${this.config.provider} server closed the connection unexpectedly. This may be due to network issues, rate limiting, or server problems. Please try again in a moment.`);
    } else if (errorMsg.includes('ENOTFOUND')) {
      throw new Error(`ENOTFOUND - Cannot reach ${this.config.provider} server. Please check your internet connection and provider configuration.`);
    } else if (errorMsg.includes('ETIMEDOUT') || errorMsg.includes('timed out')) {
      throw new Error(`Request timed out - The ${this.config.provider} server took too long to respond. This may be due to high server load or network issues.`);
    } else if (errorMsg.includes('ECONNRESET')) {
      throw new Error(`Connection reset - The ${this.config.provider} server forcibly closed the connection. This may be due to rate limiting or authentication issues.`);
    } else {
      throw lastError || new Error('LLM request failed after ' + maxRetries + ' attempts');
    }
  }

  /** Stream a chat completion, forwarding tokens via callbacks as they arrive. */
  async chatStream(
    messages: LLMMessage[],
    callbacks: StreamCallbacks,
    options?: ChatStreamOptions
  ): Promise<void> {
    // ─── Professional Mode pre-flight ─────────────────────────────────
    // Per Requirement 11.6, the auth-token check MUST happen BEFORE any header
    // construction or HTTP call.
    const proxyMode = isProxyEnabled(this.config);
    if (proxyMode) {
      const token = this.config.professionalMode?.authToken;
      if (!token || token === '') {
        throw new Error('Professional mode is enabled but no proxy auth token is configured');
      }
    }

    // ─── Headroom prompt compression (Slice 1, flag-gated) ──────────────
    // Same gating as chat(): flag check + size gate + system protection.
    // Compression cost is paid before the stream opens, so first-token
    // latency takes a small hit (typically <50ms when the proxy is local)
    // but total tokens emitted by the upstream provider drop substantially
    // when the input is large.
    const headroomResult = await maybeCompressMessages(messages as any, { model: this.config.model });
    if (headroomResult.compressed) {
      messages = headroomResult.messages as LLMMessage[];
      console.log(
        '[Headroom] chatStream() compressed:',
        headroomResult.tokensBefore, '→', headroomResult.tokensAfter,
        'tokens (saved', headroomResult.tokensBefore - headroomResult.tokensAfter,
        'in', headroomResult.durationMs, 'ms)',
      );
    }

    // ─── Prompt Cache Discipline (Requirement 18) ───────────────────────
    // Same as chat(): enforce stable prefix ordering and add Anthropic cache breakpoints.
    if (this.config.promptCacheDiscipline) {
      messages = applyPromptCacheDiscipline(messages, this.config.provider) as LLMMessage[];
    }

    const baseUrl = proxyMode
      ? this.config.professionalMode!.endpoint
      : (this.config.baseUrl || PROVIDER_URLS[this.config.provider] || PROVIDER_URLS.openai);

    // Reuse the same safeMaxTokens calculation from chat()
    const modelName = this.config.model.toLowerCase();
    const needsCompletionTokens = modelName.startsWith('o1') || modelName.startsWith('o3') || modelName.includes('o1-') || modelName.includes('o3-');
    const promptChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedPromptTokens = Math.ceil(promptChars / 3.2);
    const isLocalModel = this.config.provider === 'ollama' || this.config.provider === 'llamacpp' || this.config.provider === 'openmythos' ||
      !!(this.config.baseUrl && (this.config.baseUrl.includes('localhost') || this.config.baseUrl.includes('127.0.0.1')));
    const contextLimit = getContextLimit(modelName, isLocalModel);
    const requestedMaxTokens = options?.maxTokens ?? 2048;
    const availableForCompletion = Math.max(256, contextLimit - estimatedPromptTokens - 300);
    const safeMaxTokens = Math.min(requestedMaxTokens, availableForCompletion);

    // ─── Body construction (identical for both modes per Requirement 13.1) ───
    const bodyObj: Record<string, any> = {
      model: this.config.model,
      messages,
      stream: true as const,
      stream_options: { include_usage: true },
    };
    if (needsCompletionTokens) {
      bodyObj.max_completion_tokens = safeMaxTokens;
    } else {
      bodyObj.temperature = options?.temperature ?? 0.7;
      bodyObj.max_tokens = safeMaxTokens;
    }

    // Pass n_loops for OpenMythos reasoning depth
    if (options?.nLoops != null && this.config.provider === 'openmythos') {
      bodyObj.n_loops = clampNLoops(options.nLoops);
    }

    // Add stop sequences for local models to prevent special token leakage
    if (isLocalModel) {
      bodyObj.stop = LOCAL_MODEL_STOP_SEQUENCES;
    }

    if (proxyMode) {
      // ─── Proxy-mode streaming via raw fetch ─────────────────────────
      // The OpenAI SDK constructor does not let us attach arbitrary `X-Provider`
      // / `X-Model` headers per request, so in proxy mode we use `fetch`
      // directly against `${endpoint}/chat/completions` and parse the SSE
      // stream ourselves. The body and SSE wire format are identical to what
      // the SDK would produce.
      await this._chatStreamProxy(this.config.professionalMode!.endpoint, bodyObj, callbacks);
      return;
    }

    // ─── Direct-provider streaming via OpenAI SDK ───────────────────────
    const defaultHeaders: Record<string, string> = {};
    if (this.config.provider === 'anthropic') {
      defaultHeaders['x-api-key'] = this.config.apiKey || '';
      defaultHeaders['anthropic-version'] = '2023-06-01';
    }

    const client = new OpenAI({
      apiKey: this.config.apiKey || '',
      baseURL: baseUrl,
      defaultHeaders: Object.keys(defaultHeaders).length > 0 ? defaultHeaders : undefined,
    });

    let partialContent = '';
    let stream: ReturnType<typeof client.chat.completions.create> extends Promise<infer T> ? T : any;

    try {
      stream = await client.chat.completions.create(bodyObj as any);

      // Store the stream controller so abort() can destroy it
      this._activeRequest = stream;

      let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

      for await (const chunk of stream as unknown as AsyncIterable<any>) {
        if (this._aborted) {
          try { (stream as any).controller?.abort(); } catch {}
          callbacks.onError({ message: 'Request aborted', partialContent });
          return;
        }

        const token = chunk.choices?.[0]?.delta?.content;
        if (token) {
          // Strip special tokens from streaming chunks
          const cleanToken = sanitizeModelOutput(token);
          if (cleanToken.length > 0) {
            partialContent += cleanToken;
            callbacks.onToken({ content: cleanToken });
          }

          // Periodically check for garbage accumulation (every 500 chars)
          if (partialContent.length > 500 && partialContent.length % 500 < 50) {
            const garbageError = detectGarbageOutput(partialContent);
            if (garbageError) {
              console.error('[LLMClient] Garbage detected during streaming from', this.config.provider + '/' + this.config.model);
              try { (stream as any).controller?.abort(); } catch {}
              callbacks.onError({ message: garbageError, partialContent: '' });
              return;
            }
          }
        }

        // Capture usage from the final chunk (OpenAI sends it on the last chunk when stream_options.include_usage is true)
        if (chunk.usage) {
          lastUsage = chunk.usage;
        }
      }

      // Final garbage check on complete output
      const finalGarbageError = detectGarbageOutput(partialContent);
      if (finalGarbageError) {
        console.error('[LLMClient] Garbage detected in final streaming output from', this.config.provider + '/' + this.config.model);
        callbacks.onError({ message: finalGarbageError, partialContent: '' });
        return;
      }

      callbacks.onDone({
        tokensUsed: lastUsage?.total_tokens,
        promptTokens: lastUsage?.prompt_tokens,
        completionTokens: lastUsage?.completion_tokens,
      });

      // ─── Cache metrics logging for streaming (Requirement 18.4) ─────
      if (this.config.promptCacheDiscipline && lastUsage) {
        this._logCacheMetrics({ usage: lastUsage });
      }
    } catch (err: any) {
      callbacks.onError({ message: err?.message || String(err), partialContent });
    } finally {
      this._activeRequest = null;
    }
  }

  /**
   * Streaming via raw fetch for Professional Mode (proxy) routing. Posts the
   * unmodified body to `${endpoint}/chat/completions` with the proxy auth +
   * routing headers, then parses the OpenAI-compatible SSE response into
   * `StreamCallbacks`.
   */
  private async _chatStreamProxy(
    endpoint: string,
    bodyObj: Record<string, any>,
    callbacks: StreamCallbacks,
  ): Promise<void> {
    const url = endpoint + '/chat/completions';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Authorization': 'Bearer ' + this.config.professionalMode!.authToken,
      'X-Provider': this.config.provider,
      'X-Model': this.config.model,
    };

    const controller = new AbortController();
    this._activeRequest = { controller };

    let partialContent = '';
    let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Read whatever body the proxy returned and translate to a typed
        // error (402 → InsufficientCreditsError, others → generic Error).
        const text = await res.text().catch(() => '');
        let parsed: any = undefined;
        try { parsed = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
        const errorMsg = parsed?.error?.message
          || (typeof parsed?.error === 'string' ? parsed.error : undefined)
          || (parsed ? JSON.stringify(parsed) : (text || `HTTP ${res.status}`));

        if (res.status === 402) {
          const balance = typeof parsed?.balance === 'number' ? parsed.balance : undefined;
          throw new InsufficientCreditsError(errorMsg, balance);
        }
        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after');
          throw new Error(retryAfter ? `${errorMsg} (retry after ${retryAfter}s)` : errorMsg);
        }
        throw new Error(errorMsg);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error('Proxy stream returned no body');
      }
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        if (this._aborted) {
          try { controller.abort(); } catch {}
          callbacks.onError({ message: 'Request aborted', partialContent });
          return;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE: events are separated by blank lines; each event may have
        // multiple `data:` lines. We forward concatenated `data:` payloads.
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1 || (sepIndex = buffer.indexOf('\r\n\r\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIndex);
          // Advance past the separator we matched (handle both \n\n and \r\n\r\n)
          const sepLen = buffer.startsWith('\r\n\r\n', sepIndex) ? 4 : 2;
          buffer = buffer.slice(sepIndex + sepLen);

          // Combine all `data:` lines from this event.
          const dataLines: string[] = [];
          for (const line of rawEvent.split(/\r?\n/)) {
            const trimmed = line.replace(/^\s*/, '');
            if (trimmed.startsWith('data:')) {
              dataLines.push(trimmed.slice(5).replace(/^\s/, ''));
            }
          }
          if (dataLines.length === 0) continue;
          const data = dataLines.join('\n');
          if (data === '[DONE]') {
            // OpenAI-style sentinel; usage (if any) was on the previous chunk.
            continue;
          }

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            // Tolerate non-JSON keep-alives.
            continue;
          }

          // Proxy may send an inline error event mid-stream (per design).
          if (chunk?.error) {
            const message = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message || JSON.stringify(chunk.error));
            callbacks.onError({ message, partialContent });
            return;
          }

          const token = chunk.choices?.[0]?.delta?.content;
          if (token) {
            const cleanToken = sanitizeModelOutput(token);
            if (cleanToken.length > 0) {
              partialContent += cleanToken;
              callbacks.onToken({ content: cleanToken });
            }

            if (partialContent.length > 500 && partialContent.length % 500 < 50) {
              const garbageError = detectGarbageOutput(partialContent);
              if (garbageError) {
                console.error('[LLMClient] Garbage detected during proxy streaming from', this.config.provider + '/' + this.config.model);
                try { controller.abort(); } catch {}
                callbacks.onError({ message: garbageError, partialContent: '' });
                return;
              }
            }
          }

          if (chunk.usage) {
            lastUsage = chunk.usage;
          }
        }
      }

      // Flush any trailing partial event held in the buffer (best-effort).
      if (buffer.trim().length > 0) {
        for (const line of buffer.split(/\r?\n/)) {
          const trimmed = line.replace(/^\s*/, '');
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).replace(/^\s/, '');
          if (!data || data === '[DONE]') continue;
          try {
            const chunk = JSON.parse(data);
            if (chunk?.usage) lastUsage = chunk.usage;
          } catch { /* ignore */ }
        }
      }

      const finalGarbageError = detectGarbageOutput(partialContent);
      if (finalGarbageError) {
        console.error('[LLMClient] Garbage detected in final proxy streaming output from', this.config.provider + '/' + this.config.model);
        callbacks.onError({ message: finalGarbageError, partialContent: '' });
        return;
      }

      callbacks.onDone({
        tokensUsed: lastUsage?.total_tokens,
        promptTokens: lastUsage?.prompt_tokens,
        completionTokens: lastUsage?.completion_tokens,
      });

      // ─── Cache metrics logging for proxy streaming (Requirement 18.4) ─
      if (this.config.promptCacheDiscipline && lastUsage) {
        this._logCacheMetrics({ usage: lastUsage });
      }
    } catch (err: any) {
      // Preserve typed errors (InsufficientCreditsError) for caller pattern matching.
      if (err instanceof InsufficientCreditsError) {
        throw err;
      }
      callbacks.onError({ message: err?.message || String(err), partialContent });
    } finally {
      this._activeRequest = null;
    }
  }

  /** Abort any in-flight HTTP request or stream */
  abort(): void {
    this._aborted = true;
    if (this._activeRequest) {
      try { this._activeRequest.destroy?.(); } catch {}
      try { this._activeRequest.controller?.abort?.(); } catch {}
      this._activeRequest = null;
    }
  }

  reset(): void {
    this._aborted = false;
    this._activeRequest = null;
  }

  /**
   * Log cache metrics from a provider response.
   * Extracts cache-hit information from Anthropic or OpenAI usage fields
   * and records them in the configured cache metrics store.
   *
   * Requirements: 18.4
   */
  private _logCacheMetrics(parsed: Record<string, any>): void {
    if (!this.config.cacheMetricsStore) {
      // No store configured — just log to console for observability
      const usage = parsed?.usage;
      if (!usage) return;

      const cacheRead = usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheCreate = usage.cache_creation_input_tokens ?? 0;
      if (cacheRead > 0 || cacheCreate > 0) {
        const total = usage.prompt_tokens ?? usage.input_tokens ?? 0;
        const ratio = total > 0 ? (cacheRead / total * 100).toFixed(1) : '0.0';
        console.log(
          `[PromptCacheDiscipline] Cache hit: read=${cacheRead} create=${cacheCreate} total=${total} ratio=${ratio}%`,
        );
      }
      return;
    }

    // Use the full metrics extraction and logging pipeline
    if (isAnthropicProvider(this.config.provider)) {
      const metrics = extractCacheMetrics(parsed);
      if (metrics) {
        this.config.cacheMetricsStore.recordCacheMetrics({
          provider: this.config.provider,
          model: this.config.model,
          cacheCreationTokens: metrics.cacheCreationInputTokens,
          cacheReadTokens: metrics.cacheReadInputTokens,
          totalInputTokens: metrics.totalInputTokens,
          cacheSavingsTokens: metrics.cacheSavingsTokens,
          cacheHitRatio: metrics.cacheHitRatio,
          sessionId: this.config.sessionId,
        });
      }
    } else {
      const metrics = extractOpenAICacheMetrics(parsed);
      if (metrics) {
        this.config.cacheMetricsStore.recordCacheMetrics({
          provider: this.config.provider,
          model: this.config.model,
          cacheCreationTokens: metrics.cacheCreationInputTokens,
          cacheReadTokens: metrics.cacheReadInputTokens,
          totalInputTokens: metrics.totalInputTokens,
          cacheSavingsTokens: metrics.cacheSavingsTokens,
          cacheHitRatio: metrics.cacheHitRatio,
          sessionId: this.config.sessionId,
        });
      }
    }
  }

  /** Test connection to the provider without making a full chat request */
  async testConnection(): Promise<{ success: boolean; message: string; latency?: number }> {
    const startTime = Date.now();
    
    try {
      // For local providers, test the base endpoint
      if (this.config.provider === 'ollama' || this.config.provider === 'llamacpp' || this.config.provider === 'openmythos') {
        const baseUrl = this.config.baseUrl || PROVIDER_URLS[this.config.provider];
        // Strip /v1 suffix for health/tags endpoints (they're at the root)
        const rootUrl = baseUrl.replace(/\/v1\/?$/, '');
        const testUrl = this.config.provider === 'ollama'
          ? rootUrl + '/api/tags'
          : this.config.provider === 'openmythos'
            ? rootUrl + '/health'
            : rootUrl + '/v1/models';
        
        const http = require('node:http');
        const https = require('node:https');
        const mod = testUrl.startsWith('https') ? https : http;
        
        return new Promise((resolve) => {
          const req = mod.get(testUrl, { timeout: 10000 }, (res: any) => {
            const latency = Date.now() - startTime;
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, message: `Connected successfully (${latency}ms)`, latency });
            } else {
              resolve({ success: false, message: `Server returned HTTP ${res.statusCode}` });
            }
          });
          req.on('error', (e: any) => {
            resolve({ success: false, message: `Connection failed: ${e.message}` });
          });
          req.on('timeout', () => {
            req.destroy();
            resolve({ success: false, message: 'Connection timed out' });
          });
        });
      }

      // For remote providers, make a simple models list request
      const baseUrl = this.config.baseUrl || PROVIDER_URLS[this.config.provider] || PROVIDER_URLS.openai;
      const url = baseUrl + '/models';
      const headers: Record<string, string> = {};

      if (this.config.apiKey) {
        if (this.config.provider === 'anthropic') {
          headers['x-api-key'] = this.config.apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['Authorization'] = 'Bearer ' + this.config.apiKey;
        }
      }

      const https = require('node:https');
      const http = require('node:http');
      const urlMod = new URL(url);
      const mod = urlMod.protocol === 'https:' ? https : http;

      return new Promise((resolve) => {
        const req = mod.get(url, { headers, timeout: 10000 }, (res: any) => {
          const latency = Date.now() - startTime;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, message: `API key verified (${latency}ms)`, latency });
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ success: false, message: `Invalid API key (HTTP ${res.statusCode})` });
          } else {
            resolve({ success: false, message: `API returned HTTP ${res.statusCode}` });
          }
        });
        req.on('error', (e: any) => {
          resolve({ success: false, message: `Connection failed: ${e.message}` });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, message: 'Connection timed out' });
        });
      });

    } catch (error: any) {
      return { success: false, message: `Test failed: ${error.message}` };
    }
  }
}

/**
 * Create an LLM client from saved provider config.
 *
 * The optional `proxyConfig` parameter wires up Professional Mode routing.
 * When provided, non-local providers receive the proxy config verbatim and
 * route requests through the LLM proxy. Local providers (`ollama`,
 * `llamacpp`, `openmythos`) are always given `{ ...proxyConfig, enabled: false }`
 * so they bypass the proxy regardless of the global toggle (Requirement 2.7).
 *
 * The optional `cacheConfig` parameter enables Prompt Cache Discipline
 * (Requirement 18). When provided and `enabled` is true, the client enforces
 * canonical prompt ordering and adds Anthropic cache_control breakpoints.
 *
 * Callers that don't yet wire Professional Mode (or that wish to keep direct
 * mode) simply omit `proxyConfig` — existing behavior is preserved.
 */
export function createLLMClient(
  providerConfig: any,
  proxyConfig?: ProxyConfig,
  cacheConfig?: { enabled: boolean; store?: CacheMetricsStore; sessionId?: string },
): LLMClient | null {
  if (!providerConfig) return null;

  // Determine the provider type — prefer .type, then extract from .id or .name
  const providerType = providerConfig.type
    || providerConfig.id?.split('-')[0]
    || providerConfig.name?.toLowerCase().split(' ')[0]
    || 'openai';

  // Get model — check multiple fields, fall back to provider defaults
  let model = '';
  if (providerConfig.model) {
    model = providerConfig.model.split(',')[0].trim();
  } else if (providerConfig.defaultModel) {
    model = providerConfig.defaultModel.split(',')[0].trim();
  }

  // If still no model, use sensible defaults per provider
  if (!model) {
    const defaultModels: Record<string, string> = {
      openai: 'gpt-4o',
      anthropic: 'claude-sonnet-4-20250514',
      deepseek: 'deepseek-chat',
      gemini: 'gemini-2.0-flash',
      grok: 'grok-3-mini',
      groq: 'llama-3.3-70b-versatile',
      mistral: 'mistral-large-latest',
      ollama: 'llama3.2:latest',
      llamacpp: 'default',
      openmythos: 'mythos_3b'
    };
    model = defaultModels[providerType] || 'gpt-4o';
  }

  // Handle baseUrl — don't double-append /v1
  let baseUrl = providerConfig.baseUrl || undefined;
  if (baseUrl && !baseUrl.endsWith('/v1') && !baseUrl.includes('/v1/') && !baseUrl.includes('/v1beta')) {
    baseUrl = baseUrl.replace(/\/+$/, '') + '/v1';
  }

  // ─── Professional Mode wiring ────────────────────────────────────
  // Local providers (ollama / llamacpp / openmythos) ALWAYS bypass the proxy
  // regardless of the global toggle (Requirement 2.7). Use the provider catalog
  // as the source of truth for `isLocal`, falling back to the hardcoded set
  // for provider types not in the catalog.
  let professionalMode: ProxyConfig | undefined;
  if (proxyConfig) {
    const catalogEntry = getProviderCatalogEntry(providerType);
    const isLocal = catalogEntry?.isLocal ?? LOCAL_PROVIDER_TYPES.has(providerType);
    professionalMode = isLocal
      ? { ...proxyConfig, enabled: false }
      : proxyConfig;
  }

  const clientConfig: LLMConfig = {
    apiKey: providerConfig.apiKey,
    baseUrl: baseUrl,
    model: model,
    provider: providerType,
  };
  if (professionalMode !== undefined) {
    clientConfig.professionalMode = professionalMode;
  }
  // ─── Prompt Cache Discipline wiring (Requirement 18) ─────────────
  if (cacheConfig?.enabled) {
    clientConfig.promptCacheDiscipline = true;
    if (cacheConfig.store) {
      clientConfig.cacheMetricsStore = cacheConfig.store;
    }
    if (cacheConfig.sessionId) {
      clientConfig.sessionId = cacheConfig.sessionId;
    }
  }
  return new LLMClient(clientConfig);
}
