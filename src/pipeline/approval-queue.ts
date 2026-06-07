/**
 * Approval Queue — Human-in-the-loop action approval.
 *
 * Every file change and terminal command requires explicit user approval
 * before execution. Shows a preview of what will change.
 * Users can approve, reject, or edit before proceeding.
 *
 * 12-factor-agent-improvements task 13 wires `approval.created` and
 * `approval.decided` Pipeline_Events from the `request*` / `decide*` (here:
 * `approve` / `reject`) methods. The wiring is:
 *   - EventLog is an OPTIONAL constructor dependency. The class still
 *     functions identically when no log is supplied (existing tests, the
 *     IPC handler in `src/main/ipc.ts`, etc.), keeping Requirement 4.6
 *     (no breaking changes) intact.
 *   - Emits are gated by `PERF_FLAGS.UNIFIED_EVENT_LOG ||
 *     PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW`. In Phase 0 the shadow flag is
 *     `true` so events flow into the log even though the reducer's output
 *     does not yet reach the prompt. Phase 1 keeps emits on; Phase 2
 *     deletes the shadow flag and inlines the active branch.
 *   - All emit calls are wrapped in fail-soft try/catch — a logging
 *     failure must never block the approval flow.
 *   - Per design.md "Event kinds":
 *       approval.created → { approvalId, prompt, kind }
 *       approval.decided → { approvalId, decision }
 *     `prompt` maps to the request's `description`, `kind` maps to the
 *     request's `type`, `decision` is one of `approved | rejected | edited`
 *     (the same vocabulary already used on the in-memory record's
 *     `status` field).
 *   - `sessionId` is an OPTIONAL field on the request payload. The
 *     `Approval_Queue` is in-memory only (Requirement 6.8 calls this out)
 *     so historically there has been no session pin on these records.
 *     When present we route the emit with that id; when absent we skip
 *     the emit silently — a logged but session-less approval is
 *     unactionable for the reducer.
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';
import type { EventLog, EventKind } from './event-log.js';

export type ApprovalActionType = 'file_write' | 'file_delete' | 'terminal' | 'file_create';

export interface ApprovalRequest {
  id: string;
  type: ApprovalActionType;
  agentId: string;
  projectId: string;
  description: string;
  /**
   * Optional session id for Pipeline_Event emission. Approvals are
   * in-memory only so this is not persisted alongside the record; when
   * present, it routes the `approval.created` / `approval.decided` events
   * through the EventLog. When absent the events are skipped.
   */
  sessionId?: string;
  // For file operations
  filePath?: string;
  originalContent?: string;
  proposedContent?: string;
  // For terminal
  command?: string;
  // Status
  status: 'pending' | 'approved' | 'rejected' | 'edited';
  editedContent?: string;
  createdAt: number;
  resolvedAt?: number;
}

export class ApprovalQueue {
  private queue: Map<string, ApprovalRequest> = new Map();
  private resolvers: Map<string, (result: { approved: boolean; editedContent?: string }) => void> = new Map();
  private readonly eventLog: EventLog | null;

  constructor(eventLog?: EventLog | null) {
    this.eventLog = eventLog ?? null;
  }

  /**
   * Submit an action for approval. Returns a promise that resolves
   * when the user approves or rejects.
   */
  async requestApproval(request: Omit<ApprovalRequest, 'id' | 'status' | 'createdAt'>): Promise<{ approved: boolean; editedContent?: string }> {
    const id = `approval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const fullRequest: ApprovalRequest = {
      ...request, id, status: 'pending', createdAt: Date.now(),
    };

    this.queue.set(id, fullRequest);

    // Pipeline_Event emission for `approval.created` (Requirement 2.6).
    this.emitEvent(fullRequest.sessionId, 'approval.created', {
      approvalId: id,
      prompt: fullRequest.description,
      kind: fullRequest.type,
    });

    return new Promise((resolve) => {
      this.resolvers.set(id, resolve);
    });
  }

  /**
   * Approve a pending request.
   */
  approve(requestId: string, editedContent?: string): boolean {
    const request = this.queue.get(requestId);
    if (!request || request.status !== 'pending') return false;

    request.status = editedContent ? 'edited' : 'approved';
    request.editedContent = editedContent;
    request.resolvedAt = Date.now();

    const resolver = this.resolvers.get(requestId);
    if (resolver) {
      resolver({ approved: true, editedContent });
      this.resolvers.delete(requestId);
    }

    // Pipeline_Event emission for `approval.decided` (Requirement 2.6).
    this.emitEvent(request.sessionId, 'approval.decided', {
      approvalId: request.id,
      decision: request.status,
    });

    return true;
  }

  /**
   * Reject a pending request.
   */
  reject(requestId: string): boolean {
    const request = this.queue.get(requestId);
    if (!request || request.status !== 'pending') return false;

    request.status = 'rejected';
    request.resolvedAt = Date.now();

    const resolver = this.resolvers.get(requestId);
    if (resolver) {
      resolver({ approved: false });
      this.resolvers.delete(requestId);
    }

    // Pipeline_Event emission for `approval.decided` (Requirement 2.6).
    this.emitEvent(request.sessionId, 'approval.decided', {
      approvalId: request.id,
      decision: request.status,
    });

    return true;
  }

  /**
   * Get all pending requests.
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.queue.values()).filter(r => r.status === 'pending');
  }

  /**
   * Get a specific request.
   */
  getRequest(requestId: string): ApprovalRequest | null {
    return this.queue.get(requestId) || null;
  }

  /**
   * Get recent history.
   */
  getHistory(limit: number = 20): ApprovalRequest[] {
    return Array.from(this.queue.values())
      .filter(r => r.status !== 'pending')
      .sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))
      .slice(0, limit);
  }

  /**
   * Get stats.
   */
  getStats(): { pending: number; approved: number; rejected: number; total: number } {
    const all = Array.from(this.queue.values());
    return {
      pending: all.filter(r => r.status === 'pending').length,
      approved: all.filter(r => r.status === 'approved' || r.status === 'edited').length,
      rejected: all.filter(r => r.status === 'rejected').length,
      total: all.length,
    };
  }

  /**
   * Clear old resolved requests.
   */
  clearOld(maxAge: number = 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAge;
    for (const [id, req] of this.queue) {
      if (req.status !== 'pending' && (req.resolvedAt || 0) < cutoff) {
        this.queue.delete(id);
      }
    }
  }

  /**
   * Fail-soft Pipeline_Event emit. Skipped when:
   *   - no EventLog was supplied at construction (legacy callers), OR
   *   - the request has no `sessionId` (the reducer keys off sessionId
   *     and an unkeyed event would never resurface), OR
   *   - both the active and shadow flag are off (Phase 2 cleanup pre-
   *     condition; this branch becomes unreachable once the shadow flag
   *     is removed in task 39).
   *
   * Any thrown error from the EventLog is logged at warn level and
   * swallowed — the approval flow is the primary user-visible path and
   * MUST NOT regress because telemetry failed.
   */
  private emitEvent(sessionId: string | undefined, kind: EventKind, payload: unknown): void {
    if (!this.eventLog) return;
    if (!sessionId) return;
    if (!PERF_FLAGS.UNIFIED_EVENT_LOG && !PERF_FLAGS.UNIFIED_EVENT_LOG_SHADOW) return;

    try {
      // Fire-and-forget; the EventLog buffers internally and flushes on
      // its own 100ms timer. We deliberately do not await.
      void this.eventLog.emit({ sessionId, kind, payload });
    } catch (err) {
      // Defensive: `emit` itself returns `Promise.resolve()` after an
      // in-memory enqueue, so this branch only fires on truly exotic
      // errors (e.g. constructing the payload threw). Either way, the
      // approval flow continues.
      console.warn('[approval-queue] event emit failed:', (err as Error)?.message);
    }
  }
}
