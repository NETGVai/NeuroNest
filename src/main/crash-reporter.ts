/**
 * Crash Reporter - Sentry integration for main + renderer processes.
 *
 * Provides:
 * - Breadcrumb collection (user actions, IPC calls, state transitions)
 * - PII scrubbing (user file paths, secrets) from reports
 * - Version, OS, Electron version, and architecture metadata
 * - User opt-out with complete transmission blocking
 * - Local-only exception capture when opted out
 * - Transmission blocking for technical reasons (network, server rejection)
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5, 21.6
 */

import * as os from 'node:os';
import * as path from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CrashReporterConfig {
  dsn: string;
  enabled: boolean;
  environment: string;
  release: string;
  scrubPaths: boolean;
}

export interface Breadcrumb {
  timestamp: number;
  category: 'ipc' | 'navigation' | 'state' | 'user-action';
  message: string;
  data?: Record<string, unknown>;
}

export interface LocalCapture {
  timestamp: string;
  error: string;
  stack?: string;
  breadcrumbs: Breadcrumb[];
  metadata: Record<string, string>;
}

export interface CrashReporterStatus {
  initialized: boolean;
  enabled: boolean;
  transmissionBlocked: boolean;
  blockReason?: string;
  localCaptureCount: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BREADCRUMBS = 50;
const HOME_DIR = os.homedir();

/**
 * Patterns that indicate sensitive information in strings.
 * Used to scrub secrets from error reports.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI API keys
  /xox[bpras]-[a-zA-Z0-9-]+/g,      // Slack tokens
  /ghp_[a-zA-Z0-9]{36,}/g,          // GitHub personal access tokens
  /gho_[a-zA-Z0-9]{36,}/g,          // GitHub OAuth tokens
  /Bearer\s+[a-zA-Z0-9._~+/=-]+/gi, // Bearer tokens
  /[a-f0-9]{64}/g,                   // Generic 64-char hex secrets
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/g, // Private keys
];

// ─── CrashReporter Class ────────────────────────────────────────────────────

export class CrashReporter {
  private config: CrashReporterConfig;
  private breadcrumbs: Breadcrumb[] = [];
  private localCaptures: LocalCapture[] = [];
  private initialized = false;
  private transmissionBlocked = false;
  private blockReason?: string;
  private sentryClient: SentryClientAdapter | null = null;

  constructor(config: CrashReporterConfig) {
    this.config = { ...config };
  }

  /**
   * Initialize the crash reporter.
   * If enabled, configures Sentry for main + renderer processes.
   * If disabled (opt-out), captures exceptions locally only.
   */
  initialize(sentryAdapter?: SentryClientAdapter): void {
    if (this.initialized) return;

    if (sentryAdapter) {
      this.sentryClient = sentryAdapter;
    }

    if (this.config.enabled && this.sentryClient) {
      this.sentryClient.init({
        dsn: this.config.dsn,
        environment: this.config.environment,
        release: this.config.release,
        beforeSend: (event) => this.beforeSend(event),
        beforeBreadcrumb: (breadcrumb) => this.beforeBreadcrumb(breadcrumb),
      });

      // Set context tags for metadata
      this.sentryClient.setTags(this.getMetadataTags());
    }

    this.initialized = true;
  }

  /**
   * Add a breadcrumb for tracking user actions, IPC calls, state transitions.
   */
  addBreadcrumb(breadcrumb: Omit<Breadcrumb, 'timestamp'>): void {
    const entry: Breadcrumb = {
      ...breadcrumb,
      timestamp: Date.now(),
    };

    this.breadcrumbs.push(entry);

    // Trim to max size (FIFO)
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs = this.breadcrumbs.slice(-MAX_BREADCRUMBS);
    }

    // Forward to Sentry if enabled and transmitting
    if (this.config.enabled && this.sentryClient && !this.transmissionBlocked) {
      this.sentryClient.addBreadcrumb({
        category: entry.category,
        message: entry.message,
        data: entry.data,
        timestamp: entry.timestamp / 1000, // Sentry expects seconds
      });
    }
  }

  /**
   * Capture an exception.
   * If opted out or transmission blocked, stores locally.
   * Otherwise, sends to Sentry.
   */
  captureException(error: Error | string, context?: Record<string, unknown>): void {
    const err = typeof error === 'string' ? new Error(error) : error;

    if (!this.config.enabled || this.transmissionBlocked || !this.sentryClient) {
      // Local-only capture
      this.captureLocally(err);
      return;
    }

    // Sentry transmission
    this.sentryClient.captureException(err, {
      extra: context,
      tags: this.getMetadataTags(),
    });
  }

  /**
   * Set user opt-out preference. When opted out:
   * - Completely blocks all Sentry transmission
   * - Exceptions are captured locally only
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;

    if (!enabled && this.sentryClient) {
      // Close the Sentry client to stop all transmission
      this.sentryClient.close();
    }
  }

  /**
   * Block transmission for technical reasons (e.g., network unavailable).
   */
  blockTransmission(reason: string): void {
    this.transmissionBlocked = true;
    this.blockReason = reason;
  }

  /**
   * Unblock transmission (e.g., network recovered).
   */
  unblockTransmission(): void {
    this.transmissionBlocked = false;
    this.blockReason = undefined;
  }

  /**
   * Get the current status of the crash reporter.
   */
  getStatus(): CrashReporterStatus {
    return {
      initialized: this.initialized,
      enabled: this.config.enabled,
      transmissionBlocked: this.transmissionBlocked,
      blockReason: this.blockReason,
      localCaptureCount: this.localCaptures.length,
    };
  }

  /**
   * Get locally captured exceptions (for when transmission was blocked or opted out).
   */
  getLocalCaptures(): LocalCapture[] {
    return [...this.localCaptures];
  }

  /**
   * Get the current breadcrumbs.
   */
  getBreadcrumbs(): Breadcrumb[] {
    return [...this.breadcrumbs];
  }

  /**
   * Strip user-specific paths from a string.
   * Replaces home directory paths with ~/ and platform-specific user paths.
   */
  scrubFilePaths(input: string): string {
    if (!this.config.scrubPaths) return input;

    let result = input;

    // Replace home directory with ~
    if (HOME_DIR) {
      result = result.replace(new RegExp(escapeRegExp(HOME_DIR), 'g'), '~');
    }

    // Replace Windows-style user paths
    result = result.replace(/[A-Z]:\\Users\\[^\\]+/gi, 'C:\\Users\\<user>');

    // Replace Unix-style user paths that weren't caught by HOME_DIR
    result = result.replace(/\/(?:home|Users)\/[^/\s]+/g, '~');

    return result;
  }

  /**
   * Strip secrets and sensitive tokens from a string.
   */
  scrubSecrets(input: string): string {
    let result = input;
    for (const pattern of SECRET_PATTERNS) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }

  /**
   * Full scrubbing: paths + secrets.
   */
  scrub(input: string): string {
    return this.scrubSecrets(this.scrubFilePaths(input));
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Sentry beforeSend hook: strips PII and secrets from events.
   * Returns null to drop the event if transmission is blocked.
   */
  private beforeSend(event: SentryEvent): SentryEvent | null {
    // Block if opted out or transmission blocked
    if (!this.config.enabled || this.transmissionBlocked) {
      return null;
    }

    // Scrub exception messages and stack traces
    if (event.exception?.values) {
      for (const ex of event.exception.values) {
        if (ex.value) {
          ex.value = this.scrub(ex.value);
        }
        if (ex.stacktrace?.frames) {
          for (const frame of ex.stacktrace.frames) {
            if (frame.filename) {
              frame.filename = this.scrubFilePaths(frame.filename);
            }
            if (frame.abs_path) {
              frame.abs_path = this.scrubFilePaths(frame.abs_path);
            }
          }
        }
      }
    }

    // Scrub breadcrumb messages
    if (event.breadcrumbs) {
      for (const bc of event.breadcrumbs) {
        if (bc.message) {
          bc.message = this.scrub(bc.message);
        }
      }
    }

    // Scrub extra/context data
    if (event.extra) {
      event.extra = scrubObject(event.extra, this.scrub.bind(this));
    }

    return event;
  }

  /**
   * Sentry beforeBreadcrumb hook: scrubs breadcrumb data before storage.
   */
  private beforeBreadcrumb(breadcrumb: SentryBreadcrumb): SentryBreadcrumb | null {
    if (breadcrumb.message) {
      breadcrumb.message = this.scrub(breadcrumb.message);
    }
    return breadcrumb;
  }

  /**
   * Capture an exception locally (when transmission is blocked or opted out).
   */
  private captureLocally(error: Error): void {
    const capture: LocalCapture = {
      timestamp: new Date().toISOString(),
      error: this.scrub(error.message),
      stack: error.stack ? this.scrub(error.stack) : undefined,
      breadcrumbs: [...this.breadcrumbs],
      metadata: this.getMetadataTags(),
    };
    this.localCaptures.push(capture);
  }

  /**
   * Get metadata tags for report context.
   */
  private getMetadataTags(): Record<string, string> {
    return {
      'app.version': this.config.release,
      'os.name': os.platform(),
      'os.version': os.release(),
      'os.arch': os.arch(),
      'electron.version': process.versions?.electron ?? 'unknown',
      'node.version': process.versions?.node ?? 'unknown',
      'environment': this.config.environment,
    };
  }
}

// ─── Sentry Adapter Interface ───────────────────────────────────────────────

/**
 * Adapter interface for Sentry client.
 * Allows dependency injection for testing without requiring actual @sentry/electron.
 */
export interface SentryClientAdapter {
  init(options: SentryInitOptions): void;
  setTags(tags: Record<string, string>): void;
  addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
  captureException(error: Error, options?: { extra?: Record<string, unknown>; tags?: Record<string, string> }): void;
  close(): void;
}

export interface SentryInitOptions {
  dsn: string;
  environment: string;
  release: string;
  beforeSend?: (event: SentryEvent) => SentryEvent | null;
  beforeBreadcrumb?: (breadcrumb: SentryBreadcrumb) => SentryBreadcrumb | null;
}

export interface SentryEvent {
  exception?: {
    values?: Array<{
      value?: string;
      stacktrace?: {
        frames?: Array<{
          filename?: string;
          abs_path?: string;
        }>;
      };
    }>;
  };
  breadcrumbs?: SentryBreadcrumb[];
  extra?: Record<string, unknown>;
}

export interface SentryBreadcrumb {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recursively scrub string values in an object.
 */
function scrubObject(obj: Record<string, unknown>, scrubFn: (s: string) => string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = scrubFn(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = scrubObject(value as Record<string, unknown>, scrubFn);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a CrashReporter with the given config.
 * Call initialize() after construction to activate.
 */
export function createCrashReporter(config: CrashReporterConfig): CrashReporter {
  return new CrashReporter(config);
}
