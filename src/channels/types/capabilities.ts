// ─── Adapter Capabilities ───────────────────────────────────────
// Type definitions for adapter capability declarations and channel status.

/**
 * The connection lifecycle states an adapter transitions through.
 * Emitted via CHANNEL_STATUS_EVENT on every state change.
 */
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Declarative capability flags each adapter exposes so that the
 * ChannelManager and admin UI can adjust behavior without
 * hardcoding per-provider checks.
 */
export interface AdapterCapabilities {
  /**
   * Whether the adapter supports inbound messages or is outbound-only.
   * @satisfies REQ 4.1
   */
  direction: 'send-only' | 'bidirectional';

  /**
   * Whether the underlying provider supports typing indicators.
   * @satisfies REQ 4.2
   */
  supportsTyping: boolean;

  /**
   * Whether the underlying provider supports rich media (images, files, etc.).
   * @satisfies REQ 4.3
   */
  supportsRichMedia: boolean;

  /**
   * The transport mechanism the adapter uses for inbound events.
   * @satisfies REQ 4.4
   */
  deliveryMode: 'webhook' | 'polling' | 'websocket' | 'push';

  /**
   * Whether the adapter binds a local HTTP port for inbound traffic.
   * @satisfies REQ 4.5
   */
  requiresListener: boolean;

  /**
   * Whether this adapter is a real SDK integration or a placeholder stub.
   * The channels-view UI uses this to distinguish enabled "Setup" controls
   * from disabled "Not Available" controls.
   * @satisfies REQ 4.9
   */
  implementationStatus: 'available' | 'coming-soon';
}
