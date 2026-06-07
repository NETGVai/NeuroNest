/**
 * Typed Action/Observation Event Stream — OpenHands-inspired event architecture.
 *
 * Provides a central hub for typed events flowing between Agent, Runtime, and Frontend.
 * Actions represent requests (edit file, run command, send message).
 * Observations represent results (file contents, command output, errors).
 *
 * Integrates with the existing EventBus for persistence and replay,
 * but adds typed Action/Observation semantics on top.
 */

// ─── Event Types ────────────────────────────────────────────────

export type ActionType =
  | 'shell_command'
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'code_execute'
  | 'message_send'
  | 'tool_call'
  | 'agent_delegate'
  | 'browser_navigate'
  | 'search_query';

export type ObservationType =
  | 'command_output'
  | 'file_content'
  | 'file_write_result'
  | 'code_output'
  | 'message_received'
  | 'tool_result'
  | 'agent_response'
  | 'error'
  | 'status_update';

export interface ActionEvent {
  id: string;
  type: 'action';
  actionType: ActionType;
  agentId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  securityRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  timestamp: number;
  parentId?: string; // For chained actions
}

export interface ObservationEvent {
  id: string;
  type: 'observation';
  observationType: ObservationType;
  actionId: string; // Links back to the action that caused this
  agentId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  success: boolean;
  timestamp: number;
  durationMs?: number;
}

export type StreamEvent = ActionEvent | ObservationEvent;

export interface EventFilter {
  agentId?: string;
  sessionId?: string;
  actionType?: ActionType;
  observationType?: ObservationType;
  since?: number;
  limit?: number;
}

export type EventCallback = (event: StreamEvent) => void;

// ─── Action/Observation Event Stream ────────────────────────────

export class ActionEventStream {
  private events: StreamEvent[] = [];
  private listeners: Map<string, EventCallback[]> = new Map();
  private maxEvents: number;

  constructor(maxEvents: number = 10000) {
    this.maxEvents = maxEvents;
  }

  /**
   * Publish an action event. Returns the event ID.
   */
  publishAction(
    actionType: ActionType,
    agentId: string,
    sessionId: string,
    payload: Record<string, unknown>,
    securityRisk?: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN',
    parentId?: string,
  ): string {
    const event: ActionEvent = {
      id: this.generateId(),
      type: 'action',
      actionType,
      agentId,
      sessionId,
      payload,
      securityRisk,
      timestamp: Date.now(),
      parentId,
    };

    this.addEvent(event);
    this.notify('action', event);
    this.notify(`action:${actionType}`, event);
    this.notify('*', event);

    return event.id;
  }

  /**
   * Publish an observation event linked to an action.
   */
  publishObservation(
    observationType: ObservationType,
    actionId: string,
    agentId: string,
    sessionId: string,
    payload: Record<string, unknown>,
    success: boolean,
    durationMs?: number,
  ): string {
    const event: ObservationEvent = {
      id: this.generateId(),
      type: 'observation',
      observationType,
      actionId,
      agentId,
      sessionId,
      payload,
      success,
      timestamp: Date.now(),
      durationMs,
    };

    this.addEvent(event);
    this.notify('observation', event);
    this.notify(`observation:${observationType}`, event);
    this.notify('*', event);

    return event.id;
  }

  /**
   * Subscribe to events by topic.
   * Topics: 'action', 'observation', 'action:{type}', 'observation:{type}', '*'
   */
  on(topic: string, callback: EventCallback): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, []);
    }
    this.listeners.get(topic)!.push(callback);

    // Return unsubscribe function
    return () => {
      const callbacks = this.listeners.get(topic);
      if (callbacks) {
        const idx = callbacks.indexOf(callback);
        if (idx >= 0) callbacks.splice(idx, 1);
      }
    };
  }

  /**
   * Get the observation for a given action ID.
   */
  getObservationForAction(actionId: string): ObservationEvent | undefined {
    return this.events.find(
      (e): e is ObservationEvent => e.type === 'observation' && (e as ObservationEvent).actionId === actionId
    ) as ObservationEvent | undefined;
  }

  /**
   * Query events with filters.
   */
  query(filter: EventFilter): StreamEvent[] {
    let results = this.events;

    if (filter.agentId) results = results.filter(e => e.agentId === filter.agentId);
    if (filter.sessionId) results = results.filter(e => e.sessionId === filter.sessionId);
    if (filter.since) results = results.filter(e => e.timestamp >= filter.since!);
    if (filter.actionType) results = results.filter(e => e.type === 'action' && (e as ActionEvent).actionType === filter.actionType);
    if (filter.observationType) results = results.filter(e => e.type === 'observation' && (e as ObservationEvent).observationType === filter.observationType);
    if (filter.limit) results = results.slice(-filter.limit);

    return results;
  }

  /**
   * Get conversation history for an agent session (actions + observations in order).
   */
  getConversationHistory(sessionId: string, limit?: number): StreamEvent[] {
    const events = this.events.filter(e => e.sessionId === sessionId);
    return limit ? events.slice(-limit) : events;
  }

  /**
   * Get stats about the event stream.
   */
  getStats(): {
    totalEvents: number;
    actions: number;
    observations: number;
    successRate: number;
    avgDurationMs: number;
  } {
    const actions = this.events.filter(e => e.type === 'action').length;
    const observations = this.events.filter((e): e is ObservationEvent => e.type === 'observation');
    const successful = observations.filter(o => o.success).length;
    const durations = observations.filter(o => o.durationMs !== undefined).map(o => o.durationMs!);
    const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

    return {
      totalEvents: this.events.length,
      actions,
      observations: observations.length,
      successRate: observations.length > 0 ? successful / observations.length : 1,
      avgDurationMs: Math.round(avgDuration),
    };
  }

  /**
   * Clear all events.
   */
  clear(): void {
    this.events = [];
  }

  // ─── Private ────────────────────────────────────────────────

  private addEvent(event: StreamEvent): void {
    this.events.push(event);
    // Trim old events if over limit
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-Math.floor(this.maxEvents * 0.8));
    }
  }

  private notify(topic: string, event: StreamEvent): void {
    const callbacks = this.listeners.get(topic);
    if (callbacks) {
      for (const cb of callbacks) {
        try { cb(event); } catch (e) { console.error('[ActionEventStream] Listener error:', e); }
      }
    }
  }

  private generateId(): string {
    return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}
