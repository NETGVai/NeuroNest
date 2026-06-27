/**
 * Agent Status Feed — Interfaces for real-time agent status broadcasting.
 *
 * Provides a pub/sub mechanism for agent lifecycle status events with
 * push notification delivery to the renderer process via IPC.
 *
 * Requirements: 5.1–5.8
 */

// Dependencies: CallbackEngine (used at implementation time)

// ─── Types ──────────────────────────────────────────────────────

/** Status event types */
export type AgentStatus = 'started' | 'progressing' | 'completed' | 'failed' | 'needs-attention';

/** A single status event */
export interface AgentStatusEvent {
  eventId: string;
  sessionId: string;
  agentId: string;
  status: AgentStatus;
  iteration: number;
  timestamp: string;
  message?: string;
  errorSummary?: string;
  context?: Record<string, unknown>;
}

/** Push notification payload */
export interface StatusNotification {
  type: 'completion' | 'failure' | 'attention';
  sessionId: string;
  agentId: string;
  summary: string;
  timestamp: string;
}

/** Agent Status Feed interface */
export interface IAgentStatusFeed {
  emit(event: AgentStatusEvent): Promise<void>;
  subscribe(listener: (event: AgentStatusEvent) => void): () => void;
  getActiveStatuses(): AgentStatusEvent[];
}
