/**
 * Localization Layer — User-visible Text, Numbers, Durations, Shortcuts
 *
 * All user-visible labels, status messages, errors, durations, numbers,
 * and keyboard shortcuts are sourced from localized resources rather than
 * hard-coded strings.
 *
 * Requirements: 46.11, 46.16
 */

import { z } from 'zod';

// ─── Schemas ────────────────────────────────────────────────────

/**
 * Supported locales.
 */
export const LocaleSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, {
  message: 'Locale must be in format "xx" or "xx-XX" (e.g., "en", "en-US")',
});
export type Locale = z.infer<typeof LocaleSchema>;

/**
 * A localized resource key. Used to look up text from resource bundles.
 */
export const ResourceKeySchema = z.string().min(1).regex(/^[a-z][a-z0-9_.]+$/, {
  message: 'Resource key must start with lowercase letter, using dots/underscores as separators',
});
export type ResourceKey = z.infer<typeof ResourceKeySchema>;

/**
 * Duration format options.
 */
export const DurationFormatSchema = z.enum([
  'short',   // "5s", "2m 30s"
  'medium',  // "5 sec", "2 min 30 sec"
  'long',    // "5 seconds", "2 minutes 30 seconds"
]);
export type DurationFormat = z.infer<typeof DurationFormatSchema>;

/**
 * Number format options.
 */
export const NumberFormatOptionsSchema = z.object({
  /** Number of decimal places. */
  decimals: z.number().int().nonnegative().optional(),
  /** Whether to use grouping separators (e.g., 1,000). */
  useGrouping: z.boolean().optional(),
  /** Notation style. */
  notation: z.enum(['standard', 'compact', 'scientific']).optional(),
  /** Unit to display (e.g., 'percent', 'byte'). */
  unit: z.string().optional(),
});
export type NumberFormatOptions = z.infer<typeof NumberFormatOptionsSchema>;

/**
 * Keyboard shortcut representation for localization.
 */
export const ShortcutDescriptorSchema = z.object({
  /** Platform-independent action identity. */
  actionId: z.string().min(1),
  /** The key combination (modifier keys + key). */
  keys: z.array(z.string().min(1)).min(1),
  /** Platform-specific display override (e.g., Cmd vs Ctrl). */
  platform: z.enum(['mac', 'windows', 'linux', 'generic']).optional(),
});
export type ShortcutDescriptor = z.infer<typeof ShortcutDescriptorSchema>;

// ─── Resource Bundle ────────────────────────────────────────────

/**
 * A flat map of resource keys to localized strings.
 * Supports simple interpolation via {paramName} placeholders.
 */
export type ResourceBundle = Record<string, string>;

// ─── Default English Resource Bundle ────────────────────────────

export const DEFAULT_RESOURCE_BUNDLE: ResourceBundle = {
  // Turn activity states
  'turn.status.queued': 'Queued',
  'turn.status.assembling': 'Assembling',
  'turn.status.awaiting_first_token': 'Waiting for response',
  'turn.status.reasoning': 'Thinking',
  'turn.status.tool_running': 'Running tool',
  'turn.status.streaming': 'Responding',
  'turn.status.retrying': 'Retrying',
  'turn.status.waiting_for_user': 'Waiting for input',
  'turn.status.cancelling': 'Cancelling',
  'turn.status.interrupted': 'Interrupted',
  'turn.status.completed': 'Completed',
  'turn.status.failed': 'Failed',
  'turn.status.reconnecting': 'Reconnecting (attempt {count})',

  // Focus/modal
  'modal.close': 'Close',
  'modal.escape_hint': 'Press Escape to close',
  'modal.focus_trapped': 'Dialog active, focus contained',

  // Lightbox
  'lightbox.close': 'Close image viewer',
  'lightbox.zoom_in': 'Zoom in',
  'lightbox.zoom_out': 'Zoom out',

  // Layout
  'layout.narrow_mode': 'Compact layout',
  'layout.wide_mode': 'Full layout',
  'layout.disclosure_expand': 'Show more fields',
  'layout.disclosure_collapse': 'Show fewer fields',

  // Accessibility
  'a11y.scroll_region': 'Scrollable {kind} region',
  'a11y.reduced_motion_active': 'Reduced motion is active',
  'a11y.focus_restored': 'Focus restored to {target}',

  // Status indicators
  'status.loading': 'Loading',
  'status.error': 'Error',
  'status.success': 'Success',
  'status.warning': 'Warning',
  'status.pending': 'Pending',
  'status.stale': 'Stale',
  'status.unavailable': 'Unavailable',

  // Durations
  'duration.seconds': '{value}s',
  'duration.minutes_seconds': '{minutes}m {seconds}s',
  'duration.hours_minutes': '{hours}h {minutes}m',

  // Shortcuts
  'shortcut.send': 'Send message',
  'shortcut.cancel': 'Cancel',
  'shortcut.undo': 'Undo',
  'shortcut.redo': 'Redo',

  // Attachment
  'attachment.status.validating': 'Validating',
  'attachment.status.uploading': 'Uploading',
  'attachment.status.scanning': 'Scanning',
  'attachment.status.ready': 'Ready',
  'attachment.status.error': 'Error',

  // Queue
  'queue.entry_position': 'Position {position} of {total}',
  'queue.empty': 'Queue is empty',
};

// ─── Localization Manager ───────────────────────────────────────

/**
 * Manages localized resources for all user-visible text, numbers,
 * durations, and keyboard shortcuts.
 *
 * All presentation layer code sources text from this manager rather
 * than embedding literal strings.
 *
 * Requirements: 46.11
 */
export class LocalizationManager {
  private locale: string;
  private bundle: ResourceBundle;
  private fallbackBundle: ResourceBundle;

  constructor(
    locale: string = 'en',
    bundle: ResourceBundle = DEFAULT_RESOURCE_BUNDLE,
    fallbackBundle: ResourceBundle = DEFAULT_RESOURCE_BUNDLE,
  ) {
    this.locale = locale;
    this.bundle = bundle;
    this.fallbackBundle = fallbackBundle;
  }

  /**
   * Returns the active locale.
   */
  getLocale(): string {
    return this.locale;
  }

  /**
   * Updates the active locale and bundle.
   */
  setLocale(locale: string, bundle: ResourceBundle): void {
    this.locale = locale;
    this.bundle = bundle;
  }

  /**
   * Resolves a localized string by resource key with optional interpolation.
   *
   * @param key - The resource key to look up
   * @param params - Optional interpolation parameters for {paramName} placeholders
   * @returns The localized string, or the key itself if not found
   */
  getString(key: string, params?: Record<string, string | number>): string {
    const template = this.bundle[key] ?? this.fallbackBundle[key] ?? key;
    if (!params) return template;

    return template.replace(/\{(\w+)\}/g, (_, paramName: string) => {
      const value = params[paramName];
      return value !== undefined ? String(value) : `{${paramName}}`;
    });
  }

  /**
   * Formats a duration in milliseconds according to locale and format style.
   *
   * Requirements: 46.11
   */
  formatDuration(durationMs: number, format: DurationFormat = 'short'): string {
    const totalSeconds = Math.floor(Math.abs(durationMs) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    switch (format) {
      case 'short':
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
      case 'medium':
        if (hours > 0) return `${hours} hr ${minutes} min`;
        if (minutes > 0) return `${minutes} min ${seconds} sec`;
        return `${seconds} sec`;
      case 'long':
        if (hours > 0) {
          return `${hours} ${hours === 1 ? 'hour' : 'hours'} ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
        }
        if (minutes > 0) {
          return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
        }
        return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
    }
  }

  /**
   * Formats a number according to locale conventions.
   *
   * Requirements: 46.11
   */
  formatNumber(value: number, options: NumberFormatOptions = {}): string {
    const { decimals, useGrouping = true, notation = 'standard', unit } = options;

    // Use basic formatting (no Intl dependency for pure logic)
    let formatted: string;

    if (notation === 'compact') {
      formatted = this.formatCompact(value);
    } else if (notation === 'scientific') {
      formatted = value.toExponential(decimals ?? 2);
    } else {
      formatted = decimals !== undefined
        ? value.toFixed(decimals)
        : String(value);

      if (useGrouping) {
        const parts = formatted.split('.');
        parts[0] = parts[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        formatted = parts.join('.');
      }
    }

    if (unit === 'percent') {
      formatted += '%';
    } else if (unit === 'byte') {
      // Already formatted as number; caller provides raw bytes
      formatted = this.formatBytes(value);
    } else if (unit) {
      formatted += ` ${unit}`;
    }

    return formatted;
  }

  /**
   * Formats a keyboard shortcut for display.
   * Adapts modifier key names to the given platform.
   *
   * Requirements: 46.11
   */
  formatShortcut(descriptor: ShortcutDescriptor): string {
    const platform = descriptor.platform ?? 'generic';
    const keys = descriptor.keys.map((key) => {
      switch (key.toLowerCase()) {
        case 'mod':
          return platform === 'mac' ? '\u2318' : 'Ctrl';
        case 'shift':
          return platform === 'mac' ? '\u21E7' : 'Shift';
        case 'alt':
          return platform === 'mac' ? '\u2325' : 'Alt';
        case 'ctrl':
          return platform === 'mac' ? '\u2303' : 'Ctrl';
        case 'enter':
          return platform === 'mac' ? '\u21A9' : 'Enter';
        case 'escape':
          return 'Esc';
        case 'backspace':
          return platform === 'mac' ? '\u232B' : 'Backspace';
        case 'delete':
          return platform === 'mac' ? '\u2326' : 'Delete';
        case 'tab':
          return platform === 'mac' ? '\u21E5' : 'Tab';
        default:
          return key.length === 1 ? key.toUpperCase() : key;
      }
    });

    return platform === 'mac' ? keys.join('') : keys.join('+');
  }

  /**
   * Returns whether a resource key exists in the bundle.
   */
  hasKey(key: string): boolean {
    return key in this.bundle || key in this.fallbackBundle;
  }

  /**
   * Returns all registered resource keys.
   */
  getKeys(): string[] {
    return [...new Set([...Object.keys(this.bundle), ...Object.keys(this.fallbackBundle)])];
  }

  // ─── Private Helpers ────────────────────────────────────────────

  private formatCompact(value: number): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
    return `${sign}${abs}`;
  }

  private formatBytes(bytes: number): string {
    const abs = Math.abs(bytes);
    if (abs >= 1_073_741_824) return `${(abs / 1_073_741_824).toFixed(1)} GB`;
    if (abs >= 1_048_576) return `${(abs / 1_048_576).toFixed(1)} MB`;
    if (abs >= 1_024) return `${(abs / 1_024).toFixed(1)} KB`;
    return `${abs} B`;
  }
}
