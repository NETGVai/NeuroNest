/**
 * Stub IPC handler module — registers placeholder handlers for all
 * declared-but-unimplemented IPC channels.
 *
 * Each stub handler returns a structured response indicating the feature
 * is not yet available. Handlers never throw, regardless of input.
 *
 * Requirements: 9.6
 */

import { ipcMain } from 'electron';

// ─── Types ──────────────────────────────────────────────────────

export interface StubResponse {
  available: false;
  channel: string;
  message: string;
}

// ─── Implementation ─────────────────────────────────────────────

/**
 * Registers placeholder IPC handlers for channels that are declared
 * in the preload allowlist but not yet implemented.
 *
 * Each handler returns `{ available: false, channel, message }` and
 * never throws an unhandled exception.
 *
 * @param channels - Array of IPC channel names to register stubs for
 */
export function registerStubHandlers(channels: string[]): void {
  for (const channel of channels) {
    ipcMain.handle(channel, async (_event, ..._args: unknown[]): Promise<StubResponse> => {
      try {
        return {
          available: false,
          channel,
          message: 'Feature not yet available',
        };
      } catch {
        // Defensive: even if something unexpected happens inside the
        // handler, never throw — always return the structured response.
        return {
          available: false,
          channel,
          message: 'Feature not yet available',
        };
      }
    });
  }
}
