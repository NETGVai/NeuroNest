/**
 * Agent Skills Main Process Integration
 *
 * Wires all Agent Skills components together in the NeuroNest main process:
 * - AgentSkillsService (core service)
 * - SQLite optimizer (WAL mode, indexes, connection pool)
 * - Performance monitor
 * - Database recovery manager
 * - WebSocket integration (real-time updates)
 *
 * Initialization is resilient — optional components that fail do not prevent
 * the core service from starting.
 *
 * Requirements: 2.1, 2.5, 11.1, 11.2, 11.3, 11.4, 11.5
 */

import path from 'node:path';
import { initDatabase } from '../storage/database.js';
import { getDataDirectory } from '../storage/data-directory.js';
import { AgentSkillsService } from './agent-skills-service.js';
import {
  initializeWebSocketIntegration,
  shutdownWebSocketIntegration,
  getWebSocketStats,
} from './websocket-integration.js';
import {
  optimizeSQLiteForAgentSkills,
  type SQLiteConnectionPool,
  type WalConfigResult,
} from './sqlite-optimizer.js';
import { PerformanceMonitor } from './performance-monitor.js';
import { DatabaseRecoveryManager } from './database-recovery.js';
import { validateTableName } from './sql-allowlist.js';
import { logger } from '../utils/logger.js';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

/** Core Agent Skills service */
let agentSkillsServiceInstance: AgentSkillsService | null = null;

/** SQLite connection pool (created by the optimizer) */
let connectionPool: SQLiteConnectionPool | null = null;

/** Performance monitor for Agent Skills operations */
let performanceMonitor: PerformanceMonitor | null = null;

/** Database recovery manager */
let recoveryManager: DatabaseRecoveryManager | null = null;

/** Tracks which optional components initialized successfully */
const componentStatus: Record<string, { ok: boolean; error?: string }> = {};

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the Agent Skills service and all supporting components.
 *
 * Initialization order:
 *  1. Database (required — uses existing NeuroNest database)
 *  2. SQLite optimizer — WAL mode, indexes, connection pool (optional)
 *  3. Performance monitor (optional)
 *  4. Database recovery manager (optional)
 *  5. AgentSkillsService (required)
 *  6. WebSocket integration (optional)
 *  7. Startup health check (optional)
 *
 * If any *optional* component fails the core service still starts.
 */
export async function initializeAgentSkillsInMainProcess(): Promise<AgentSkillsService> {
  if (agentSkillsServiceInstance) {
    logger.info('Agent Skills service already initialized');
    return agentSkillsServiceInstance;
  }

  // 1. Database ---------------------------------------------------------------
  const database = initDatabase();

  // 2. SQLite optimizer -------------------------------------------------------
  try {
    const result = optimizeSQLiteForAgentSkills(database);
    connectionPool = result.pool;
    componentStatus['sqlite-optimizer'] = { ok: true };
    logger.info('SQLite optimizer applied', {
      journalMode: result.walConfig.journalMode,
      indexCount: result.indexCount,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    componentStatus['sqlite-optimizer'] = { ok: false, error: msg };
    logger.warn('SQLite optimizer failed — continuing with defaults', { error: msg });
  }

  // 3. Performance monitor ----------------------------------------------------
  try {
    performanceMonitor = new PerformanceMonitor({
      slowOperationThresholdMs: 200,
    });
    componentStatus['performance-monitor'] = { ok: true };
    logger.info('Performance monitor initialized');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    componentStatus['performance-monitor'] = { ok: false, error: msg };
    logger.warn('Performance monitor failed to initialize', { error: msg });
  }

  // 4. Database recovery manager ----------------------------------------------
  try {
    const backupDir = path.join(getDataDirectory(), 'backups');
    recoveryManager = new DatabaseRecoveryManager(database, backupDir);
    componentStatus['database-recovery'] = { ok: true };
    logger.info('Database recovery manager initialized', { backupDir });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    componentStatus['database-recovery'] = { ok: false, error: msg };
    logger.warn('Database recovery manager failed to initialize', { error: msg });
  }

  // 5. Core service (required) ------------------------------------------------
  agentSkillsServiceInstance = new AgentSkillsService(database);
  componentStatus['agent-skills-service'] = { ok: true };

  // 6. WebSocket integration (optional) ---------------------------------------
  try {
    await initializeWebSocketIntegration(database, {
      port: 3001,
      host: 'localhost',
      autoStart: true,
      enableHealthCheck: true,
      pingInterval: 30000,
      connectionTimeout: 60000,
      maxConnections: 100,
    });
    componentStatus['websocket'] = { ok: true };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    componentStatus['websocket'] = { ok: false, error: msg };
    logger.warn('WebSocket integration failed — real-time updates unavailable', { error: msg });
  }

  // 7. Startup health check (optional) ----------------------------------------
  try {
    await runStartupHealthCheck(database);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('Startup health check encountered issues', { error: msg });
  }

  logger.info('Agent Skills service initialized in main process', { componentStatus });
  return agentSkillsServiceInstance;
}

// ---------------------------------------------------------------------------
// Startup health check
// ---------------------------------------------------------------------------

/**
 * Validates that the database and core tables are accessible after startup.
 * Logs warnings for any issues but does not throw.
 */
async function runStartupHealthCheck(database: Database.Database): Promise<void> {
  const issues: string[] = [];

  // Verify database is open and responsive
  try {
    const result = database.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      issues.push(`Integrity check returned: ${String(result)}`);
    }
  } catch (error) {
    issues.push(`Integrity check failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Verify core tables exist
  const requiredTables = ['skills', 'agent_skill_assignments', 'skill_events'];
  for (const table of requiredTables) {
    try {
      if (!validateTableName(table)) {
        issues.push(`Table '${table}' is not in the allowed tables list`);
        continue;
      }
      database.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get();
    } catch (error) {
      issues.push(`Table '${table}' not accessible: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Check recovery manager corruption detection
  if (recoveryManager) {
    try {
      const report = recoveryManager.detectCorruption();
      if (report.isCorrupted) {
        issues.push(`Corruption detected (${report.severity}): ${report.issues.join('; ')}`);
      }
    } catch (error) {
      issues.push(`Corruption detection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (issues.length > 0) {
    logger.warn('Startup health check found issues', { issues });
  } else {
    logger.info('Startup health check passed — all components healthy');
  }
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/** Get the Agent Skills service instance. Returns null if not initialized. */
export function getAgentSkillsService(): AgentSkillsService | null {
  return agentSkillsServiceInstance;
}

/** Get the SQLite connection pool (may be null if optimizer failed). */
export function getConnectionPool(): SQLiteConnectionPool | null {
  return connectionPool;
}

/** Get the performance monitor (may be null if initialization failed). */
export function getPerformanceMonitor(): PerformanceMonitor | null {
  return performanceMonitor;
}

/** Get the database recovery manager (may be null if initialization failed). */
export function getRecoveryManager(): DatabaseRecoveryManager | null {
  return recoveryManager;
}

/** Get the initialization status of each component. */
export function getComponentStatus(): Record<string, { ok: boolean; error?: string }> {
  return { ...componentStatus };
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Gracefully shut down all Agent Skills components in reverse initialization order.
 */
export async function shutdownAgentSkillsService(): Promise<void> {
  logger.info('Shutting down Agent Skills service');

  // WebSocket
  try {
    await shutdownWebSocketIntegration();
  } catch (error) {
    logger.warn('Error shutting down WebSocket integration', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Recovery manager
  if (recoveryManager) {
    try {
      recoveryManager.shutdown();
    } catch (error) {
      logger.warn('Error shutting down recovery manager', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    recoveryManager = null;
  }

  // Performance monitor
  if (performanceMonitor) {
    try {
      performanceMonitor.reset();
    } catch (error) {
      logger.warn('Error resetting performance monitor', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    performanceMonitor = null;
  }

  // Connection pool
  if (connectionPool) {
    try {
      connectionPool.close();
    } catch (error) {
      logger.warn('Error closing connection pool', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    connectionPool = null;
  }

  // Core service
  if (agentSkillsServiceInstance) {
    try {
      agentSkillsServiceInstance.close();
    } catch (error) {
      logger.warn('Error closing Agent Skills service', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    agentSkillsServiceInstance = null;
  }

  logger.info('Agent Skills service shutdown complete');
}

// ---------------------------------------------------------------------------
// Verification & Health
// ---------------------------------------------------------------------------

/**
 * Quick smoke-test that the service is operational.
 */
export async function verifyAgentSkillsIntegration(): Promise<boolean> {
  try {
    const service = getAgentSkillsService();
    if (!service) {
      logger.error('Agent Skills service not initialized');
      return false;
    }

    const skills = await service.searchSkills({ limit: 1 });
    logger.info(`Agent Skills integration verified — found ${skills.length} skill(s)`);
    return true;
  } catch (error) {
    logger.error('Agent Skills integration verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Comprehensive health status including all sub-components.
 */
export async function getAgentSkillsHealthStatus(): Promise<{
  status: 'healthy' | 'degraded' | 'unhealthy' | 'not_initialized';
  message: string;
  components: Record<string, { ok: boolean; error?: string }>;
  metrics?: {
    totalSkills: number;
    totalAssignments: number;
    recentEvents: number;
  };
  websocket?: {
    isRunning: boolean;
    connectedClients: number;
    totalSubscriptions: number;
  };
}> {
  const service = getAgentSkillsService();

  if (!service) {
    return {
      status: 'not_initialized',
      message: 'Agent Skills service not initialized',
      components: { ...componentStatus },
    };
  }

  try {
    const skills = await service.searchSkills({ limit: 1000 });
    const recentEvents = await service.getSkillEvents(undefined, undefined, undefined, 10);
    const wsStats = getWebSocketStats();

    // Determine overall status
    const failedComponents = Object.values(componentStatus).filter((c) => !c.ok);
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (failedComponents.length > 0 && componentStatus['agent-skills-service']?.ok) {
      status = 'degraded';
    } else if (!componentStatus['agent-skills-service']?.ok) {
      status = 'unhealthy';
    }

    return {
      status,
      message:
        status === 'healthy'
          ? 'All Agent Skills components running normally'
          : status === 'degraded'
            ? `Running with ${failedComponents.length} degraded component(s)`
            : 'Agent Skills service is unhealthy',
      components: { ...componentStatus },
      metrics: {
        totalSkills: skills.length,
        totalAssignments: 0,
        recentEvents: recentEvents.length,
      },
      websocket: wsStats.isInitialized
        ? {
            isRunning: wsStats.serverStats?.isRunning || false,
            connectedClients: wsStats.serverStats?.connectedClients || 0,
            totalSubscriptions: wsStats.serverStats?.totalSubscriptions || 0,
          }
        : undefined,
    };
  } catch (error) {
    logger.error('Agent Skills health check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: 'unhealthy',
      message: `Health check error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: { ...componentStatus },
    };
  }
}
