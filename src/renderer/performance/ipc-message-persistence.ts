/**
 * IPC-based MessagePersistence adapter for the renderer process.
 * Bridges BoundedMessageStore to the main process SQLite database via IPC.
 */

import { StoredMessage } from '../../main/performance/types';
import { MessagePersistence } from './bounded-message-store';

/**
 * Creates a MessagePersistence implementation that communicates with
 * the main process via Electron IPC for database operations.
 */
export function createIPCMessagePersistence(): MessagePersistence {
  return {
    async persistMessages(messages: StoredMessage[]): Promise<void> {
      const result = await (window as any).electronAPI.invoke('persist-overflow-messages', { messages });
      if (result && !result.success) {
        throw new Error(result.error || 'Failed to persist messages');
      }
    },

    async loadMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<StoredMessage[]> {
      const result = await (window as any).electronAPI.invoke('load-older-messages', {
        sessionId,
        beforeTimestamp,
        limit,
      });
      return result.messages || [];
    },

    async getCount(sessionId: string): Promise<number> {
      const result = await (window as any).electronAPI.invoke('get-overflow-count', { sessionId });
      return result.count || 0;
    },

    async clearSession(sessionId: string): Promise<void> {
      await (window as any).electronAPI.invoke('clear-overflow-session', { sessionId });
    },
  };
}
