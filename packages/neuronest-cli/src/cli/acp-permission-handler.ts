// File: packages/neuronest-cli/src/cli/acp-permission-handler.ts
//
// ACP Permission Handler — Bridges authorization 'ask' decisions to
// ACP `agent/permission_request` notifications and resolves them from
// incoming `agent/permission_response` messages.
//
// When the AuthorizationPipeline returns an 'ask' verdict, this handler
// sends a JSON-RPC notification to the client with tool details and risk
// level, then awaits the client's permission response or times out.
//
// Protocol:
//   Server → Client: agent/permission_request (notification)
//     { requestId, toolName, args, riskLevel, reason, sessionId, timestamp }
//   Client → Server: agent/permission_response (notification)
//     { requestId, approved: boolean }
//
// Validates: Requirements 16.7, 16.8 (mapped to Req 20.5, 20.6)

import { randomUUID } from 'node:crypto';
import type { RiskLevel } from '../../../../src/shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

/** Payload sent to the client as an `agent/permission_request` notification. */
export interface PermissionRequestPayload {
  requestId: string;
  toolName: string;
  args: unknown;
  riskLevel: RiskLevel;
  reason: string;
  sessionId: string;
  timestamp: string;
}

/** Payload received from the client as an `agent/permission_response` notification. */
export interface PermissionResponsePayload {
  requestId: string;
  approved: boolean;
}

/** Function that sends a JSON-RPC notification through the ACP transport. */
export type NotificationSender = (method: string, params: Record<string, unknown>) => void;

/** Internal pending request state. */
interface PendingRequest {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Configuration ──────────────────────────────────────────────

export interface ACPPermissionHandlerConfig {
  /** Function to send notifications to the client. */
  sendNotification: NotificationSender;
  /** Timeout in milliseconds before auto-deny (default: 60000). */
  timeoutMs?: number;
  /** Session ID for the current ACP session. */
  sessionId: string;
}

// ─── ACP Permission Handler ─────────────────────────────────────

/**
 * Manages ACP permission request/response lifecycle.
 *
 * Usage:
 *   1. Create an instance with a notification sender and session ID.
 *   2. Use `createApprovalHandler()` to get a function compatible with
 *      ToolContext.approvalHandler.
 *   3. Route incoming `agent/permission_response` messages through
 *      `handlePermissionResponse()`.
 *
 * The handler supports multiple concurrent permission requests, each
 * identified by a unique requestId. Unanswered requests auto-deny
 * after the configured timeout (default 60s, Req 20.6).
 */
export class ACPPermissionHandler {
  private readonly sendNotification: NotificationSender;
  private readonly timeoutMs: number;
  private readonly sessionId: string;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(config: ACPPermissionHandlerConfig) {
    this.sendNotification = config.sendNotification;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.sessionId = config.sessionId;
  }

  /**
   * Request permission from the ACP client for a tool execution.
   *
   * Sends an `agent/permission_request` notification and waits for
   * the matching `agent/permission_response`. Times out with auto-deny
   * after the configured interval.
   *
   * @param toolName - The name of the tool requesting permission
   * @param args - The tool arguments
   * @param riskLevel - The assessed risk level
   * @param reason - Human-readable reason for the ask
   * @returns Promise resolving to true (approved) or false (denied/timeout)
   */
  async requestPermission(
    toolName: string,
    args: unknown,
    riskLevel: RiskLevel,
    reason: string,
  ): Promise<boolean> {
    // Zero timeout means immediate denial (Req 20.6)
    if (this.timeoutMs === 0) {
      return false;
    }

    const requestId = randomUUID();
    const timestamp = new Date().toISOString();

    const payload: PermissionRequestPayload = {
      requestId,
      toolName,
      args,
      riskLevel,
      reason,
      sessionId: this.sessionId,
      timestamp,
    };

    // Create the pending promise before sending notification
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Auto-deny on timeout (Req 20.6)
        this.pending.delete(requestId);
        resolve(false);
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timer });
    });

    // Send the permission request notification to the client
    this.sendNotification('agent/permission_request', payload as unknown as Record<string, unknown>);

    return result;
  }

  /**
   * Creates an approvalHandler function compatible with ToolContext.
   *
   * The returned function translates a command string into a full
   * permission request with the provided context defaults.
   *
   * @param defaultRiskLevel - Default risk level when not specified
   * @returns An approval handler function for ToolContext
   */
  createApprovalHandler(defaultRiskLevel: RiskLevel = 'execute'): (command: string) => Promise<boolean> {
    return async (command: string): Promise<boolean> => {
      return this.requestPermission(
        'shell',
        { command },
        defaultRiskLevel,
        `Tool execution requires approval: ${command}`,
      );
    };
  }

  /**
   * Handle an incoming `agent/permission_response` message from the client.
   *
   * This should be called from the ACP server's message router when
   * it receives a message with method `agent/permission_response`.
   *
   * @param params - The response parameters containing requestId and approved
   * @returns true if the response matched a pending request, false otherwise
   */
  handlePermissionResponse(params: PermissionResponsePayload): boolean {
    const { requestId, approved } = params;

    const pending = this.pending.get(requestId);
    if (!pending) {
      // No matching pending request (already timed out or invalid requestId)
      return false;
    }

    // Clear the timeout and resolve the promise
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(approved);
    return true;
  }

  /**
   * Get the number of currently pending permission requests.
   * Useful for diagnostics and testing.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Cancel all pending requests with auto-deny.
   * Called during session teardown or server shutdown.
   */
  cancelAll(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.pending.delete(requestId);
    }
  }

  /**
   * Cancel a specific pending request by ID with auto-deny.
   *
   * @param requestId - The request ID to cancel
   * @returns true if the request was found and cancelled, false otherwise
   */
  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(false);
    return true;
  }
}
