/**
 * Session Manager — Active session tracking with real-time updates
 *
 * Manages cloud agent sessions, provides real-time status updates,
 * and supports approval/rejection of pending actions.
 *
 * Task 22.3
 */

import { EventEmitter } from 'events';

// ─── Types ──────────────────────────────────────────────────────

export type SessionState = 'active' | 'paused' | 'waiting_approval' | 'completed' | 'failed';

export interface AgentSession {
  id: string;
  tenantId: string;
  projectId: string;
  taskId: string;
  state: SessionState;
  startedAt: number;
  updatedAt: number;
  currentStep?: string;
  progress: number;  // 0-100
  pendingAction?: PendingAction;
  metadata: Record<string, unknown>;
}

export interface PendingAction {
  id: string;
  sessionId: string;
  type: string;
  description: string;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt?: number;
  status: 'pending' | 'approved' | 'rejected';
}

export interface SessionEvent {
  type: 'session_created' | 'session_updated' | 'session_completed' |
        'action_pending' | 'action_resolved' | 'progress_update';
  sessionId: string;
  tenantId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

// ─── Session Manager ─────────────────────────────────────────────

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private pendingActions = new Map<string, PendingAction>();

  /**
   * Create a new agent session.
   */
  createSession(
    id: string,
    tenantId: string,
    projectId: string,
    taskId: string,
    metadata: Record<string, unknown> = {}
  ): AgentSession {
    const session: AgentSession = {
      id,
      tenantId,
      projectId,
      taskId,
      state: 'active',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progress: 0,
      metadata,
    };

    this.sessions.set(id, session);
    this.emitEvent({
      type: 'session_created',
      sessionId: id,
      tenantId,
      timestamp: Date.now(),
      data: { taskId, projectId },
    });

    return session;
  }

  /**
   * Get a session by ID (tenant-isolated).
   */
  getSession(sessionId: string, tenantId: string): AgentSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId) {
      return null;
    }
    return session;
  }

  /**
   * List all active sessions for a tenant.
   */
  listSessions(tenantId: string): AgentSession[] {
    return Array.from(this.sessions.values())
      .filter(s => s.tenantId === tenantId);
  }

  /**
   * Update session progress.
   */
  updateProgress(sessionId: string, progress: number, currentStep?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.progress = Math.min(100, Math.max(0, progress));
    session.updatedAt = Date.now();
    if (currentStep) {
      session.currentStep = currentStep;
    }

    this.emitEvent({
      type: 'progress_update',
      sessionId,
      tenantId: session.tenantId,
      timestamp: Date.now(),
      data: { progress: session.progress, currentStep },
    });
  }

  /**
   * Request approval for a pending action.
   */
  requestApproval(
    sessionId: string,
    actionId: string,
    type: string,
    description: string,
    payload: Record<string, unknown>,
    expiresInMs?: number
  ): PendingAction | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const action: PendingAction = {
      id: actionId,
      sessionId,
      type,
      description,
      payload,
      createdAt: Date.now(),
      expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
      status: 'pending',
    };

    this.pendingActions.set(actionId, action);
    session.state = 'waiting_approval';
    session.pendingAction = action;
    session.updatedAt = Date.now();

    this.emitEvent({
      type: 'action_pending',
      sessionId,
      tenantId: session.tenantId,
      timestamp: Date.now(),
      data: { actionId, type, description },
    });

    return action;
  }

  /**
   * Approve a pending action.
   */
  approveAction(actionId: string, tenantId: string): boolean {
    const action = this.pendingActions.get(actionId);
    if (!action) return false;

    const session = this.sessions.get(action.sessionId);
    if (!session || session.tenantId !== tenantId) return false;

    action.status = 'approved';
    session.state = 'active';
    session.pendingAction = undefined;
    session.updatedAt = Date.now();

    this.emitEvent({
      type: 'action_resolved',
      sessionId: session.id,
      tenantId,
      timestamp: Date.now(),
      data: { actionId, resolution: 'approved' },
    });

    return true;
  }

  /**
   * Reject a pending action.
   */
  rejectAction(actionId: string, tenantId: string, reason?: string): boolean {
    const action = this.pendingActions.get(actionId);
    if (!action) return false;

    const session = this.sessions.get(action.sessionId);
    if (!session || session.tenantId !== tenantId) return false;

    action.status = 'rejected';
    session.state = 'active';
    session.pendingAction = undefined;
    session.updatedAt = Date.now();

    this.emitEvent({
      type: 'action_resolved',
      sessionId: session.id,
      tenantId,
      timestamp: Date.now(),
      data: { actionId, resolution: 'rejected', reason },
    });

    return true;
  }

  /**
   * Complete a session.
   */
  completeSession(sessionId: string, result?: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state = 'completed';
    session.progress = 100;
    session.updatedAt = Date.now();

    this.emitEvent({
      type: 'session_completed',
      sessionId,
      tenantId: session.tenantId,
      timestamp: Date.now(),
      data: { result },
    });
  }

  /**
   * Fail a session.
   */
  failSession(sessionId: string, error: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state = 'failed';
    session.updatedAt = Date.now();
    session.metadata.error = error;

    this.emitEvent({
      type: 'session_completed',
      sessionId,
      tenantId: session.tenantId,
      timestamp: Date.now(),
      data: { error, failed: true },
    });
  }

  /**
   * Get pending actions for a tenant.
   */
  getPendingActions(tenantId: string): PendingAction[] {
    return Array.from(this.pendingActions.values())
      .filter(a => {
        const session = this.sessions.get(a.sessionId);
        return session?.tenantId === tenantId && a.status === 'pending';
      });
  }

  /**
   * Emit a session event to all listeners.
   */
  private emitEvent(event: SessionEvent): void {
    this.emit('session_event', event);
    this.emit(`tenant:${event.tenantId}`, event);
  }
}
