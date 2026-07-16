/**
 * Token Estimator — unified token counting service with native module support.
 *
 * Provides provider/model-aware token counts through a stable TypeScript contract.
 * Falls back to the existing chars/4 estimator when the native module is unavailable.
 *
 * Resolution order:
 * 1. Native estimator (@neuronest/native-tokenizer) — accurate, model-aware
 * 2. Existing fallback (chars/4) — fast approximation
 * 3. If both fail, result is marked as "estimated"
 *
 * Used by: context-budget, cost controls, prompt preview, UI displays.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5
 */

// ─── Types ──────────────────────────────────────────────────────

export interface TokenEstimate {
  /** Token count */
  count: number;
  /** Whether this is an exact count (native) or approximation (fallback) */
  exact: boolean;
  /** Source of the estimate */
  source: 'native' | 'fallback' | 'estimated';
  /** Model used for native encoding (if applicable) */
  model?: string;
}

export interface TokenEstimatorOptions {
  /** Model identifier for model-aware encoding. Default: 'cl100k_base' */
  model?: string;
  /** Provider name for provider-specific tokenization */
  provider?: string;
}

export interface NativeTokenizerModule {
  /** Count tokens for text with a specific encoding */
  countTokens(text: string, encoding?: string): number;
  /** Check if the module is operational */
  isAvailable(): boolean;
  /** Get supported encodings */
  supportedEncodings(): string[];
}

// ─── Constants ──────────────────────────────────────────────────

const CHARS_PER_TOKEN_FALLBACK = 4;
const DEFAULT_ENCODING = 'cl100k_base';

/** Model → encoding mapping for common providers */
const MODEL_ENCODING_MAP: Record<string, string> = {
  'gpt-4': 'cl100k_base',
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'claude-3': 'cl100k_base',
  'claude-3.5': 'cl100k_base',
  'claude-4': 'cl100k_base',
};

// ─── Native Module Loading ──────────────────────────────────────

let nativeModule: NativeTokenizerModule | null = null;
let nativeLoadAttempted = false;
let nativeLoadError: string | null = null;

/**
 * Attempt to load the native tokenizer module.
 * Returns null if not available (graceful degradation per Req 1.10, 1.11).
 */
function loadNativeModule(): NativeTokenizerModule | null {
  if (nativeLoadAttempted) return nativeModule;
  nativeLoadAttempted = true;

  try {
    // Dynamic require — fails gracefully if native module not built
    const mod = require('@neuronest/native-tokenizer');
    if (mod && typeof mod.countTokens === 'function' && typeof mod.isAvailable === 'function') {
      if (mod.isAvailable()) {
        nativeModule = mod;
        console.log('[TokenEstimator] Native tokenizer loaded successfully');
      } else {
        nativeLoadError = 'Native module loaded but reports unavailable';
        console.warn('[TokenEstimator]', nativeLoadError);
      }
    } else {
      nativeLoadError = 'Native module missing required exports';
      console.warn('[TokenEstimator]', nativeLoadError);
    }
  } catch (err: any) {
    nativeLoadError = err.message || 'Unknown load error';
    // This is expected when native module is not built — not an error
    console.log('[TokenEstimator] Native module not available, using fallback:', nativeLoadError);
  }

  return nativeModule;
}

// ─── Fallback Estimator ─────────────────────────────────────────

/**
 * Fallback token estimation using chars/4 approximation.
 * This is the existing estimator used throughout the codebase.
 */
export function fallbackEstimate(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN_FALLBACK);
}

// ─── Token Estimator Service ────────────────────────────────────

export class TokenEstimator {
  private encoding: string;
  private native: NativeTokenizerModule | null = null;

  constructor(options?: TokenEstimatorOptions) {
    this.encoding = this.resolveEncoding(options?.model, options?.provider);
    this.native = loadNativeModule();
  }

  /**
   * Estimate token count for text.
   * Uses native module when available, falls back to chars/4.
   *
   * Requirement 23.1, 23.2
   */
  estimate(text: string): TokenEstimate {
    if (!text) {
      return { count: 0, exact: true, source: 'native' };
    }

    // Try native first
    if (this.native) {
      try {
        const count = this.native.countTokens(text, this.encoding);
        return { count, exact: true, source: 'native', model: this.encoding };
      } catch {
        // Native failed for this text — fall through to fallback
      }
    }

    // Fallback: chars/4
    const count = fallbackEstimate(text);
    return { count, exact: false, source: 'fallback' };
  }

  /**
   * Quick token count (just the number, no metadata).
   * Convenience method for hot paths.
   */
  count(text: string): number {
    return this.estimate(text).count;
  }

  /**
   * Batch estimate for multiple texts.
   */
  estimateBatch(texts: string[]): TokenEstimate[] {
    return texts.map((t) => this.estimate(t));
  }

  /**
   * Check if the native module is available.
   */
  isNativeAvailable(): boolean {
    return this.native !== null;
  }

  /**
   * Get diagnostic info about the estimator state.
   */
  getDiagnostics(): {
    nativeAvailable: boolean;
    encoding: string;
    loadError: string | null;
  } {
    return {
      nativeAvailable: this.native !== null,
      encoding: this.encoding,
      loadError: nativeLoadError,
    };
  }

  /**
   * Update encoding for a different model.
   */
  setModel(model: string): void {
    this.encoding = this.resolveEncoding(model);
  }

  // ─── Private ────────────────────────────────────────────────────

  private resolveEncoding(model?: string, provider?: string): string {
    if (!model) return DEFAULT_ENCODING;

    // Direct mapping — check longer/more-specific patterns first
    const lower = model.toLowerCase();

    // Check exact keys sorted by length descending to avoid prefix matching issues
    const sortedKeys = Object.keys(MODEL_ENCODING_MAP).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      if (lower.includes(key)) return MODEL_ENCODING_MAP[key]!;
    }

    // Default based on provider
    if (provider === 'openai') return 'cl100k_base';
    if (provider === 'anthropic') return 'cl100k_base';

    return DEFAULT_ENCODING;
  }
}

// ─── Singleton Instance ─────────────────────────────────────────

let defaultInstance: TokenEstimator | null = null;

/**
 * Get the default TokenEstimator instance (singleton).
 * Lazy-initialized on first access.
 */
export function getTokenEstimator(options?: TokenEstimatorOptions): TokenEstimator {
  if (!defaultInstance) {
    defaultInstance = new TokenEstimator(options);
  }
  return defaultInstance;
}

/**
 * Convenience: estimate tokens for text using the default instance.
 * Drop-in replacement for the existing `estimateTokens` function.
 */
export function estimateTokens(text: string): number {
  return getTokenEstimator().count(text);
}

/**
 * Convenience: get full estimate with metadata.
 */
export function estimateTokensFull(text: string, model?: string): TokenEstimate {
  const estimator = getTokenEstimator();
  if (model) estimator.setModel(model);
  return estimator.estimate(text);
}
