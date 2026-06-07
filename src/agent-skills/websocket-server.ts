/**
 * WebSocket Server for Agent Skills Real-time Updates
 * 
 * Integrates WebSocket server functionality into NeuroNest main process
 * and connects to Event Bus for real-time skill assignment updates.
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { EventBus, type Event } from '../events/event-bus.js';
import { logger } from '../utils/logger.js';
import type Database from 'better-sqlite3';

/**
 * WebSocket message types for real-time communication
 */
export interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping' | 'pong' | 'event';
  topics?: string[];
  data?: any;
  timestamp?: string;
  correlationId?: string;
}

/**
 * Client connection information
 */
interface ClientConnection {
  id: string;
  socket: WebSocket;
  subscribedTopics: Set<string>;
  lastPing: Date;
  sessionId?: string;
  userId?: string;
}

/**
 * WebSocket server configuration
 */
export interface WebSocketServerConfig {
  port?: number;
  host?: string;
  pingInterval?: number;
  connectionTimeout?: number;
  maxConnections?: number;
}

/**
 * WebSocket Server for real-time Agent Skills updates
 */
export class AgentSkillsWebSocketServer {
  private server: Server;
  private wss: WebSocketServer;
  private eventBus: EventBus;
  private clients = new Map<string, ClientConnection>();
  private config: Required<WebSocketServerConfig>;
  private pingInterval?: NodeJS.Timeout;
  private isRunning = false;

  constructor(database: Database.Database, config: WebSocketServerConfig = {}) {
    this.config = {
      port: config.port || 3001,
      host: config.host || 'localhost',
      pingInterval: config.pingInterval || 30000, // 30 seconds
      connectionTimeout: config.connectionTimeout || 60000, // 60 seconds
      maxConnections: config.maxConnections || 100
    };

    // Create HTTP server for WebSocket upgrade
    this.server = createServer();
    
    // Create WebSocket server
    this.wss = new WebSocketServer({ 
      server: this.server,
      path: '/agent-skills-ws'
    });

    // Initialize Event Bus
    this.eventBus = new EventBus({ database });

    this.setupWebSocketHandlers();
    this.setupEventBusSubscriptions();
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('WebSocket server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        this.startPingInterval();
        
        logger.info('Agent Skills WebSocket server started', {
          host: this.config.host,
          port: this.config.port,
          path: '/agent-skills-ws'
        });
        
        resolve();
      });

      this.server.on('error', (error) => {
        logger.error('WebSocket server error:', error);
        reject(error);
      });
    });
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Stop ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.socket.close(1000, 'Server shutting down');
    }
    this.clients.clear();

    // Close WebSocket server
    this.wss.close();

    // Close HTTP server
    return new Promise((resolve) => {
      this.server.close(() => {
        this.isRunning = false;
        logger.info('Agent Skills WebSocket server stopped');
        resolve();
      });
    });
  }

  /**
   * Setup WebSocket connection handlers
   */
  private setupWebSocketHandlers(): void {
    this.wss.on('connection', (socket, request) => {
      // Check connection limit
      if (this.clients.size >= this.config.maxConnections) {
        logger.warn('WebSocket connection rejected - max connections reached');
        socket.close(1013, 'Server overloaded');
        return;
      }

      const clientId = this.generateClientId();
      const client: ClientConnection = {
        id: clientId,
        socket,
        subscribedTopics: new Set(),
        lastPing: new Date()
      };

      this.clients.set(clientId, client);

      logger.info('WebSocket client connected', {
        clientId,
        remoteAddress: request.socket.remoteAddress,
        totalClients: this.clients.size
      });

      // Handle incoming messages
      socket.on('message', (data) => {
        this.handleClientMessage(client, Buffer.from(data as ArrayBuffer));
      });

      // Handle client disconnect
      socket.on('close', (code, reason) => {
        this.handleClientDisconnect(client, code, reason);
      });

      // Handle errors
      socket.on('error', (error) => {
        logger.error('WebSocket client error', {
          clientId,
          error: error.message
        });
      });

      // Send welcome message
      this.sendToClient(client, {
        type: 'event',
        data: {
          type: 'connection_established',
          clientId,
          timestamp: new Date().toISOString()
        }
      });
    });

    this.wss.on('error', (error) => {
      logger.error('WebSocket server error:', error);
    });
  }

  /**
   * Setup Event Bus subscriptions for real-time updates
   */
  private setupEventBusSubscriptions(): void {
    // Subscribe to all skill-related events
    const skillTopics = [
      'skill.created',
      'skill.updated',
      'skill.deleted',
      'skill.assigned',
      'skill.unassigned',
      'skill.performance.updated',
      'agent.skill.learned',
      'agent.skill.improved'
    ];

    skillTopics.forEach(topic => {
      this.eventBus.subscribe(topic, (event) => {
        this.broadcastEvent(topic, event);
      }, {
        ordered: true,
        persistent: false,
        retryOnFailure: false
      });
    });

    logger.info('Event Bus subscriptions established for WebSocket broadcasting', {
      topics: skillTopics
    });
  }

  /**
   * Handle incoming client messages
   */
  private handleClientMessage(client: ClientConnection, data: Buffer): void {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'subscribe':
          this.handleSubscribe(client, message);
          break;
          
        case 'unsubscribe':
          this.handleUnsubscribe(client, message);
          break;
          
        case 'ping':
          this.handlePing(client, message);
          break;
          
        default:
          logger.warn('Unknown WebSocket message type', {
            clientId: client.id,
            type: message.type
          });
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message', {
        clientId: client.id,
        error: error instanceof Error ? error.message : String(error)
      });
      
      this.sendToClient(client, {
        type: 'event',
        data: {
          type: 'error',
          message: 'Invalid message format'
        }
      });
    }
  }

  /**
   * Handle client subscription requests
   */
  private handleSubscribe(client: ClientConnection, message: WebSocketMessage): void {
    if (!message.topics || message.topics.length === 0) {
      this.sendToClient(client, {
        type: 'event',
        data: {
          type: 'error',
          message: 'No topics specified for subscription'
        }
      });
      return;
    }

    // Add topics to client subscription
    message.topics.forEach(topic => {
      client.subscribedTopics.add(topic);
    });

    logger.debug('Client subscribed to topics', {
      clientId: client.id,
      topics: message.topics,
      totalSubscriptions: client.subscribedTopics.size
    });

    // Send confirmation
    this.sendToClient(client, {
      type: 'event',
      data: {
        type: 'subscription_confirmed',
        topics: message.topics,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Handle client unsubscription requests
   */
  private handleUnsubscribe(client: ClientConnection, message: WebSocketMessage): void {
    if (!message.topics || message.topics.length === 0) {
      // Unsubscribe from all topics
      client.subscribedTopics.clear();
    } else {
      // Unsubscribe from specific topics
      message.topics.forEach(topic => {
        client.subscribedTopics.delete(topic);
      });
    }

    logger.debug('Client unsubscribed from topics', {
      clientId: client.id,
      topics: message.topics || ['all'],
      remainingSubscriptions: client.subscribedTopics.size
    });

    // Send confirmation
    this.sendToClient(client, {
      type: 'event',
      data: {
        type: 'unsubscription_confirmed',
        topics: message.topics || ['all'],
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Handle ping messages for connection health
   */
  private handlePing(client: ClientConnection, message: WebSocketMessage): void {
    client.lastPing = new Date();
    
    // Send pong response
    this.sendToClient(client, {
      type: 'pong',
      timestamp: new Date().toISOString(),
      correlationId: message.correlationId
    });
  }

  /**
   * Handle client disconnect
   */
  private handleClientDisconnect(client: ClientConnection, code: number, reason: Buffer): void {
    this.clients.delete(client.id);
    
    logger.info('WebSocket client disconnected', {
      clientId: client.id,
      code,
      reason: reason.toString(),
      totalClients: this.clients.size
    });
  }

  /**
   * Broadcast event to subscribed clients
   */
  private broadcastEvent(topic: string, event: Event): void {
    const message: WebSocketMessage = {
      type: 'event',
      data: {
        topic,
        event: {
          id: event.id,
          type: event.type,
          data: event.data,
          timestamp: event.timestamp.toISOString(),
          correlationId: event.correlationId,
          source: event.source
        }
      },
      timestamp: new Date().toISOString()
    };

    let broadcastCount = 0;
    
    for (const client of this.clients.values()) {
      // Check if client is subscribed to this topic
      if (client.subscribedTopics.has(topic) || client.subscribedTopics.has('*')) {
        if (this.sendToClient(client, message)) {
          broadcastCount++;
        }
      }
    }

    logger.debug('Event broadcasted to WebSocket clients', {
      topic,
      eventId: event.id,
      eventType: event.type,
      clientCount: broadcastCount
    });
  }

  /**
   * Send message to specific client
   */
  private sendToClient(client: ClientConnection, message: WebSocketMessage): boolean {
    try {
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(JSON.stringify(message));
        return true;
      } else {
        logger.debug('Cannot send to client - connection not open', {
          clientId: client.id,
          readyState: client.socket.readyState
        });
        return false;
      }
    } catch (error) {
      logger.error('Error sending message to client', {
        clientId: client.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  /**
   * Start ping interval for connection health monitoring
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = new Date();
      const staleClients: string[] = [];

      for (const [clientId, client] of this.clients.entries()) {
        const timeSinceLastPing = now.getTime() - client.lastPing.getTime();
        
        if (timeSinceLastPing > this.config.connectionTimeout) {
          // Client is stale - close connection
          staleClients.push(clientId);
          client.socket.close(1000, 'Connection timeout');
        } else if (timeSinceLastPing > this.config.pingInterval) {
          // Send ping to check if client is still alive
          this.sendToClient(client, {
            type: 'ping',
            timestamp: now.toISOString()
          });
        }
      }

      // Remove stale clients
      staleClients.forEach(clientId => {
        this.clients.delete(clientId);
      });

      if (staleClients.length > 0) {
        logger.info('Removed stale WebSocket clients', {
          count: staleClients.length,
          remainingClients: this.clients.size
        });
      }
    }, this.config.pingInterval);
  }

  /**
   * Generate unique client ID
   */
  private generateClientId(): string {
    return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get server statistics
   */
  getStats(): {
    isRunning: boolean;
    connectedClients: number;
    totalSubscriptions: number;
    serverConfig: Required<WebSocketServerConfig>;
  } {
    let totalSubscriptions = 0;
    for (const client of this.clients.values()) {
      totalSubscriptions += client.subscribedTopics.size;
    }

    return {
      isRunning: this.isRunning,
      connectedClients: this.clients.size,
      totalSubscriptions,
      serverConfig: this.config
    };
  }

  /**
   * Get connected clients information
   */
  getClients(): Array<{
    id: string;
    subscribedTopics: string[];
    lastPing: string;
    sessionId?: string;
    userId?: string;
  }> {
    return Array.from(this.clients.values()).map(client => ({
      id: client.id,
      subscribedTopics: Array.from(client.subscribedTopics),
      lastPing: client.lastPing.toISOString(),
      sessionId: client.sessionId,
      userId: client.userId
    }));
  }

  /**
   * Manually broadcast a message to all subscribed clients
   */
  broadcast(topic: string, data: any): void {
    const event: Event = {
      id: `manual_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'manual_broadcast',
      topic,
      data,
      timestamp: new Date(),
      source: 'websocket-server'
    };

    this.broadcastEvent(topic, event);
  }
}