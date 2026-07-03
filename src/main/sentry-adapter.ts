/**
 * Concrete SentryClientAdapter implementation wrapping @sentry/electron v7.
 *
 * This adapter bridges the CrashReporter's SentryClientAdapter interface
 * to the actual Sentry SDK. Only this file needs updating when upgrading
 * the @sentry/electron dependency.
 *
 * @sentry/electron v7 key changes from v5:
 * - Import from '@sentry/electron/main' (not root '@sentry/electron')
 * - Underlying JS SDK upgraded from v8 to v10
 * - `configureScope()` removed → use `getCurrentScope()` directly
 * - Integrations are functional (not class-based)
 * - `addBreadcrumb`, `captureException`, `init`, `close` remain stable
 */

import * as Sentry from '@sentry/electron/main';
import type { SentryClientAdapter, SentryInitOptions, SentryBreadcrumb } from './crash-reporter';

/**
 * Creates a concrete SentryClientAdapter that delegates to @sentry/electron v7.
 *
 * Usage:
 *   import { createSentryAdapter } from './sentry-adapter';
 *   const adapter = createSentryAdapter();
 *   crashReporter.initialize(adapter);
 */
export function createSentryAdapter(): SentryClientAdapter {
  return {
    init(options: SentryInitOptions): void {
      Sentry.init({
        dsn: options.dsn,
        environment: options.environment,
        release: options.release,
        beforeSend(event) {
          if (!options.beforeSend) return event;
          // Map Sentry SDK event to our SentryEvent interface
          const mapped = options.beforeSend({
            exception: event.exception as any,
            breadcrumbs: event.breadcrumbs as any,
            extra: event.extra as Record<string, unknown> | undefined,
          });
          if (mapped === null) return null;
          // Apply scrubbed values back
          return {
            ...event,
            exception: mapped.exception as any,
            breadcrumbs: mapped.breadcrumbs as any,
            extra: mapped.extra as any,
          };
        },
        beforeBreadcrumb(breadcrumb) {
          if (!options.beforeBreadcrumb) return breadcrumb;
          const mapped = options.beforeBreadcrumb({
            category: breadcrumb.category,
            message: breadcrumb.message,
            data: breadcrumb.data as Record<string, unknown> | undefined,
            timestamp: breadcrumb.timestamp,
          });
          if (mapped === null) return null;
          return {
            ...breadcrumb,
            category: mapped.category,
            message: mapped.message,
            data: mapped.data,
            timestamp: mapped.timestamp,
          };
        },
      });
    },

    setTags(tags: Record<string, string>): void {
      // In Sentry JS SDK v10, use getCurrentScope() to set tags
      // configureScope() was removed in v10
      Sentry.getCurrentScope().setTags(tags);
    },

    addBreadcrumb(breadcrumb: SentryBreadcrumb): void {
      Sentry.addBreadcrumb({
        category: breadcrumb.category,
        message: breadcrumb.message,
        data: breadcrumb.data,
        timestamp: breadcrumb.timestamp,
      });
    },

    captureException(
      error: Error,
      options?: { extra?: Record<string, unknown>; tags?: Record<string, string> },
    ): void {
      Sentry.captureException(error, {
        extra: options?.extra,
        tags: options?.tags,
      });
    },

    close(): void {
      // Sentry.close() returns a Promise; fire-and-forget for the adapter interface
      void Sentry.close();
    },
  };
}
