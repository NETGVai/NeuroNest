/**
 * WebSocket Client for Agent Skills Real-time Updates
 * 
 * Provides client-side WebSocket connection management for real-time
 * skill assignment updates in the renderer process.
 * 
 * Requirements: 6.2, 6.3, 6.4
 */

/**
 * WebSocket message types (matching server)
 */
export interface WebSocketMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping' | 'pong' | 'event';
  topics?: string[];
  data?: any;
  timestamp?: string;
  correlationId?: string;
}

/**
 * Event handler type for WebSocket events
 */
export type WebSocketEventHandler = (data: any) => void;

/**
 * WebSocket client configuration
 */
export interface WebSocketClientConfig {
  url?: string;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  pingInterval?: number;
  connectionTimeout?: number;
}

/**
 * Connection state
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * WebSocket Client for Agent Skills real-time updates
 */
export class AgentSkillsWebSocketClient {
  private ws: WebSocket | null = null;
  private config: Required<WebSocketClientConfig>;
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private subscriptions = new Map<string, Set<WebSocketEventHandler>>();
  private reconnectAttempts = 0;
  private reconnectTimer?: number;
  private pingTimer?: number;
  private connectionTimer?: number;
  private eventHandlers = new Map<string, Set<(data: any) => void>>();

  constructor(config: WebSocketClientConfig = {}) {
    this.config = {
      url: config.url || 'ws://localhost:3001/agent-skills-ws',
      reconnectInterval: config.reconnectInterval || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      pingInterval: config.pingInterval || 30000,
      connectionTimeout: config.connectionTimeout || 10000
    };
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTED || this.state === ConnectionState.CONNECTING) {
      return;
    }

    this.state = ConnectionState.CONNECTING;
    this.emit('stateChange', this.state);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        // Connection timeout
        this.connectionTimer = window.setTimeout(() => {
          if (this.state === ConnectionState.CONNECTING) {
            this.ws?.close();
            this.handleConnectionError(new Error('Connection timeout'));
            reject(new Error('Connection timeout'));
          }
        }, this.config.connectionTimeout);

        this.ws.onopen = () => {
          if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
            this.connectionTimer = undefined;
          }

          this.state = ConnectionState.CONNECTED;
          this.reconnectAttempts = 0;
          this.startPingInterval();
          this.emit('stateChange', this.state);
          this.emit('connected');
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onclose = (event) => {
          this.handleDisconnect(event.code, event.reason);
        };

        this.ws.onerror = (error) => {
          this.handleConnectionError(error);
          if (this.state === ConnectionState.CONNECTING) {
            reject(error);
          }
        };

      } catch (error) {
        this.handleConnectionError(error);
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.state = ConnectionState.DISCONNECTED;
    this.emit('stateChange', this.state);
    this.emit('disconnected');
  }

  /**
   * Subscribe to events on specific topics
   */
  subscribe(topics: string[], handler: WebSocketEventHandler): void {
    // Add handler to local subscriptions
    topics.forEach(topic => {
      if (!this.subscriptions.has(topic)) {
        this.subscriptions.set(topic, new Set());
      }
      this.subscriptions.get(topic)!.add(handler);
    });

    // Send subscription message to server if connected
    if (this.state === ConnectionState.CONNECTED) {
      this.sendMessage({
        type: 'subscribe',
        topics,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Unsubscribe from events on specific topics
   */
  unsubscribe(topics: string[], handler?: WebSocketEventHandler): void {
    topics.forEach(topic => {
      const handlers = this.subscriptions.get(topic);
      if (handlers) {
        if (handler) {
          handlers.delete(handler);
          if (handlers.size === 0) {
            this.subscriptions.delete(topic);
          }
        } else {
          // Remove all handlers for this topic
          this.subscriptions.delete(topic);
        }
      }
    });

    // Send unsubscription message to server if connected
    if (this.state === ConnectionState.CONNECTED) {
      this.sendMessage({
        type: 'unsubscribe',
        topics,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Add event listener for client events
   */
  on(event: 'connected' | 'disconnected' | 'reconnecting' | 'error' | 'stateChange', handler: (data?: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Remove event listener
   */
  off(event: string, handler: (data?: any) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(event);
      }
    }
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get current subscriptions
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: string): void {
    try {
      const message: WebSocketMessage = JSON.parse(data);

      switch (message.type) {
        case 'event':
          this.handleEventMessage(message);
          break;

        case 'pong':
          // Handle pong response (connection is alive)
          break;

        case 'ping':
          // Respond to server ping
          this.sendMessage({
            type: 'pong',
            timestamp: new Date().toISOString(),
            correlationId: message.correlationId
          });
          break;

        default:
          console.debug('Unknown WebSocket message type:', message.type);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }

  /**
   * Handle event messages from server
   */
  private handleEventMessage(message: WebSocketMessage): void {
    if (!message.data) return;

    const { topic, event } = message.data;
    
    if (topic) {
      // Notify subscribers for this specific topic
      const handlers = this.subscriptions.get(topic);
      if (handlers) {
        handlers.forEach(handler => {
          try {
            handler(event || message.data);
          } catch (error) {
            console.error('Error in WebSocket event handler:', error);
          }
        });
      }

      // Notify subscribers for wildcard topic
      const wildcardHandlers = this.subscriptions.get('*');
      if (wildcardHandlers) {
        wildcardHandlers.forEach(handler => {
          try {
            handler({ topic, event: event || message.data });
          } catch (error) {
            console.error('Error in WebSocket wildcard handler:', error);
          }
        });
      }
    }
  }

  /**
   * Handle WebSocket disconnect
   */
  private handleDisconnect(code: number, reason: string): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    this.ws = null;

    if (this.state !== ConnectionState.DISCONNECTED) {
      // Attempt reconnection if not manually disconnected
      this.attemptReconnect();
    }
  }

  /**
   * Handle connection errors
   */
  private handleConnectionError(error: any): void {
    console.error('WebSocket connection error:', error);
    this.state = ConnectionState.ERROR;
    this.emit('stateChange', this.state);
    this.emit('error', error);

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = undefined;
    }
  }

  /**
   * Attempt to reconnect to WebSocket server
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.state = ConnectionState.ERROR;
      this.emit('stateChange', this.state);
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    this.state = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;
    this.emit('stateChange', this.state);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = window.setTimeout(async () => {
      try {
        await this.connect();
        
        // Re-subscribe to all topics after reconnection
        if (this.subscriptions.size > 0) {
          const allTopics = Array.from(this.subscriptions.keys());
          this.sendMessage({
            type: 'subscribe',
            topics: allTopics,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        // Reconnection failed, will try again
        console.warn('Reconnection attempt failed:', error);
      }
    }, this.config.reconnectInterval * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5))); // Exponential backoff
  }

  /**
   * Send message to WebSocket server
   */
  private sendMessage(message: WebSocketMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Start ping interval for connection health
   */
  private startPingInterval(): void {
    this.pingTimer = window.setInterval(() => {
      if (this.state === ConnectionState.CONNECTED) {
        this.sendMessage({
          type: 'ping',
          timestamp: new Date().toISOString()
        });
      }
    }, this.config.pingInterval);
  }

  /**
   * Emit event to registered handlers
   */
  private emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Error in ${event} event handler:`, error);
        }
      });
    }
  }
}

/**
 * Create and configure a WebSocket client instance
 */
export function createWebSocketClient(config?: WebSocketClientConfig): AgentSkillsWebSocketClient {
  return new AgentSkillsWebSocketClient(config);
}