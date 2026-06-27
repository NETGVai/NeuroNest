/**
 * Agent Status Feed — Implementation of real-time agent status broadcasting.
 *
 * Provides a pub/sub mechanism for agent lifecycle status events with
 * push notification delivery to the renderer process via IPC.
 *
 * Key behaviours:
 *   - Emits status events through CallbackEngine within 500ms of status change
 *   - Delivers push notifications to renderer via IPC on completion/failure
 *   - Queues notifications for retry when IPC channel is unavailable
 *   - Includes error summary in failure notifications
 *   - Delivers needs-attention notifications on drift pause or conflict
 *   - Applies null-check guard pattern when `agent_status_feed` flag is disabled
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8
 */

import { randomUUID } from 'node:crypto';
import type { CallbackEngine } from './callback-engine.js';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type {
  AgentStatus,
  AgentStatusEvent,
  StatusNotification,
  IAgentStatusFeed,
} from './agent-status-feed.js';

// ─── IPC Sender Abstraction ─────────────────────────────────────

/**
 * Minimal structural interface for IPC push to the renderer process.
 * Mirrors the `mainWindow.webContents.send` pattern without importing
 * Electron types directly — keeps this module testable and decoupled.
 */
export interface IPCSender {
  /** Returns true when the sender target is alive and reachable. */
  isAvailable(): boolean;
  /** Send a notification payload to the renderer on the given channel. */
  send(channel: string, payload: StatusNotification): void;
}

// ─── Configuration ──────────────────────────────────────────────

export interface AgentStatusFeedConfig {
  /** Maximum time (ms) allowed between status change and event emission. Default: 500. */
  emitDeadlineMs?: number;
  /** Maximum queued notifications awaiting retry. Default: 100. */
  maxQueueSize?: number;
  /** Delay (ms) between retry attempts for queued notifications. Default: 1000. */
  retryDelayMs?: number;
  /** Maximum number of retry attempts per notification. Default: 3. */
  maxRetries?: number;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_EMIT_DEADLINE_MS = 500;
const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_MAX_RETRIES = 3;
const IPC_CHANNEL = 'agent-status:notification';

// ─── Queued notification type ───────────────────────────────────

interface QueuedNotification {
  notification: StatusNotification;
  retryCount: number;
}

// ─── AgentStatusFeed Implementation ─────────────────────────────

/**
 * Real-time event stream that broadcasts status updates from active
 * agent sessions and delivers push notifications on completion,
 * failure, or attention-needed events.
 */
export class AgentStatusFeed implements IAgentStatusFeed {
  private readonly callbackEngine: CallbackEngine;
  private readonly featureGate: FeatureGateSystem;
  private readonly ipcSender: IPCSender | null;
  private readonly config: Required<AgentStatusFeedConfig>;

  /** Active status events indexed by agentId for quick lookup. */
  private activeStatuses: Map<string, AgentStatusEvent> = new Map();

  /** Registered event stream listeners. */
  private listeners: Set<(event: AgentStatusEvent) => void> = new Set();

  /** Queue for notifications that failed IPC delivery. */
  private notificationQueue: QueuedNotification[] = [];

  /** Timer handle for retry processing. */
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    callbackEngine: CallbackEngine,
    featureGate: FeatureGateSystem,
    ipcSender?: IPCSender | null,
    config?: AgentStatusFeedConfig,
  ) {
    this.callbackEngine = callbackEngine;
    this.featureGate = featureGate;
    this.ipcSender = ipcSender ?? null;
    this.config = {
      emitDeadlineMs: config?.emitDeadlineMs ?? DEFAULT_EMIT_DEADLINE_MS,
      maxQueueSize: config?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      retryDelayMs: config?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }

  // ─── IAgentStatusFeed Implementation ────────────────────────────

  /**
   * Emit a status event, broadcasting it through CallbackEngine and
   * notifying all subscribers. Delivers push notifications for
   * completion, failure, and needs-attention statuses.
   *
   * Requirement 5.2: Events emitted within 500ms of status change.
   * Requirement 5.7: Every event includes sessionId, agentId, iteration, timestamp.
   * Requirement 5.8: Zero overhead when feature gate is disabled.
   */
  async emit(event: AgentStatusEvent): Promise<void> {
    // Null-check guard: zero overhead when disabled (Requirement 5.8)
    if (!this.featureGate.isEnabled('agent_status_feed')) {
      return;
    }

    const startTime = Date.now();

    // Ensure required fields are present (Requirement 5.7)
    const validatedEvent = this.validateAndEnrichEvent(event);

    // Update active statuses map
    this.updateActiveStatuses(validatedEvent);

    // Broadcast through CallbackEngine (Requirement 5.2)
    await this.callbackEngine.emit({
      event: 'on-task-complete',
      sessionId: validatedEvent.sessionId,
      iteration: validatedEvent.iteration,
      output: validatedEvent,
    });

    // Notify all subscribed listeners (Requirement 5.1)
    this.notifyListeners(validatedEvent);

    // Deliver push notifications for terminal/attention statuses
    // (Requirements 5.3, 5.4, 5.6)
    if (this.shouldPushNotification(validatedEvent.status)) {
      const notification = this.buildNotification(validatedEvent);
      this.deliverNotification(notification);
    }

    // Warn if emission took longer than deadline (Requirement 5.2)
    const elapsed = Date.now() - startTime;
    if (elapsed > this.config.emitDeadlineMs) {
      console.warn(
        `[AgentStatusFeed] Event emission exceeded ${this.config.emitDeadlineMs}ms deadline: ${elapsed}ms`,
      );
    }
  }

  /**
   * Subscribe to the real-time event stream. Returns an unsubscribe
   * function for cleanup.
   *
   * Requirement 5.1: Real-time event stream of status updates.
   */
  subscribe(listener: (event: AgentStatusEvent) => void): () => void {
    // Null-check guard: return a no-op unsubscribe when disabled
    if (!this.featureGate.isEnabled('agent_status_feed')) {
      return () => {};
    }

    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Get all currently active (non-terminal) status events.
   *
   * Requirement 5.1: Real-time visibility into all active agent sessions.
   */
  getActiveStatuses(): AgentStatusEvent[] {
    // Null-check guard: return empty array when disabled
    if (!this.featureGate.isEnabled('agent_status_feed')) {
      return [];
    }

    return Array.from(this.activeStatuses.values());
  }

  // ─── Retry Queue Management ─────────────────────────────────────

  /**
   * Start the retry timer for queued notifications.
   * Called internally when a notification is queued.
   */
  private startRetryTimer(): void {
    if (this.retryTimer !== null) return;

    this.retryTimer = setInterval(() => {
      this.processRetryQueue();
    }, this.config.retryDelayMs);
  }

  /**
   * Stop the retry timer. Called when the queue is empty.
   */
  private stopRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Process queued notifications, attempting to deliver them.
   * Removes notifications that exceed max retries.
   *
   * Requirement 5.5: Queue notifications for retry if IPC unavailable.
   */
  private processRetryQueue(): void {
    if (this.notificationQueue.length === 0) {
      this.stopRetryTimer();
      return;
    }

    const remaining: QueuedNotification[] = [];

    for (const item of this.notificationQueue) {
      if (item.retryCount >= this.config.maxRetries) {
        // Max retries exceeded — log and discard
        console.warn(
          `[AgentStatusFeed] Notification delivery failed after ${this.config.maxRetries} retries, discarding.`,
          { sessionId: item.notification.sessionId, type: item.notification.type },
        );
        continue;
      }

      if (this.ipcSender && this.ipcSender.isAvailable()) {
        try {
          this.ipcSender.send(IPC_CHANNEL, item.notification);
          // Successfully delivered — do not re-queue
          continue;
        } catch {
          // Still unavailable — increment retry and re-queue
          item.retryCount++;
          remaining.push(item);
        }
      } else {
        // IPC still unavailable — increment retry and re-queue
        item.retryCount++;
        remaining.push(item);
      }
    }

    this.notificationQueue = remaining;

    if (this.notificationQueue.length === 0) {
      this.stopRetryTimer();
    }
  }

  /**
   * Get the current notification queue size. Useful for testing.
   */
  getQueueSize(): number {
    return this.notificationQueue.length;
  }

  /**
   * Dispose of the feed — stops retry timer and clears state.
   */
  dispose(): void {
    this.stopRetryTimer();
    this.listeners.clear();
    this.activeStatuses.clear();
    this.notificationQueue = [];
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Validate and enrich the event with required fields.
   * Ensures eventId and ISO 8601 timestamp are present.
   */
  private validateAndEnrichEvent(event: AgentStatusEvent): AgentStatusEvent {
    return {
      ...event,
      eventId: event.eventId || randomUUID(),
      timestamp: event.timestamp || new Date().toISOString(),
    };
  }

  /**
   * Update the active statuses map. Terminal statuses (completed, failed)
   * remove entries from active tracking.
   */
  private updateActiveStatuses(event: AgentStatusEvent): void {
    const key = `${event.sessionId}:${event.agentId}`;

    if (event.status === 'completed' || event.status === 'failed') {
      this.activeStatuses.delete(key);
    } else {
      this.activeStatuses.set(key, event);
    }
  }

  /**
   * Notify all registered listeners with the event.
   * Listeners that throw are caught and logged — they never
   * interrupt other listeners or the emission pipeline.
   */
  private notifyListeners(event: AgentStatusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[AgentStatusFeed] Listener threw: ${message}`);
      }
    }
  }

  /**
   * Determine if a status type should trigger a push notification.
   * Notifications are sent for: completed, failed, needs-attention.
   */
  private shouldPushNotification(status: AgentStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'needs-attention';
  }

  /**
   * Build a StatusNotification from an AgentStatusEvent.
   *
   * Requirement 5.4: Include error summary in failure notifications.
   * Requirement 5.6: Deliver needs-attention with context.
   */
  private buildNotification(event: AgentStatusEvent): StatusNotification {
    let type: StatusNotification['type'];
    let summary: string;

    switch (event.status) {
      case 'completed':
        type = 'completion';
        summary = event.message || `Agent ${event.agentId} completed successfully.`;
        break;
      case 'failed':
        type = 'failure';
        // Requirement 5.4: Include error summary
        summary = event.errorSummary || event.message || `Agent ${event.agentId} failed.`;
        break;
      case 'needs-attention':
        type = 'attention';
        // Requirement 5.6: Deliver needs-attention with context
        summary = event.message || `Agent ${event.agentId} requires attention.`;
        break;
      default:
        type = 'completion';
        summary = event.message || `Agent ${event.agentId} status: ${event.status}`;
    }

    return {
      type,
      sessionId: event.sessionId,
      agentId: event.agentId,
      summary,
      timestamp: event.timestamp,
    };
  }

  /**
   * Deliver a push notification to the renderer process via IPC.
   * Queues for retry if the channel is unavailable.
   *
   * Requirement 5.3: Deliver push notification via IPC on completion/failure.
   * Requirement 5.5: Queue for retry if IPC unavailable.
   */
  private deliverNotification(notification: StatusNotification): void {
    if (!this.ipcSender) {
      // No IPC sender configured — queue for retry
      this.queueNotification(notification);
      return;
    }

    if (!this.ipcSender.isAvailable()) {
      // IPC channel unavailable — queue for retry
      this.queueNotification(notification);
      return;
    }

    try {
      this.ipcSender.send(IPC_CHANNEL, notification);
    } catch {
      // Delivery failed — queue for retry
      this.queueNotification(notification);
    }
  }

  /**
   * Add a notification to the retry queue.
   * Respects maximum queue size to prevent unbounded growth.
   */
  private queueNotification(notification: StatusNotification): void {
    if (this.notificationQueue.length >= this.config.maxQueueSize) {
      // Queue full — discard oldest to make room
      this.notificationQueue.shift();
      console.warn(
        '[AgentStatusFeed] Notification queue full, discarded oldest notification.',
      );
    }

    this.notificationQueue.push({ notification, retryCount: 0 });
    this.startRetryTimer();
  }
}
