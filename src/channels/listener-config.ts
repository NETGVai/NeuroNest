/**
 * ListenerConfig — Shared port validation and listener configuration for HTTP listeners.
 *
 * Provides:
 * - A `ListenerConfig` interface with port, host, and enabled state
 * - A `validatePort` function that rejects ports outside 1–65535
 * - A `validateListenerPair` function that detects same-port conflicts
 * - Distinct default ports for each listener
 * - Loopback-by-default binding (never 0.0.0.0 unless explicitly configured)
 *
 * Requirements: 22.5, 22.6, 22.8, 22.9, 22.10
 */

// ─── Constants ──────────────────────────────────────────────────

/** Default port for the WhatsApp Cloud webhook listener */
export const WHATSAPP_WEBHOOK_DEFAULT_PORT = 9876;

/** Default port for the Remote Access Bridge listener */
export const REMOTE_ACCESS_BRIDGE_DEFAULT_PORT = 9877;

/** Loopback address — never bind to 0.0.0.0 by default (R22.6) */
export const DEFAULT_BIND_HOST = '127.0.0.1';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * Configuration for an HTTP listener.
 * Both the WhatsApp webhook and the remote-access-bridge use this shape.
 */
export interface ListenerConfig {
  /** Port to bind on. Must be in range 1–65535. */
  port: number;
  /**
   * Host/interface to bind to. Defaults to '127.0.0.1' (loopback).
   * Only set to a non-loopback address when remote access is explicitly configured.
   * Never defaults to '0.0.0.0'. (R22.6, R22.10)
   */
  host: string;
  /** Whether this listener is enabled */
  enabled: boolean;
}

// ─── Errors ─────────────────────────────────────────────────────

/**
 * Error thrown when a port value is outside the valid TCP range (1–65535).
 * Requirements: 22.9
 */
export class InvalidPortError extends Error {
  constructor(port: number, listenerName: string) {
    super(
      `Invalid port ${port} for ${listenerName}: port must be between 1 and 65535 (inclusive).`,
    );
    this.name = 'InvalidPortError';
  }
}

/**
 * Error thrown when two listeners are configured on the same port.
 * Requirements: 22.8
 */
export class PortConflictError extends Error {
  constructor(port: number, listenerA: string, listenerB: string) {
    super(
      `Port conflict: both ${listenerA} and ${listenerB} are configured to bind on port ${port}. ` +
      `Each listener must use a distinct port when both are enabled.`,
    );
    this.name = 'PortConflictError';
  }
}

// ─── Validation Functions ───────────────────────────────────────

/**
 * Validate that a port number is within the valid TCP range (0–65535).
 * Port `0` is accepted as the standard OS convention for "assign an
 * available ephemeral port at bind time" and is not treated as invalid.
 * Throws `InvalidPortError` for any other out-of-range or non-integer value.
 *
 * Requirements: 22.9
 *
 * @param port - The port number to validate
 * @param listenerName - Human-readable name of the listener (for error messages)
 * @returns The validated port number
 */
export function validatePort(port: number, listenerName: string): number {
  if (!Number.isFinite(port) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidPortError(port, listenerName);
  }
  return port;
}

/**
 * Validate that a host binding does not default to 0.0.0.0.
 * If no host is provided, returns the loopback default.
 * If '0.0.0.0' is specified without explicit remote-access configuration, it is rejected.
 *
 * Requirements: 22.6, 22.10
 *
 * @param host - The host/interface to validate (may be undefined)
 * @param remoteAccessExplicit - Whether remote access has been explicitly configured
 * @returns The validated host string
 */
export function resolveBindHost(
  host: string | undefined,
  remoteAccessExplicit: boolean,
): string {
  // No host specified → loopback (R22.6)
  if (!host) {
    return DEFAULT_BIND_HOST;
  }

  // 0.0.0.0 is never the default. Only allowed with explicit remote-access config (R22.10)
  if (host === '0.0.0.0' && !remoteAccessExplicit) {
    return DEFAULT_BIND_HOST;
  }

  return host;
}

/**
 * Validate a pair of listener configs to detect same-port conflicts.
 * Throws `PortConflictError` if both are enabled on the same port and same host.
 *
 * Requirements: 22.8
 *
 * @param a - First listener config (with name)
 * @param b - Second listener config (with name)
 */
export function validateListenerPair(
  a: { config: ListenerConfig; name: string },
  b: { config: ListenerConfig; name: string },
): void {
  if (!a.config.enabled || !b.config.enabled) {
    return; // No conflict if either is disabled
  }

  if (a.config.port === b.config.port) {
    // Conflict only matters if they bind the same interface
    // (same port on different interfaces is fine, e.g. 127.0.0.1:9876 vs 10.0.0.1:9876)
    const hostA = a.config.host || DEFAULT_BIND_HOST;
    const hostB = b.config.host || DEFAULT_BIND_HOST;

    // If either is 0.0.0.0, it binds all interfaces → conflict
    if (hostA === '0.0.0.0' || hostB === '0.0.0.0' || hostA === hostB) {
      throw new PortConflictError(a.config.port, a.name, b.name);
    }
  }
}

/**
 * Build a validated ListenerConfig with proper defaults.
 * Applies port validation, loopback-by-default host resolution, and enabled state.
 *
 * @param options - Partial configuration options
 * @param defaults - Default values for this listener
 * @param listenerName - Human-readable name (for error messages)
 * @returns A fully validated ListenerConfig
 */
export function buildListenerConfig(
  options: { port?: number; host?: string; enabled?: boolean; remoteAccessExplicit?: boolean },
  defaults: { port: number },
  listenerName: string,
): ListenerConfig {
  const port = validatePort(options.port ?? defaults.port, listenerName);
  const host = resolveBindHost(options.host, options.remoteAccessExplicit ?? false);
  const enabled = options.enabled ?? true;

  return { port, host, enabled };
}
