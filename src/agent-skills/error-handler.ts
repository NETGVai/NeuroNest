import { logger } from '../utils/logger.js';
import Database from 'better-sqlite3';
import { validateTableName } from './sql-allowlist.js';

/**
 * Comprehensive Error Handler for Agent Skills Integration
 * 
 * Provides graceful degradation, retry mechanisms, and recovery procedures
 * for all Agent Skills components to maintain system stability.
 * 
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number; // Base delay in milliseconds
  maxDelay: number; // Maximum delay in milliseconds
  backoffMultiplier: number; // Exponential backoff multiplier
  retryableErrors?: string[]; // Specific error messages/types to retry
}

export interface ErrorContext {
  component: string;
  operation: string;
  metadata?: Record<string, any>;
  correlationId?: string;
  timestamp: Date;
}

export interface RecoveryResult {
  success: boolean;
  message: string;
  recoveredData?: any;
  requiresManualIntervention?: boolean;
}

export enum ComponentState {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  FAILED = 'failed',
  RECOVERING = 'recovering'
}

export interface ComponentHealth {
  state: ComponentState;
  lastError?: Error;
  errorCount: number;
  lastHealthCheck: Date;
  degradationReason?: string;
}

/**
 * Enhanced error handler with graceful degradation and recovery mechanisms
 */
export class AgentSkillsErrorHandler {
  private componentHealth = new Map<string, ComponentHealth>();
  private retryAttempts = new Map<string, number>();
  private circuitBreakers = new Map<string, { isOpen: boolean; lastFailure: Date; failureCount: number }>();
  private healthMonitorInterval?: ReturnType<typeof setInterval>;
  
  private readonly defaultRetryOptions: RetryOptions = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryableErrors: [
      'SQLITE_BUSY',
      'SQLITE_LOCKED',
      'SQLITE_IOERR',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND'
    ]
  };

  constructor() {
    // Initialize component health tracking
    this.initializeComponentHealth();
    
    // Health monitoring is started lazily — not in the constructor
    // to avoid side effects at import time for the global singleton.
    
    logger.info('Agent Skills Error Handler initialized');
  }

  /**
   * Execute an operation with comprehensive error handling and retry logic
   */
  async executeWithRetry<T>(
    operation: () => Promise<T>,
    context: ErrorContext,
    options: Partial<RetryOptions> = {}
  ): Promise<T> {
    const effectiveOptions = { ...this.defaultRetryOptions, ...options };
    const operationKey = `${context.component}:${context.operation}`;
    
    // Check circuit breaker
    if (this.isCircuitBreakerOpen(operationKey)) {
      throw new Error(`Circuit breaker is open for ${operationKey}. Service temporarily unavailable.`);
    }

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= effectiveOptions.maxRetries) {
      try {
        const result = await operation();
        
        // Success - reset error tracking
        this.recordSuccess(context.component, operationKey);
        return result;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        attempt++;
        
        // Log the error with context
        this.logError(lastError, context, attempt);
        
        // Check if error is retryable
        if (!this.isRetryableError(lastError, effectiveOptions) || attempt > effectiveOptions.maxRetries) {
          this.recordFailure(context.component, operationKey, lastError);
          break;
        }
        
        // Calculate delay with exponential backoff
        const delay = this.calculateBackoffDelay(attempt, effectiveOptions);
        
        logger.debug('Retrying operation after delay', {
          component: context.component,
          operation: context.operation,
          attempt,
          delay,
          error: lastError.message
        });
        
        await this.delay(delay);
      }
    }

    // All retries exhausted
    this.recordFailure(context.component, operationKey, lastError!);
    throw lastError!;
  }

  /**
   * Execute operation with graceful degradation fallback
   */
  async executeWithFallback<T>(
    primaryOperation: () => Promise<T>,
    fallbackOperation: () => Promise<T>,
    context: ErrorContext,
    options: Partial<RetryOptions> = {}
  ): Promise<T> {
    try {
      return await this.executeWithRetry(primaryOperation, context, options);
    } catch (primaryError) {
      logger.warn('Primary operation failed, attempting fallback', {
        component: context.component,
        operation: context.operation,
        primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError)
      });

      try {
        const result = await fallbackOperation();
        
        // Mark component as degraded but functional
        this.setComponentState(context.component, ComponentState.DEGRADED, 
          `Using fallback for ${context.operation}`);
        
        return result;
      } catch (fallbackError) {
        // Both primary and fallback failed
        this.setComponentState(context.component, ComponentState.FAILED, 
          `Both primary and fallback operations failed for ${context.operation}`);
        
        logger.error('Both primary and fallback operations failed', {
          component: context.component,
          operation: context.operation,
          primaryError: primaryError instanceof Error ? primaryError.message : String(primaryError),
          fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
        
        throw primaryError; // Throw original error
      }
    }
  }

  /**
   * Attempt to recover from SQLite database corruption
   */
  async recoverSQLiteDatabase(database: Database.Database, backupPath?: string): Promise<RecoveryResult> {
    logger.info('Attempting SQLite database recovery');
    
    try {
      // First, try to run integrity check
      const integrityResult = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
      
      if (integrityResult.length === 1 && integrityResult[0].integrity_check === 'ok') {
        logger.info('Database integrity check passed - no corruption detected');
        return {
          success: true,
          message: 'Database is healthy - no recovery needed'
        };
      }
      
      logger.warn('Database corruption detected, attempting recovery', { integrityResult });
      
      // Try to recover using SQLite's built-in recovery
      try {
        // Enable recovery mode
        database.pragma('writable_schema = ON');
        
        // Try to reindex all tables
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
        
        for (const table of tables) {
          try {
            if (!validateTableName(table.name)) {
              logger.debug(`Skipping reindex for unrecognized table: ${table.name}`);
              continue;
            }
            database.exec(`REINDEX "${table.name}"`);
            logger.debug(`Reindexed table: ${table.name}`);
          } catch (reindexError) {
            logger.warn(`Failed to reindex table ${table.name}`, { 
              error: reindexError instanceof Error ? reindexError.message : String(reindexError) 
            });
          }
        }
        
        // Disable recovery mode
        database.pragma('writable_schema = OFF');
        
        // Run integrity check again
        const postRecoveryCheck = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
        
        if (postRecoveryCheck.length === 1 && postRecoveryCheck[0].integrity_check === 'ok') {
          logger.info('Database recovery successful');
          return {
            success: true,
            message: 'Database recovered successfully using built-in recovery'
          };
        }
        
      } catch (recoveryError) {
        logger.error('Built-in recovery failed', { 
          error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError) 
        });
      }
      
      // If built-in recovery failed and we have a backup, try to restore from backup
      if (backupPath) {
        try {
          // This would require implementing backup restoration logic
          logger.info('Attempting to restore from backup', { backupPath });
          
          return {
            success: false,
            message: 'Database corruption detected. Manual backup restoration required.',
            requiresManualIntervention: true
          };
        } catch (backupError) {
          logger.error('Backup restoration failed', { 
            error: backupError instanceof Error ? backupError.message : String(backupError) 
          });
        }
      }
      
      return {
        success: false,
        message: 'Database recovery failed. Manual intervention required.',
        requiresManualIntervention: true
      };
      
    } catch (error) {
      logger.error('Database recovery process failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        success: false,
        message: 'Recovery process failed. Database may be severely corrupted.',
        requiresManualIntervention: true
      };
    }
  }

  /**
   * Get the current health status of a component
   */
  getComponentHealth(component: string): ComponentHealth | null {
    return this.componentHealth.get(component) || null;
  }

  /**
   * Get health status of all components
   */
  getAllComponentHealth(): Map<string, ComponentHealth> {
    return new Map(this.componentHealth);
  }

  /**
   * Check if the system is in a degraded state
   */
  isSystemDegraded(): boolean {
    for (const health of this.componentHealth.values()) {
      if (health.state === ComponentState.DEGRADED || health.state === ComponentState.FAILED) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get system health summary
   */
  getSystemHealthSummary(): {
    overallState: ComponentState;
    healthyComponents: number;
    degradedComponents: number;
    failedComponents: number;
    recoveringComponents: number;
  } {
    let healthy = 0;
    let degraded = 0;
    let failed = 0;
    let recovering = 0;
    
    for (const health of this.componentHealth.values()) {
      switch (health.state) {
        case ComponentState.HEALTHY:
          healthy++;
          break;
        case ComponentState.DEGRADED:
          degraded++;
          break;
        case ComponentState.FAILED:
          failed++;
          break;
        case ComponentState.RECOVERING:
          recovering++;
          break;
      }
    }
    
    let overallState = ComponentState.HEALTHY;
    if (failed > 0) {
      overallState = ComponentState.FAILED;
    } else if (degraded > 0 || recovering > 0) {
      overallState = ComponentState.DEGRADED;
    }
    
    return {
      overallState,
      healthyComponents: healthy,
      degradedComponents: degraded,
      failedComponents: failed,
      recoveringComponents: recovering
    };
  }

  /**
   * Initialize component health tracking
   */
  private initializeComponentHealth(): void {
    const components = [
      'sqlite-adapter',
      'event-bus',
      'memory-cache',
      'agent-skills-service',
      'ipc-handler',
      'websocket-server'
    ];
    
    for (const component of components) {
      this.componentHealth.set(component, {
        state: ComponentState.HEALTHY,
        errorCount: 0,
        lastHealthCheck: new Date()
      });
    }
  }

  /**
   * Start periodic health monitoring
   */
  startHealthMonitoring(): void {
    if (this.healthMonitorInterval) return;
    this.healthMonitorInterval = setInterval(() => {
      this.performHealthChecks();
    }, 60000); // Check every minute
  }

  /**
   * Perform health checks on all components
   */
  private performHealthChecks(): void {
    const now = new Date();
    
    for (const [component, health] of this.componentHealth.entries()) {
      // Reset error count if component has been healthy for a while
      if (health.state === ComponentState.HEALTHY && 
          now.getTime() - health.lastHealthCheck.getTime() > 300000) { // 5 minutes
        health.errorCount = 0;
      }
      
      // Attempt to recover failed components
      if (health.state === ComponentState.FAILED && 
          now.getTime() - health.lastHealthCheck.getTime() > 600000) { // 10 minutes
        this.attemptComponentRecovery(component);
      }
      
      health.lastHealthCheck = now;
    }
  }

  /**
   * Attempt to recover a failed component
   */
  private attemptComponentRecovery(component: string): void {
    logger.info(`Attempting to recover component: ${component}`);
    
    const health = this.componentHealth.get(component);
    if (!health) return;
    
    health.state = ComponentState.RECOVERING;
    
    // Reset circuit breaker for this component
    for (const [key, breaker] of this.circuitBreakers.entries()) {
      if (key.startsWith(component)) {
        breaker.isOpen = false;
        breaker.failureCount = 0;
      }
    }
    
    // Component-specific recovery logic would go here
    // For now, just mark as healthy after a delay
    setTimeout(() => {
      const currentHealth = this.componentHealth.get(component);
      if (currentHealth && currentHealth.state === ComponentState.RECOVERING) {
        currentHealth.state = ComponentState.HEALTHY;
        currentHealth.errorCount = 0;
        logger.info(`Component recovery completed: ${component}`);
      }
    }, 30000); // 30 seconds
  }

  /**
   * Record a successful operation
   */
  private recordSuccess(component: string, operationKey: string): void {
    let health = this.componentHealth.get(component);
    if (!health) {
      // Create health entry if it doesn't exist
      health = {
        state: ComponentState.HEALTHY,
        errorCount: 0,
        lastHealthCheck: new Date()
      };
      this.componentHealth.set(component, health);
    }
    
    if (health.state === ComponentState.DEGRADED || health.state === ComponentState.RECOVERING) {
      health.state = ComponentState.HEALTHY;
      health.degradationReason = undefined;
      logger.info(`Component recovered: ${component}`);
    }
    health.errorCount = Math.max(0, health.errorCount - 1);
    
    // Reset circuit breaker
    const breaker = this.circuitBreakers.get(operationKey);
    if (breaker) {
      breaker.failureCount = 0;
      breaker.isOpen = false;
    }
  }

  /**
   * Record a failed operation
   */
  private recordFailure(component: string, operationKey: string, error: Error): void {
    let health = this.componentHealth.get(component);
    if (!health) {
      // Create health entry if it doesn't exist
      health = {
        state: ComponentState.HEALTHY,
        errorCount: 0,
        lastHealthCheck: new Date()
      };
      this.componentHealth.set(component, health);
    }
    
    health.errorCount++;
    health.lastError = error;
    
    // Determine component state based on error count
    if (health.errorCount >= 10) {
      health.state = ComponentState.FAILED;
    } else if (health.errorCount >= 5) {
      health.state = ComponentState.DEGRADED;
      health.degradationReason = `High error rate: ${health.errorCount} errors`;
    }
    
    // Update circuit breaker
    let breaker = this.circuitBreakers.get(operationKey);
    if (!breaker) {
      breaker = { isOpen: false, lastFailure: new Date(), failureCount: 0 };
      this.circuitBreakers.set(operationKey, breaker);
    }
    
    breaker.failureCount++;
    breaker.lastFailure = new Date();
    
    // Open circuit breaker if too many failures
    if (breaker.failureCount >= 5) {
      breaker.isOpen = true;
      logger.warn(`Circuit breaker opened for ${operationKey}`, { failureCount: breaker.failureCount });
    }
  }

  /**
   * Set component state manually
   */
  setComponentState(component: string, state: ComponentState, reason?: string): void {
    let health = this.componentHealth.get(component);
    if (!health) {
      // Create health entry if it doesn't exist
      health = {
        state: ComponentState.HEALTHY,
        errorCount: 0,
        lastHealthCheck: new Date()
      };
      this.componentHealth.set(component, health);
    }
    
    health.state = state;
    health.degradationReason = reason;
    
    logger.info(`Component state changed: ${component} -> ${state}`, { reason });
  }

  /**
   * Check if circuit breaker is open
   */
  private isCircuitBreakerOpen(operationKey: string): boolean {
    const breaker = this.circuitBreakers.get(operationKey);
    if (!breaker || !breaker.isOpen) return false;
    
    // Check if enough time has passed to try again (circuit breaker timeout)
    const timeoutMs = 60000; // 1 minute
    if (Date.now() - breaker.lastFailure.getTime() > timeoutMs) {
      breaker.isOpen = false;
      breaker.failureCount = 0;
      return false;
    }
    
    return true;
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: Error, options: RetryOptions): boolean {
    const errorMessage = error.message.toLowerCase();
    
    return options.retryableErrors?.some(retryableError => 
      errorMessage.includes(retryableError.toLowerCase())
    ) || false;
  }

  /**
   * Calculate exponential backoff delay
   */
  private calculateBackoffDelay(attempt: number, options: RetryOptions): number {
    const delay = options.baseDelay * Math.pow(options.backoffMultiplier, attempt - 1);
    return Math.min(delay, options.maxDelay);
  }

  /**
   * Log error with comprehensive context
   */
  private logError(error: Error, context: ErrorContext, attempt: number): void {
    logger.error('Operation failed', {
      component: context.component,
      operation: context.operation,
      attempt,
      error: error.message,
      stack: error.stack,
      metadata: context.metadata,
      correlationId: context.correlationId,
      timestamp: context.timestamp.toISOString()
    });
  }

  /**
   * Utility function for delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown the error handler gracefully
   */
  shutdown(): void {
    logger.info('Agent Skills Error Handler shutting down');
    
    // Clear health monitoring interval
    if (this.healthMonitorInterval) {
      clearInterval(this.healthMonitorInterval);
      this.healthMonitorInterval = undefined;
    }
    
    // Clear component health
    this.componentHealth.clear();
    this.retryAttempts.clear();
    this.circuitBreakers.clear();
    
    logger.info('Agent Skills Error Handler shutdown complete');
  }
}

/**
 * Global error handler instance
 */
export const agentSkillsErrorHandler = new AgentSkillsErrorHandler();