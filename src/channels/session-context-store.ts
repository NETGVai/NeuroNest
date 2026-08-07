// ─── SessionContextStore ────────────────────────────────────────
// Per-channel, per-user conversational state maintained across
// multiple message exchanges. Each unique (channelId, senderId) pair
// has its own isolated history capped at 50 messages.
//
// Requirements: 5.1, 5.2, 5.3, 5.4, 5.6

/**
 * A single message entry stored within a session.
 */
export interface MessageEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * The full session record for a unique channel-sender pair.
 */
export interface SessionEntry {
  channelId: string;
  senderId: string;
  messages: MessageEntry[];
  createdAt: number;
  lastActivityAt: number;
}

/**
 * Manages per-channel, per-user session contexts with a fixed history cap.
 *
 * Composite key: `${channelId}::${senderId}`
 * Max messages per session: 50 (oldest-first eviction)
 */
export class SessionContextStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly maxMessages = 50;

  /**
   * Build the composite key for a channel-sender pair.
   */
  private key(channelId: string, senderId: string): string {
    return `${channelId}::${senderId}`;
  }

  /**
   * Retrieve an existing session or create a new one for the given
   * channel-sender pair.
   *
   * @satisfies REQ 5.1 — separate session per (channelId, senderId)
   * @satisfies REQ 5.6 — independent sessions per channel
   */
  getOrCreate(channelId: string, senderId: string): SessionEntry {
    const k = this.key(channelId, senderId);
    if (!this.sessions.has(k)) {
      this.sessions.set(k, {
        channelId,
        senderId,
        messages: [],
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });
    }
    return this.sessions.get(k)!;
  }

  /**
   * Append a message to the session for the given channel-sender pair.
   * Enforces the 50-message cap by discarding the oldest entries first.
   *
   * @satisfies REQ 5.2 — store conversation history
   * @satisfies REQ 5.3 — max 50 messages with oldest-first eviction
   */
  appendMessage(
    channelId: string,
    senderId: string,
    role: 'user' | 'assistant',
    content: string,
  ): void {
    const session = this.getOrCreate(channelId, senderId);
    session.messages.push({ role, content, timestamp: Date.now() });
    if (session.messages.length > this.maxMessages) {
      session.messages = session.messages.slice(-this.maxMessages);
    }
    session.lastActivityAt = Date.now();
  }

  /**
   * Retrieve the conversation history for a channel-sender pair.
   * Returns messages in chronological order (oldest first).
   *
   * @satisfies REQ 5.2 — include conversation history in AI pipeline request
   */
  getHistory(
    channelId: string,
    senderId: string,
  ): Array<{ role: 'user' | 'assistant'; content: string }> {
    const session = this.getOrCreate(channelId, senderId);
    return session.messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * Clear and remove the session for the given channel-sender pair.
   *
   * @satisfies REQ 5.4 — explicit context reset
   */
  clear(channelId: string, senderId: string): void {
    this.sessions.delete(this.key(channelId, senderId));
  }

  /**
   * List all active sessions across all channels.
   */
  listActiveSessions(): SessionEntry[] {
    return Array.from(this.sessions.values());
  }
}
