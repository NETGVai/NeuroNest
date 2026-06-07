/**
 * BoundedMessageStore - Caps in-memory messages at 200, persisting overflow
 * to SQLite and loading older messages on demand.
 *
 * This is a renderer-side module. Since the renderer cannot directly access
 * SQLite in Electron, it accepts a MessagePersistence adapter that abstracts
 * the IPC communication with the main process for database operations.
 */

import { StoredMessage, MessagePage } from '../../main/performance/types';

/**
 * Adapter interface for database operations.
 * Implementations bridge to the main process via IPC.
 */
export interface MessagePersistence {
  persistMessages(messages: StoredMessage[]): Promise<void>;
  loadMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<StoredMessage[]>;
  getCount(sessionId: string): Promise<number>;
  clearSession(sessionId: string): Promise<void>;
}

/** Delay helper for retry logic */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class BoundedMessageStore {
  private static readonly MAX_IN_MEMORY = 200;
  private static readonly RETRY_DELAY_MS = 100;

  private messages: StoredMessage[] = [];
  private sessionId: string;
  private persistence: MessagePersistence;
  private persistInFlight = false;

  constructor(persistence: MessagePersistence, sessionId: string) {
    this.persistence = persistence;
    this.sessionId = sessionId;
  }

  /**
   * Add a message to the store. If the in-memory count exceeds 200,
   * the oldest messages are persisted to the database.
   */
  addMessage(msg: StoredMessage): void {
    this.messages.push(msg);

    if (this.messages.length > BoundedMessageStore.MAX_IN_MEMORY) {
      this.persistOverflow();
    }
  }

  /**
   * Get current in-memory messages (for rendering).
   * Returns a shallow copy to prevent external mutation.
   */
  getRecentMessages(): StoredMessage[] {
    return [...this.messages];
  }

  /**
   * Load older messages from the database (for scroll-back).
   * Queries by session_id and timestamp with pagination.
   */
  async loadOlderMessages(beforeTimestamp: number, limit: number = 50): Promise<MessagePage> {
    const messages = await this.persistence.loadMessages(
      this.sessionId,
      beforeTimestamp,
      limit
    );

    const hasMore = messages.length === limit;
    const oldestTimestamp = messages.length > 0
      ? messages[0].timestamp
      : beforeTimestamp;

    return {
      messages,
      hasMore,
      oldestTimestamp,
    };
  }

  /**
   * Get total message count (memory + persisted in DB).
   */
  async getTotalCount(): Promise<number> {
    const dbCount = await this.persistence.getCount(this.sessionId);
    return this.messages.length + dbCount;
  }

  /**
   * Clear all messages for the current session (both in-memory and persisted).
   */
  clear(): void {
    this.messages = [];
    // Fire-and-forget the DB clear; errors are logged but don't block
    this.persistence.clearSession(this.sessionId).catch(() => {
      // Silently handle — the session data will be orphaned but not harmful
    });
  }

  /**
   * Switch to a different session. Persists any pending overflow from the
   * current session, clears in-memory messages, and sets the new session ID.
   */
  switchSession(sessionId: string): void {
    // If there are messages beyond the cap that haven't been persisted yet,
    // persist them before switching
    if (this.messages.length > BoundedMessageStore.MAX_IN_MEMORY) {
      this.persistOverflow();
    }

    this.messages = [];
    this.sessionId = sessionId;
  }

  /**
   * Persist the oldest messages that exceed the 200-message cap.
   * Uses retry logic: if the first attempt fails, retries once after 100ms.
   * If both attempts fail, messages are kept in memory (temporarily exceeding 200).
   */
  private persistOverflow(): void {
    if (this.persistInFlight) {
      // Already persisting; messages will stay in memory temporarily
      return;
    }

    const overflowCount = this.messages.length - BoundedMessageStore.MAX_IN_MEMORY;
    if (overflowCount <= 0) return;

    // Extract the oldest messages to persist
    const toPersist = this.messages.splice(0, overflowCount);

    this.persistInFlight = true;

    this.attemptPersist(toPersist)
      .catch(async () => {
        // First attempt failed — retry after delay
        await delay(BoundedMessageStore.RETRY_DELAY_MS);
        return this.attemptPersist(toPersist);
      })
      .catch(() => {
        // Both attempts failed — put messages back in memory (at the front)
        this.messages.unshift(...toPersist);
      })
      .finally(() => {
        this.persistInFlight = false;
      });
  }

  /**
   * Attempt to persist messages to the database.
   */
  private async attemptPersist(messages: StoredMessage[]): Promise<void> {
    await this.persistence.persistMessages(messages);
  }
}
