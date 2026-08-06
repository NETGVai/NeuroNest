// ─── Stub Adapter ───────────────────────────────────────────────
// Placeholder adapter for channels that are not yet implemented.
// Returns failure results from all lifecycle methods and never
// transitions to a 'connected' status.

import type { ChannelAdapter, AdapterContext } from './types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from './types/messages';
import type { AdapterCapabilities } from './types/capabilities';
import type { TileMetadata } from './types/tile-metadata';
import { z } from 'zod';

/**
 * A no-op adapter used for channels whose real SDK integration is
 * planned but not yet built. It safely rejects `connect` and `send`
 * with informative messages while declaring `implementationStatus:
 * 'coming-soon'` so the UI can render a disabled "Not Available" control.
 *
 * @satisfies REQ 29.2, REQ 29.3, REQ 29.4, REQ 29.5, REQ 29.6
 */
export class StubAdapter implements ChannelAdapter {
  readonly capabilities: AdapterCapabilities = {
    direction: 'send-only',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'push',
    requiresListener: false,
    implementationStatus: 'coming-soon',
  };

  readonly configSchema = z.object({}).passthrough();

  constructor(
    readonly channelId: string,
    readonly tileMetadata: TileMetadata,
  ) {}

  async connect(_config: unknown, _context: AdapterContext): Promise<ConnectResult> {
    return {
      success: false,
      message:
        `Not yet implemented — ${this.tileMetadata.displayName} is a placeholder ` +
        `adapter. Real integration is planned in a follow-up spec.`,
    };
  }

  async disconnect(): Promise<void> {
    /* nothing to release */
  }

  isConnected(): boolean {
    return false;
  }

  async send(_msg: OutgoingMessage): Promise<SendResult> {
    return {
      success: false,
      message: `Not yet implemented — ${this.tileMetadata.displayName} is a placeholder adapter.`,
    };
  }
}
