/**
 * IDEBridge — Bidirectional IDE communication, session sync.
 *
 * Stub implementation with in-memory state. Manages IDE client connections,
 * JSON-based messaging, session synchronization, and message queuing.
 *
 * Requirements: 18.1–18.9
 */

import { randomUUID } from 'node:crypto';
import type { IDEMessage } from '../shared/types.js';

// ─── Types ──────────────────────────────────────────────────────

export type IDEType = 'vscode' | 'jetbrains' | 'xcode';

export interface IDEClient {
  id: string;
  ideType: IDEType;
  connectedAt: Date;
  connected: boolean;
}

// ─── IDEBridge ──────────────────────────────────────────────────

export class IDEBridge {
  private clients = new Map<string, IDEClient>();
  private messageQueues = new Map<string, IDEMessage[]>(); // clientId -> queued messages
  private running = false;
  private port = 0;

  private connectCallbacks: Array<(client: IDEClient) => void> = [];
  private disconnectCallbacks: Array<(clientId: string) => void> = [];
  private messageCallbacks: Array<(clientId: string, message: IDEMessage) => void> = [];
  private sentMessages: Array<{ clientId: string; message: IDEMessage }> = [];

  /**
   * Start the IDE bridge server.
   * Requirements: 18.1
   */
  startServer(port: number): void {
    if (this.running) throw new Error('Server already running');
    this.port = port;
    this.running = true;
  }

  /**
   * Stop the IDE bridge server.
   */
  stopServer(): void {
    this.running = false;
    // Disconnect all clients
    for (const [clientId, client] of this.clients) {
      client.connected = false;
      for (const cb of this.disconnectCallbacks) {
        cb(clientId);
      }
    }
  }

  /**
   * Get all connected clients.
   * Requirements: 18.2, 18.3, 18.4
   */
  getConnectedClients(): IDEClient[] {
    return Array.from(this.clients.values()).filter((c) => c.connected);
  }

  /**
   * Simulate a client connection (for testing).
   */
  simulateConnect(ideType: IDEType): IDEClient {
    const client: IDEClient = {
      id: randomUUID(),
      ideType,
      connectedAt: new Date(),
      connected: true,
    };
    this.clients.set(client.id, client);
    this.messageQueues.set(client.id, []);

    for (const cb of this.connectCallbacks) {
      cb(client);
    }

    return client;
  }

  /**
   * Simulate a client disconnection.
   * Requirements: 18.9
   */
  simulateDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);
    client.connected = false;

    for (const cb of this.disconnectCallbacks) {
      cb(clientId);
    }
  }

  /**
   * Simulate reconnection — delivers queued messages.
   * Requirements: 18.9
   */
  simulateReconnect(clientId: string): IDEMessage[] {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);
    client.connected = true;

    // Deliver queued messages
    const queued = this.messageQueues.get(clientId) ?? [];
    this.messageQueues.set(clientId, []);

    for (const cb of this.connectCallbacks) {
      cb(client);
    }

    return queued;
  }

  /**
   * Register a connection callback.
   */
  onConnect(callback: (client: IDEClient) => void): void {
    this.connectCallbacks.push(callback);
  }

  /**
   * Register a disconnection callback.
   */
  onDisconnect(callback: (clientId: string) => void): void {
    this.disconnectCallbacks.push(callback);
  }

  /**
   * Register a message callback.
   */
  onMessage(callback: (clientId: string, message: IDEMessage) => void): void {
    this.messageCallbacks.push(callback);
  }

  /**
   * Send a message to a specific client.
   * If client is disconnected, queue the message.
   * Requirements: 18.9
   */
  sendMessage(clientId: string, message: IDEMessage): void {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client not found: ${clientId}`);

    if (!client.connected) {
      // Queue for reconnection recovery
      const queue = this.messageQueues.get(clientId) ?? [];
      queue.push(message);
      this.messageQueues.set(clientId, queue);
      return;
    }

    this.sentMessages.push({ clientId, message });
  }

  /**
   * Broadcast a message to all connected clients.
   */
  broadcastMessage(message: IDEMessage): void {
    for (const [clientId, client] of this.clients) {
      if (client.connected) {
        this.sentMessages.push({ clientId, message });
      } else {
        const queue = this.messageQueues.get(clientId) ?? [];
        queue.push(message);
        this.messageQueues.set(clientId, queue);
      }
    }
  }

  /**
   * Simulate receiving a message from a client.
   */
  simulateIncomingMessage(clientId: string, message: IDEMessage): void {
    for (const cb of this.messageCallbacks) {
      cb(clientId, message);
    }
  }

  /**
   * Get sent messages (for testing).
   */
  getSentMessages(): Array<{ clientId: string; message: IDEMessage }> {
    return [...this.sentMessages];
  }

  /**
   * Check if server is running.
   */
  isRunning(): boolean {
    return this.running;
  }
}
