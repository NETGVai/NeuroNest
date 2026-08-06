// ─── Error Taxonomy ─────────────────────────────────────────────
// Structured error codes and error class for adapter diagnostics.

/**
 * String-literal union covering the six error-taxonomy values emitted
 * in CHANNEL_STATUS_EVENT payloads when an adapter's `connect` fails.
 *
 * Consumers (admin UI, logs, observability tooling) use this code to
 * distinguish between config errors, missing SDKs, auth failures,
 * network issues, port conflicts, and opaque provider-side errors
 * without parsing free-text messages.
 *
 * @satisfies REQ 21.1
 */
export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'SDK_MISSING'
  | 'AUTH_FAILED'
  | 'NETWORK_ERROR'
  | 'LISTENER_PORT_CONFLICT'
  | 'PROVIDER_ERROR';

/**
 * Typed error class thrown or returned by adapters and the
 * ChannelManager when a failure maps to a known taxonomy code.
 *
 * @satisfies REQ 21.1
 */
export class AdapterError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}
