/**
 * WebSocket Integration for Agent Skills
 * 
 * Integrates WebSocket server with NeuroNest main process and connects
 * it to the Event Bus for real-time skill assignment updates.
 * 
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { AgentSkillsWebSocketServer, type WebSocketServerConfig } from './websocket-server.js';
import { EventBus } from '../events/event-bus.js';
import { logger } from '../utils/logger.js';
import type Database from 'better-sqlite3';

/**
 * Global WebSocket server instance
 */
let webSocketServerInstance: AgentSkillsWebSocketServer | null = null;

/**
 * WebSocket integration configuration
 */
export interface WebSocketIntegrationConfig extends WebSocketServerConfig {
  autoStart?: boolean;
  enableHealthCheck?: boolean;
  healthCheckInterval?: number;
}

/**
 * Initialize WebSocket integration for Agent Skills
 */
export async function initializeWebSocketIntegration(
  database: Database.Database,
  config: WebSocketIntegrationConfig = {}
): Promise<AgentSkillsWebSocketServer> {
  if (webSocketServerInstance) {
    logger.warn('WebSocket server already initialized');
    return webSocketServerInstance;
  }

  try {
    // Create WebSocket server instance
    webSocketServerInstance = new AgentSkillsWebSocketServer(database, config);

    // Auto-start if configured
    if (config.autoStart !== false) {
      await webSocketServerInstance.start();
    }

    // Setup health monitoring if enabled
    if (config.enableHealthCheck !== false) {
      setupHealthMonitoring(config.healthCheckInterval || 60000); // Default 1 minute
    }

    logger.info('WebSocket integration initialized successfully', {
      autoStart: config.autoStart !== false,
      enableHealthCheck: config.enableHealthCheck !== false
    });

    return webSocketServerInstance;
  } catch (error) {
    logger.error('Failed to initialize WebSocket integration:', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get the WebSocket server instance
 */
export function getWebSocketServer(): AgentSkillsWebSocketServer | null {
  return webSocketServerInstance;
}

/**
 * Shutdown WebSocket integration
 */
export async function shutdownWebSocketIntegration(): Promise<void> {
  if (webSocketServerInstance) {
    try {
      await webSocketServerInstance.stop();
      webSocketServerInstance = null;
      logger.info('WebSocket integration shutdown successfully');
    } catch (error) {
      logger.error('Error during WebSocket integration shutdown:', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Setup health monitoring for WebSocket server
 */
function setupHealthMonitoring(interval: number): void {
  setInterval(() => {
    if (webSocketServerInstance) {
      const stats = webSocketServerInstance.getStats();
      
      logger.debug('WebSocket server health check', {
        isRunning: stats.isRunning,
        connectedClients: stats.connectedClients,
        totalSubscriptions: stats.totalSubscriptions
      });

      // Log warning if server is not running when it should be
      if (!stats.isRunning) {
        logger.warn('WebSocket server is not running during health check');
      }

      // Log info about client connections periodically
      if (stats.connectedClients > 0) {
        logger.info('WebSocket server active connections', {
          clients: stats.connectedClients,
          subscriptions: stats.totalSubscriptions
        });
      }
    }
  }, interval);
}

/**
 * Broadcast a manual event to WebSocket clients
 * Useful for testing or manual notifications
 */
export function broadcastToWebSocketClients(topic: string, data: any): void {
  if (webSocketServerInstance) {
    webSocketServerInstance.broadcast(topic, data);
    logger.debug('Manual broadcast sent to WebSocket clients', { topic });
  } else {
    logger.warn('Cannot broadcast - WebSocket server not initialized');
  }
}

/**
 * Get WebSocket server statistics
 */
export function getWebSocketStats(): {
  isInitialized: boolean;
  serverStats?: ReturnType<AgentSkillsWebSocketServer['getStats']>;
  clients?: ReturnType<AgentSkillsWebSocketServer['getClients']>;
} {
  if (!webSocketServerInstance) {
    return { isInitialized: false };
  }

  return {
    isInitialized: true,
    serverStats: webSocketServerInstance.getStats(),
    clients: webSocketServerInstance.getClients()
  };
}

/**
 * Test WebSocket connectivity
 * Useful for debugging and health checks
 */
export async function testWebSocketConnectivity(): Promise<{
  success: boolean;
  message: string;
  details?: any;
}> {
  if (!webSocketServerInstance) {
    return {
      success: false,
      message: 'WebSocket server not initialized'
    };
  }

  const stats = webSocketServerInstance.getStats();
  
  if (!stats.isRunning) {
    return {
      success: false,
      message: 'WebSocket server is not running',
      details: stats
    };
  }

  // Test by broadcasting a test event
  try {
    webSocketServerInstance.broadcast('test.connectivity', {
      type: 'connectivity_test',
      timestamp: new Date().toISOString(),
      message: 'WebSocket connectivity test'
    });

    return {
      success: true,
      message: 'WebSocket server is running and responsive',
      details: {
        ...stats,
        testBroadcastSent: true
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `WebSocket test failed: ${error instanceof Error ? error.message : String(error)}`,
      details: stats
    };
  }
}

/**
 * Restart WebSocket server
 * Useful for configuration changes or error recovery
 */
export async function restartWebSocketServer(
  database: Database.Database,
  config?: WebSocketIntegrationConfig
): Promise<void> {
  logger.info('Restarting WebSocket server...');
  
  // Shutdown existing server
  await shutdownWebSocketIntegration();
  
  // Wait a moment for cleanup
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Initialize new server
  await initializeWebSocketIntegration(database, config);
  
  logger.info('WebSocket server restarted successfully');
}