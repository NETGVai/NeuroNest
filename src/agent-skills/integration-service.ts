import Database from 'better-sqlite3';
import { EventBus } from '../events/event-bus.js';
import { MemoryCache } from '../cache/memory-cache.js';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { AgentSkillsService } from './agent-skills-service.js';
import { agentSkillsErrorHandler, ComponentState } from './error-handler.js';
import { logger } from '../utils/logger.js';

/**
 * Agent Skills Integration Service
 * 
 * Coordinates all Agent Skills components with comprehensive error handling,
 * graceful degradation, and recovery mechanisms. Maintains system stability
 * even when individual components fail.
 * 
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

export interface IntegrationServiceOptions {
  database: Database.Database;
  enableEventBus?: boolean;
  enableMemoryCache?: boolean;
  enableHealthMonitoring?: boolean;
  healthCheckInterval?: number; // in milliseconds
}

export interface SystemHealth {
  overall: ComponentState;
  components: {
    sqliteAdapter: ComponentState;
    eventBus: ComponentState;
    memoryCache: ComponentState;
    agentSkillsService: ComponentState;
  };
  degradedFeatures: string[];
  criticalErrors: string[];
  lastHealthCheck: Date;
}

/**
 * Main integration service that coordinates all Agent Skills components
 */
export class AgentSkillsIntegrationService {
  private database: Database.Database;
  private sqliteAdapter!: SQLiteAdapter;
  private eventBus?: EventBus;
  private memoryCache?: MemoryCache;
  private agentSkillsService!: AgentSkillsService;
  
  private options: Required<IntegrationServiceOptions>;
  private healthCheckTimer?: NodeJS.Timeout;
  private isShuttingDown = false;

  constructor(options: IntegrationServiceOptions) {
    this.database = options.database;
    this.options = {
      database: options.database,
      enableEventBus: options.enableEventBus ?? true,
      enableMemoryCache: options.enableMemoryCache ?? true,
      enableHealthMonitoring: options.enableHealthMonitoring ?? true,
      healthCheckInterval: options.healthCheckInterval ?? 60000 // 1 minute
    };

    this.initializeComponents();
    
    if (this.options.enableHealthMonitoring) {
      this.startHealthMonitoring();
    }

    logger.info('Agent Skills Integration Service initialized', {
      eventBusEnabled: this.options.enableEventBus,
      memoryCacheEnabled: this.options.enableMemoryCache,
      healthMonitoringEnabled: this.options.enableHealthMonitoring
    });
  }

  /**
   * Initialize all components with error handling
   */
  private initializeComponents(): void {
    try {
      // Initialize SQLite Adapter (required)
      this.sqliteAdapter = new SQLiteAdapter(this.database);
      logger.info('SQLite Adapter initialized');

      // Initialize Event Bus (optional)
      if (this.options.enableEventBus) {
        try {
          this.eventBus = new EventBus({
            database: this.database,
            maxConcurrentEvents: 100,
            defaultRetryDelay: 1000,
            defaultMaxRetries: 3
          });
          logger.info('Event Bus initialized');
        } catch (error) {
          logger.error('Failed to initialize Event Bus, continuing without it', {
            error: error instanceof Error ? error.message : String(error)
          });
          agentSkillsErrorHandler.getComponentHealth('event-bus')!.state = ComponentState.FAILED;
        }
      }

      // Initialize Memory Cache (optional)
      if (this.options.enableMemoryCache) {
        try {
          this.memoryCache = new MemoryCache({
            database: this.database,
            maxMemoryMB: 100,
            maxEntries: 10000,
            enablePersistence: true
          });
          logger.info('Memory Cache initialized');
        } catch (error) {
          logger.error('Failed to initialize Memory Cache, continuing without it', {
            error: error instanceof Error ? error.message : String(error)
          });
          agentSkillsErrorHandler.getComponentHealth('memory-cache')!.state = ComponentState.FAILED;
        }
      }

      // Initialize Agent Skills Service (required)
      this.agentSkillsService = new AgentSkillsService(this.database);
      logger.info('Agent Skills Service initialized');

    } catch (error) {
      logger.error('Failed to initialize Agent Skills Integration Service', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get the SQLite Adapter instance
   */
  getSQLiteAdapter(): SQLiteAdapter {
    return this.sqliteAdapter;
  }

  /**
   * Get the Event Bus instance (may be undefined if disabled or failed)
   */
  getEventBus(): EventBus | undefined {
    return this.eventBus;
  }

  /**
   * Get the Memory Cache instance (may be undefined if disabled or failed)
   */
  getMemoryCache(): MemoryCache | undefined {
    return this.memoryCache;
  }

  /**
   * Get the Agent Skills Service instance
   */
  getAgentSkillsService(): AgentSkillsService {
    return this.agentSkillsService;
  }

  /**
   * Check the health of all components
   */
  async checkSystemHealth(): Promise<SystemHealth> {
    const componentHealth = agentSkillsErrorHandler.getAllComponentHealth();
    const degradedFeatures: string[] = [];
    const criticalErrors: string[] = [];

    // Check SQLite Adapter
    const sqliteHealth = componentHealth.get('sqlite-adapter')?.state || ComponentState.FAILED;
    if (sqliteHealth === ComponentState.FAILED) {
      criticalErrors.push('SQLite Adapter is not functioning');
    } else if (sqliteHealth === ComponentState.DEGRADED) {
      degradedFeatures.push('SQLite operations may be slower than normal');
    }

    // Check Event Bus
    const eventBusHealth = componentHealth.get('event-bus')?.state || ComponentState.FAILED;
    if (this.options.enableEventBus) {
      if (eventBusHealth === ComponentState.FAILED) {
        degradedFeatures.push('Real-time event notifications are unavailable');
      } else if (eventBusHealth === ComponentState.DEGRADED) {
        degradedFeatures.push('Event delivery may be delayed');
      }
    }

    // Check Memory Cache
    const memoryCacheHealth = componentHealth.get('memory-cache')?.state || ComponentState.FAILED;
    if (this.options.enableMemoryCache) {
      if (memoryCacheHealth === ComponentState.FAILED) {
        degradedFeatures.push('Caching is unavailable - performance may be reduced');
      } else if (memoryCacheHealth === ComponentState.DEGRADED) {
        degradedFeatures.push('Cache performance is reduced');
      }
    }

    // Check Agent Skills Service
    const serviceHealth = componentHealth.get('agent-skills-service')?.state || ComponentState.FAILED;
    if (serviceHealth === ComponentState.FAILED) {
      criticalErrors.push('Agent Skills Service is not functioning');
    } else if (serviceHealth === ComponentState.DEGRADED) {
      degradedFeatures.push('Some Agent Skills features may be limited');
    }

    // Determine overall health
    let overall = ComponentState.HEALTHY;
    if (criticalErrors.length > 0) {
      overall = ComponentState.FAILED;
    } else if (degradedFeatures.length > 0) {
      overall = ComponentState.DEGRADED;
    }

    return {
      overall,
      components: {
        sqliteAdapter: sqliteHealth,
        eventBus: eventBusHealth,
        memoryCache: memoryCacheHealth,
        agentSkillsService: serviceHealth
      },
      degradedFeatures,
      criticalErrors,
      lastHealthCheck: new Date()
    };
  }

  /**
   * Attempt to recover failed components
   */
  async attemptRecovery(): Promise<{
    recovered: string[];
    stillFailed: string[];
    errors: string[];
  }> {
    const recovered: string[] = [];
    const stillFailed: string[] = [];
    const errors: string[] = [];

    logger.info('Attempting to recover failed components');

    // Attempt to recover SQLite Adapter
    try {
      const dbHealth = await this.sqliteAdapter.checkDatabaseHealth();
      if (dbHealth.healthy) {
        recovered.push('sqlite-adapter');
        logger.info('SQLite Adapter recovered');
      } else {
        stillFailed.push('sqlite-adapter');
        errors.push(`SQLite Adapter: ${dbHealth.message}`);
      }
    } catch (error) {
      stillFailed.push('sqlite-adapter');
      errors.push(`SQLite Adapter recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Attempt to recover Event Bus
    if (this.options.enableEventBus && !this.eventBus) {
      try {
        this.eventBus = new EventBus({
          database: this.database,
          maxConcurrentEvents: 100,
          defaultRetryDelay: 1000,
          defaultMaxRetries: 3
        });
        recovered.push('event-bus');
        logger.info('Event Bus recovered');
      } catch (error) {
        stillFailed.push('event-bus');
        errors.push(`Event Bus recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Attempt to recover Memory Cache
    if (this.options.enableMemoryCache && !this.memoryCache) {
      try {
        this.memoryCache = new MemoryCache({
          database: this.database,
          maxMemoryMB: 100,
          maxEntries: 10000,
          enablePersistence: true
        });
        recovered.push('memory-cache');
        logger.info('Memory Cache recovered');
      } catch (error) {
        stillFailed.push('memory-cache');
        errors.push(`Memory Cache recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Check Agent Skills Service health
    try {
      const serviceHealth = await this.agentSkillsService.checkHealth();
      if (serviceHealth.healthy) {
        recovered.push('agent-skills-service');
        logger.info('Agent Skills Service is healthy');
      } else {
        stillFailed.push('agent-skills-service');
        errors.push(`Agent Skills Service: ${serviceHealth.message}`);
      }
    } catch (error) {
      stillFailed.push('agent-skills-service');
      errors.push(`Agent Skills Service health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    logger.info('Recovery attempt completed', {
      recovered: recovered.length,
      stillFailed: stillFailed.length,
      errors: errors.length
    });

    return { recovered, stillFailed, errors };
  }

  /**
   * Start periodic health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (this.isShuttingDown) return;

      try {
        const health = await this.checkSystemHealth();
        
        if (health.overall === ComponentState.FAILED) {
          logger.error('System health check failed', {
            criticalErrors: health.criticalErrors,
            degradedFeatures: health.degradedFeatures
          });
          
          // Attempt recovery for failed components
          await this.attemptRecovery();
        } else if (health.overall === ComponentState.DEGRADED) {
          logger.warn('System is in degraded state', {
            degradedFeatures: health.degradedFeatures
          });
        }
        
      } catch (error) {
        logger.error('Health monitoring failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }, this.options.healthCheckInterval);

    logger.info('Health monitoring started', {
      interval: this.options.healthCheckInterval
    });
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
      logger.info('Health monitoring stopped');
    }
  }

  /**
   * Perform database maintenance
   */
  async performMaintenance(): Promise<void> {
    logger.info('Starting system maintenance');
    
    try {
      // Perform SQLite maintenance
      await this.sqliteAdapter.performMaintenance();
      
      // Flush cache to persistence if available
      if (this.memoryCache) {
        await this.memoryCache.flush();
      }
      
      logger.info('System maintenance completed');
    } catch (error) {
      logger.error('System maintenance failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get system statistics
   */
  getSystemStats(): {
    database: any;
    eventBus?: any;
    memoryCache?: any;
    errorHandler: any;
  } {
    return {
      database: this.sqliteAdapter.getStats(),
      eventBus: this.eventBus?.getStats(),
      memoryCache: this.memoryCache?.getStats(),
      errorHandler: agentSkillsErrorHandler.getSystemHealthSummary()
    };
  }

  /**
   * Shutdown the integration service gracefully
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('Shutting down Agent Skills Integration Service');
    
    // Stop health monitoring
    this.stopHealthMonitoring();
    
    try {
      // Shutdown components in reverse order of initialization
      if (this.memoryCache) {
        await this.memoryCache.shutdown();
        logger.info('Memory Cache shutdown complete');
      }
      
      if (this.eventBus) {
        await this.eventBus.shutdown();
        logger.info('Event Bus shutdown complete');
      }
      
      this.agentSkillsService.close();
      logger.info('Agent Skills Service shutdown complete');
      
      this.sqliteAdapter.close();
      logger.info('SQLite Adapter shutdown complete');
      
      // Shutdown error handler
      agentSkillsErrorHandler.shutdown();
      
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    logger.info('Agent Skills Integration Service shutdown complete');
  }
}