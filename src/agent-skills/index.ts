/**
 * Agent Skills SQLite Integration
 * 
 * This module provides the SQLite Adapter, Agent Skills Service,
 * IPC handlers, and WebSocket real-time updates for integrating 
 * Agent Skills functionality into NeuroNest using the existing 
 * SQLite database schema.
 */

export { SQLiteAdapter } from './sqlite-adapter.js';
export { 
  AgentSkillsService,
  type Skill,
  type AgentSkillAssignment,
  type SkillEvent,
  type CreateSkillRequest,
  type UpdateSkillRequest,
  type SkillSearchCriteria
} from './agent-skills-service.js';
export { 
  AgentSkillsIPCHandler,
  registerAgentSkillsIPC
} from './ipc-handler.js';
export {
  initializeAgentSkillsInMainProcess,
  getAgentSkillsService,
  shutdownAgentSkillsService,
  verifyAgentSkillsIntegration,
  getAgentSkillsHealthStatus,
  getConnectionPool,
  getPerformanceMonitor,
  getRecoveryManager,
  getComponentStatus,
} from './main-process-integration.js';

// Integration Service
export {
  AgentSkillsIntegrationService,
  type IntegrationServiceOptions,
  type SystemHealth,
} from './integration-service.js';

// Database Recovery
export {
  DatabaseRecoveryManager,
  type BackupResult,
  type CorruptionReport,
} from './database-recovery.js';

// WebSocket real-time updates
export { 
  AgentSkillsWebSocketServer,
  type WebSocketServerConfig
} from './websocket-server.js';
export { 
  initializeWebSocketIntegration,
  shutdownWebSocketIntegration,
  getWebSocketServer,
  getWebSocketStats,
  broadcastToWebSocketClients,
  testWebSocketConnectivity,
  restartWebSocketServer,
  type WebSocketIntegrationConfig
} from './websocket-integration.js';
export { 
  createWebSocketClient, 
  AgentSkillsWebSocketClient, 
  ConnectionState,
  type WebSocketMessage,
  type WebSocketClientConfig
} from './websocket-client.js';

// Configuration Migration System
export { 
  ConfigMigrationEngine,
  type AgentSkillsConfig,
  type LegacyAgentSkillsConfig,
  type ConfigMigrationResult,
  type ConfigValidationResult
} from './config-migration.js';

// Performance Monitor
export {
  PerformanceMonitor,
  type PerformanceMonitorConfig,
  type TimingEntry,
  type OperationStats,
  type MemorySnapshot,
  type MetricsReport,
} from './performance-monitor.js';

// SQLite Optimizer
export {
  configureWalMode,
  optimizeAgentSkillsIndexes,
  optimizeSQLiteForAgentSkills,
  SQLiteConnectionPool,
  type SQLiteOptimizerConfig,
  type WalConfigResult,
} from './sqlite-optimizer.js';