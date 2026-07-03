/**
 * ErrorFormatter — Formats raw errors into user-friendly messages.
 *
 * Classifies errors by type (network, rate_limit, tool_failure, timeout, unknown),
 * formats them as readable sentences (headline + detail + optional suggestion),
 * and never exposes raw JSON objects or stack traces to the user.
 *
 * Feature-gated via `production_ux_error_quality` — when disabled, falls back
 * to a minimal generic error message.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { AgentErrorEvent } from '../shared/production-ux-types.js';

// ─── Public Interfaces ──────────────────────────────────────────

/** A formatted, user-friendly error message */
export interface FormattedError {
  headline: string;
  detail: string;
  suggestion?: string;
  retryable: boolean;
  retryAfterMs?: number;
}

/** Context about where/when the error occurred */
export interface ErrorContext {
  toolName?: string;
  filePath?: string;
  iteration?: number;
  phase?: string;
}

// ─── Constants ──────────────────────────────────────────────────

/** Network error codes that indicate connectivity issues */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/** Patterns that indicate network errors in error messages */
const NETWORK_ERROR_PATTERNS = [
  /fetch failed/i,
  /network error/i,
  /dns resolution/i,
  /socket hang up/i,
  /connect ECONNREFUSED/i,
  /getaddrinfo/i,
];

/** Patterns matching raw JSON objects (key-value pairs in braces) */
const RAW_JSON_PATTERN = /\{[^}]*"[^"]+"\s*:\s*[^}]+\}/;

/** Patterns matching stack traces (file:line:column) */
const STACK_TRACE_PATTERN = /(?:at\s+.+\(.+:\d+:\d+\))|(?:\/[^\s]+\.\w+:\d+:\d+)/;

/** Timeout error indicators */
const TIMEOUT_PATTERNS = [
  /timeout/i,
  /timed?\s*out/i,
  /deadline exceeded/i,
  /ETIMEDOUT/,
];

// ─── ErrorFormatter Implementation ──────────────────────────────

export class ErrorFormatter {
  private readonly featureGate: FeatureGateSystem;

  constructor(featureGate: FeatureGateSystem) {
    this.featureGate = featureGate;
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Format a raw error into a user-friendly message.
   *
   * When the feature gate is disabled, returns a minimal generic message.
   * When enabled, classifies the error and produces a structured FormattedError
   * with a readable headline, detail, and optional suggestion.
   *
   * Never exposes raw JSON objects or stack traces.
   *
   * Requirements: 9.1, 9.4
   */
  format(error: unknown, context: ErrorContext): FormattedError {
    if (!this.isEnabled()) {
      return {
        headline: 'An error occurred.',
        detail: 'Something went wrong while processing your request.',
        retryable: false,
      };
    }

    const errorType = this.classify(error);
    const errorMessage = this.extractMessage(error);
    const sanitizedMessage = this.sanitize(errorMessage);

    switch (errorType) {
      case 'network':
        return this.formatNetworkError(sanitizedMessage, context);
      case 'rate_limit':
        return this.formatRateLimitError(error, sanitizedMessage, context);
      case 'timeout':
        return this.formatTimeoutError(sanitizedMessage, context);
      case 'tool_failure':
        return this.formatToolFailureError(sanitizedMessage, context);
      default:
        return this.formatUnknownError(sanitizedMessage, context);
    }
  }

  /**
   * Classify an error by type for UI display and routing.
   *
   * Returns one of: 'network', 'rate_limit', 'tool_failure', 'timeout', 'unknown'.
   *
   * Requirements: 9.2, 9.3
   */
  classify(error: unknown): AgentErrorEvent['type'] {
    const message = this.extractMessage(error);
    const code = this.extractErrorCode(error);
    const statusCode = this.extractStatusCode(error);

    // Check for rate limiting (HTTP 429)
    if (statusCode === 429) {
      return 'rate_limit';
    }

    // Check for network errors by code
    if (code && NETWORK_ERROR_CODES.has(code)) {
      return 'network';
    }

    // Check for network errors by message pattern
    if (NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return 'network';
    }

    // Check for timeout errors
    if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(message))) {
      return 'timeout';
    }

    // Check for timeout by code
    if (code === 'ETIMEDOUT' || code === 'TIMEOUT') {
      return 'timeout';
    }

    // Check for tool failures (errors that have a toolName in context or
    // are from tool execution systems)
    if (this.isToolFailure(error, message)) {
      return 'tool_failure';
    }

    return 'unknown';
  }

  /**
   * Get a contextual suggestion for a recognized error type.
   *
   * Returns a human-readable suggestion string or undefined if no
   * suggestion is available for the error type.
   *
   * Requirement: 9.5
   */
  getSuggestion(errorType: string, context: ErrorContext): string | undefined {
    if (!this.isEnabled()) return undefined;

    switch (errorType) {
      case 'network':
        return 'Check your network connection and verify the API key configuration is correct.';

      case 'rate_limit':
        return 'The API rate limit has been reached. The request will be retried automatically after the cooldown period.';

      case 'timeout':
        if (context.toolName) {
          return `The operation "${context.toolName}" took too long to complete. Try breaking the task into smaller steps.`;
        }
        return 'The operation took too long to complete. Try again or break the task into smaller steps.';

      case 'tool_failure':
        if (context.toolName && context.filePath) {
          return `The tool "${context.toolName}" failed while processing "${context.filePath}". Check that the file exists and has the correct permissions.`;
        }
        if (context.toolName) {
          return `The tool "${context.toolName}" encountered an error. The agent will attempt an alternative approach.`;
        }
        return 'A tool execution failed. The agent will attempt an alternative approach.';

      case 'unknown':
        return 'An unexpected error occurred. If the problem persists, try restarting the session.';

      default:
        return undefined;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Check if the feature gate is enabled.
   */
  private isEnabled(): boolean {
    return this.featureGate.isEnabled('production_ux_error_quality');
  }

  /**
   * Extract a string message from an unknown error.
   */
  private extractMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (error !== null && typeof error === 'object') {
      // Try common error-like properties
      const obj = error as Record<string, unknown>;
      if (typeof obj.message === 'string') return obj.message;
      if (typeof obj.error === 'string') return obj.error;
      if (typeof obj.reason === 'string') return obj.reason;
      // Last resort: stringify, but this will be sanitized later
      try {
        return JSON.stringify(error);
      } catch {
        return 'An unexpected error occurred.';
      }
    }
    return 'An unexpected error occurred.';
  }

  /**
   * Extract an error code from an error object (e.g., Node.js system errors).
   */
  private extractErrorCode(error: unknown): string | undefined {
    if (error !== null && typeof error === 'object') {
      const obj = error as Record<string, unknown>;
      if (typeof obj.code === 'string') return obj.code;
    }
    return undefined;
  }

  /**
   * Extract an HTTP status code from an error object.
   */
  private extractStatusCode(error: unknown): number | undefined {
    if (error !== null && typeof error === 'object') {
      const obj = error as Record<string, unknown>;
      if (typeof obj.status === 'number') return obj.status;
      if (typeof obj.statusCode === 'number') return obj.statusCode;
      // Some APIs nest it under response
      if (obj.response && typeof obj.response === 'object') {
        const resp = obj.response as Record<string, unknown>;
        if (typeof resp.status === 'number') return resp.status;
        if (typeof resp.statusCode === 'number') return resp.statusCode;
      }
    }
    return undefined;
  }

  /**
   * Extract retry-after duration from a rate limit error.
   * Returns milliseconds, defaulting to 60000 if not found.
   */
  private extractRetryAfter(error: unknown): number {
    if (error !== null && typeof error === 'object') {
      const obj = error as Record<string, unknown>;
      // Check for retryAfter (ms)
      if (typeof obj.retryAfter === 'number') return obj.retryAfter;
      if (typeof obj.retryAfterMs === 'number') return obj.retryAfterMs;
      // Check for retry-after header (seconds)
      if (typeof obj.retryAfterSeconds === 'number') return obj.retryAfterSeconds * 1000;

      // Check nested headers
      if (obj.headers && typeof obj.headers === 'object') {
        const headers = obj.headers as Record<string, unknown>;
        const retryHeader = headers['retry-after'] ?? headers['Retry-After'];
        if (typeof retryHeader === 'string') {
          const seconds = parseInt(retryHeader, 10);
          if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
        }
        if (typeof retryHeader === 'number') return retryHeader * 1000;
      }

      // Check response.headers
      if (obj.response && typeof obj.response === 'object') {
        const resp = obj.response as Record<string, unknown>;
        if (resp.headers && typeof resp.headers === 'object') {
          const headers = resp.headers as Record<string, unknown>;
          const retryHeader = headers['retry-after'] ?? headers['Retry-After'];
          if (typeof retryHeader === 'string') {
            const seconds = parseInt(retryHeader, 10);
            if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
          }
          if (typeof retryHeader === 'number') return retryHeader * 1000;
        }
      }
    }

    // Default: 60 seconds
    return 60_000;
  }

  /**
   * Determine if an error is a tool failure.
   */
  private isToolFailure(error: unknown, message: string): boolean {
    // Check for tool-related error patterns
    if (/tool (execution|call|invocation) failed/i.test(message)) return true;
    if (/command (failed|exited|returned non-zero)/i.test(message)) return true;
    if (/permission denied/i.test(message)) return true;
    if (/no such file or directory/i.test(message)) return true;
    if (/ENOENT/i.test(message)) return true;
    if (/EACCES/i.test(message)) return true;

    // Check for tool failure markers in the error object
    if (error !== null && typeof error === 'object') {
      const obj = error as Record<string, unknown>;
      if (obj.toolName || obj.tool_name) return true;
      if (obj.type === 'tool_failure') return true;
    }

    return false;
  }

  /**
   * Sanitize a message to remove raw JSON and stack traces.
   *
   * Requirement: 9.4 — Never display raw JSON or stack traces.
   */
  private sanitize(message: string): string {
    let sanitized = message;

    // Remove raw JSON objects
    if (RAW_JSON_PATTERN.test(sanitized)) {
      // Replace JSON objects with a generic description
      sanitized = sanitized.replace(/\{[^}]*"[^"]+"\s*:[^}]*\}/g, '(details omitted)');
    }

    // Remove stack traces
    if (STACK_TRACE_PATTERN.test(sanitized)) {
      // Remove lines that look like stack trace entries
      const lines = sanitized.split('\n');
      const filtered = lines.filter(
        (line) => !/^\s*at\s+.+\(.+:\d+:\d+\)/.test(line) && !/^\s*at\s+.+:\d+:\d+/.test(line),
      );
      sanitized = filtered.join('\n').trim();

      // Remove inline file:line:column references
      sanitized = sanitized.replace(/\s*\/[^\s]+\.\w+:\d+:\d+/g, '');
    }

    // Trim excess whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    // Ensure we have something readable
    if (!sanitized || sanitized === '(details omitted)') {
      sanitized = 'An unexpected error occurred during processing.';
    }

    return sanitized;
  }

  // ─── Error Type Formatters ────────────────────────────────────

  private formatNetworkError(message: string, context: ErrorContext): FormattedError {
    const headline = 'Connection to the AI service failed.';
    const detail = context.phase
      ? `A network error occurred during the "${context.phase}" phase: ${message}`
      : `A network error occurred: ${message}`;

    return {
      headline,
      detail,
      suggestion: this.getSuggestion('network', context),
      retryable: true,
    };
  }

  private formatRateLimitError(
    error: unknown,
    message: string,
    context: ErrorContext,
  ): FormattedError {
    const retryAfterMs = this.extractRetryAfter(error);
    const retrySeconds = Math.ceil(retryAfterMs / 1000);

    const headline = 'API rate limit reached.';
    const detail = `The request was rate-limited. Automatic retry will occur in ${retrySeconds} seconds.`;

    return {
      headline,
      detail,
      suggestion: this.getSuggestion('rate_limit', context),
      retryable: true,
      retryAfterMs,
    };
  }

  private formatTimeoutError(message: string, context: ErrorContext): FormattedError {
    const headline = context.toolName
      ? `Operation "${context.toolName}" timed out.`
      : 'The operation timed out.';
    const detail = context.filePath
      ? `The operation on "${context.filePath}" exceeded the time limit: ${message}`
      : `The operation exceeded the time limit: ${message}`;

    return {
      headline,
      detail,
      suggestion: this.getSuggestion('timeout', context),
      retryable: true,
    };
  }

  private formatToolFailureError(message: string, context: ErrorContext): FormattedError {
    let headline: string;
    if (context.toolName && context.filePath) {
      headline = `Tool "${context.toolName}" failed on "${context.filePath}".`;
    } else if (context.toolName) {
      headline = `Tool "${context.toolName}" encountered an error.`;
    } else {
      headline = 'A tool execution failed.';
    }

    const detail = message;

    return {
      headline,
      detail,
      suggestion: this.getSuggestion('tool_failure', context),
      retryable: false,
    };
  }

  private formatUnknownError(message: string, context: ErrorContext): FormattedError {
    const headline = context.toolName
      ? `An error occurred while running "${context.toolName}".`
      : 'An unexpected error occurred.';
    const detail = message;

    return {
      headline,
      detail,
      suggestion: this.getSuggestion('unknown', context),
      retryable: false,
    };
  }
}
