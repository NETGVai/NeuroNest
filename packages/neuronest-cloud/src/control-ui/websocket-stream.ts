/**
 * WebSocket Event Stream — Real-time event delivery for control panel
 *
 * Provides WebSocket-based event streaming for:
 * - Active session monitoring
 * - Action approval/rejection notifications
 * - Desktop app monitoring bridge
 *
 * Task 22.3
 */

import { WebSocket, WebSocketServer } from 'ws';
import * as http from 'http';
import { SessionManager, SessionEvent } from './session-manager';

// ─── Types ──────────────────────────────────────────────────────

export interface WSClient {
  ws: WebSocket;
  tenantId: string;
  subscribedSessions: Set<string>;
  connectedAt: number;
  lastPing: number;
}

export interface WSMessage {
  type: string;
  payload: Record<string, unknown>;
}

export interface WebSocketStreamConfig {
  path: string;
  pingInterval: number;      // ms between pings
  clientTimeout: number;     // ms before disconnecting unresponsive client
  maxClientsPerTenant: number;
}

// ─── WebSocket Event Stream ──────────────────────────────────────

export class WebSocketEventStream {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, WSClient>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private config: WebSocketStreamConfig;
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager, config: Partial<WebSocketStreamConfig> = {}) {
    this.sessionManager = sessionManager;
    this.config = {
      path: config.path ?? '/ws/control',
      pingInterval: config.pingInterval ?? 30_000,
      clientTimeout: config.clientTimeout ?? 60_000,
      maxClientsPerTenant: config.maxClientsPerTenant ?? 20,
    };
  }

  /**
   * Attach WebSocket server to an existing HTTP server.
   */
  attach(server: http.Server): void {
    this.wss = new WebSocketServer({
      server,
      path: this.config.path,
    });

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Subscribe to session events
    this.sessionManager.on('session_event', (event: SessionEvent) => {
      this.broadcastToTenant(event.tenantId, {
        type: event.type,
        payload: {
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          ...event.data,
        },
      });
    });

    // Start ping/pong heartbeat
    this.pingTimer = setInterval(() => this.heartbeat(), this.config.pingInterval);
  }

  /**
   * Handle new WebSocket connection.
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const tenantId = url.searchParams.get('tenantId');
    const token = url.searchParams.get('token');

    // Require tenant identification
    if (!tenantId) {
      ws.close(4001, 'Missing tenantId parameter');
      return;
    }

    // Check max clients per tenant
    const tenantClientCount = Array.from(this.clients.values())
      .filter(c => c.tenantId === tenantId).length;
    if (tenantClientCount >= this.config.maxClientsPerTenant) {
      ws.close(4002, 'Max connections per tenant exceeded');
      return;
    }

    const client: WSClient = {
      ws,
      tenantId,
      subscribedSessions: new Set(),
      connectedAt: Date.now(),
      lastPing: Date.now(),
    };

    this.clients.set(ws, client);

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const msg: WSMessage = JSON.parse(data.toString());
        this.handleClientMessage(client, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', payload: { message: 'Invalid message format' } }));
      }
    });

    ws.on('pong', () => {
      client.lastPing = Date.now();
    });

    ws.on('close', () => {
      this.clients.delete(ws);
    });

    ws.on('error', () => {
      this.clients.delete(ws);
    });

    // Send initial state: active sessions for this tenant
    const sessions = this.sessionManager.listSessions(tenantId);
    ws.send(JSON.stringify({
      type: 'initial_state',
      payload: { sessions, pendingActions: this.sessionManager.getPendingActions(tenantId) },
    }));
  }

  /**
   * Handle incoming client messages (subscribe, approve, reject, etc.)
   */
  private handleClientMessage(client: WSClient, msg: WSMessage): void {
    switch (msg.type) {
      case 'subscribe_session':
        if (typeof msg.payload.sessionId === 'string') {
          client.subscribedSessions.add(msg.payload.sessionId);
          client.ws.send(JSON.stringify({
            type: 'subscribed',
            payload: { sessionId: msg.payload.sessionId },
          }));
        }
        break;

      case 'unsubscribe_session':
        if (typeof msg.payload.sessionId === 'string') {
          client.subscribedSessions.delete(msg.payload.sessionId);
        }
        break;

      case 'approve_action':
        if (typeof msg.payload.actionId === 'string') {
          const approved = this.sessionManager.approveAction(
            msg.payload.actionId,
            client.tenantId
          );
          client.ws.send(JSON.stringify({
            type: 'action_response',
            payload: { actionId: msg.payload.actionId, approved },
          }));
        }
        break;

      case 'reject_action':
        if (typeof msg.payload.actionId === 'string') {
          const rejected = this.sessionManager.rejectAction(
            msg.payload.actionId,
            client.tenantId,
            msg.payload.reason as string | undefined
          );
          client.ws.send(JSON.stringify({
            type: 'action_response',
            payload: { actionId: msg.payload.actionId, rejected },
          }));
        }
        break;

      case 'ping':
        client.ws.send(JSON.stringify({ type: 'pong', payload: { timestamp: Date.now() } }));
        break;

      default:
        client.ws.send(JSON.stringify({
          type: 'error',
          payload: { message: `Unknown message type: ${msg.type}` },
        }));
    }
  }

  /**
   * Broadcast a message to all connected clients of a tenant.
   */
  private broadcastToTenant(tenantId: string, msg: WSMessage): void {
    for (const [, client] of this.clients) {
      if (client.tenantId === tenantId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify(msg));
      }
    }
  }

  /**
   * Heartbeat — ping all clients and disconnect unresponsive ones.
   */
  private heartbeat(): void {
    const now = Date.now();
    for (const [ws, client] of this.clients) {
      if (now - client.lastPing > this.config.clientTimeout) {
        ws.terminate();
        this.clients.delete(ws);
        continue;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }

  /**
   * Get connected client count.
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get client count by tenant.
   */
  getClientCountByTenant(tenantId: string): number {
    return Array.from(this.clients.values()).filter(c => c.tenantId === tenantId).length;
  }

  /**
   * Shutdown the WebSocket stream.
   */
  shutdown(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    for (const [ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
