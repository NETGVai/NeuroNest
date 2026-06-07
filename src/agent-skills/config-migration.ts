/**
 * Configuration Migration System for Agent Skills SQLite Integration
 * 
 * This module handles the migration of Agent Skills configuration from the separate
 * microservice format into the NeuroNest configuration system. It provides validation,
 * fallback to defaults, and integration with the existing SettingsManager.
 * 
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';
import type { SettingsManager } from '../settings/settings-manager.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AgentSkillsConfig {
  // Core system settings
  auto_assignment_enabled: boolean;
  competency_tracking_enabled: boolean;
  skill_recommendation_threshold: number;
  max_concurrent_assignments: number;
  
  // Event and performance settings
  event_retention_days: number;
  performance_tracking_enabled: boolean;
  
  // Cache settings
  cache_default_ttl_seconds: number;
  cache_max_memory_mb: number;
  
  // WebSocket settings
  websocket_enabled: boolean;
  websocket_port: number;
  websocket_host: string;
  
  // Database settings
  database_connection_pool_size: number;
  database_query_timeout_ms: number;
  
  // Logging settings
  log_level: 'debug' | 'info' | 'warn' | 'error';
  log_retention_days: number;
}

export interface LegacyAgentSkillsConfig {
  // Legacy microservice configuration format
  database?: {
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    ssl?: boolean;
  };
  redis?: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
  };
  rabbitmq?: {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    vhost?: string;
  };
  server?: {
    port?: number;
    host?: string;
    cors?: boolean;
  };
  features?: {
    auto_assignment?: boolean;
    competency_tracking?: boolean;
    performance_analytics?: boolean;
  };
  thresholds?: {
    skill_recommendation?: number;
    max_assignments?: number;
  };
  retention?: {
    events_days?: number;
    logs_days?: number;
  };
  logging?: {
    level?: string;
  };
}

export interface ConfigMigrationResult {
  success: boolean;
  migratedSettings: Partial<AgentSkillsConfig>;
  errors: string[];
  warnings: string[];
  fallbacksUsed: string[];
}

export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Default Configuration ─────────────────────────────────────

export const DEFAULT_AGENT_SKILLS_CONFIG: AgentSkillsConfig = {
  auto_assignment_enabled: true,
  competency_tracking_enabled: true,
  skill_recommendation_threshold: 0.7,
  max_concurrent_assignments: 5,
  event_retention_days: 90,
  performance_tracking_enabled: true,
  cache_default_ttl_seconds: 3600,
  cache_max_memory_mb: 256,
  websocket_enabled: true,
  websocket_port: 3001,
  websocket_host: 'localhost',
  database_connection_pool_size: 10,
  database_query_timeout_ms: 30000,
  log_level: 'info',
  log_retention_days: 30,
};

// ─── Configuration Migration Engine ────────────────────────────

export class ConfigMigrationEngine {
  private db: Database.Database;
  private settingsManager: SettingsManager;

  constructor(database: Database.Database, settingsManager: SettingsManager) {
    this.db = database;
    this.settingsManager = settingsManager;
  }

  /**
   * Migrate Agent Skills configuration from various sources to NeuroNest format
   * Requirements: 7.1, 7.2, 7.3
   */
  async migrateConfiguration(sources: {
    legacyConfig?: LegacyAgentSkillsConfig;
    configFiles?: Record<string, any>;
    environmentVars?: Record<string, string>;
  }): Promise<ConfigMigrationResult> {
    const result: ConfigMigrationResult = {
      success: true,
      migratedSettings: {},
      errors: [],
      warnings: [],
      fallbacksUsed: [],
    };

    try {
      logger.info('Starting Agent Skills configuration migration');

      // Step 1: Extract configuration from legacy sources
      const extractedConfig = this.extractConfigFromSources(sources, result);

      // Step 2: Validate extracted configuration
      const validationResult = this.validateConfiguration(extractedConfig);
      result.errors.push(...validationResult.errors);
      result.warnings.push(...validationResult.warnings);

      // Step 3: Apply defaults for missing or invalid values
      const finalConfig = this.applyDefaults(extractedConfig, result);

      // Step 4: Store configuration in database
      await this.storeConfigurationInDatabase(finalConfig);

      // Step 5: Integrate with NeuroNest settings system
      await this.integrateWithNeuroNestSettings(finalConfig);

      result.migratedSettings = finalConfig;
      // Migration succeeds even with validation errors if we can apply defaults
      result.success = true;

      logger.info('Agent Skills configuration migration completed', {
        success: result.success,
        errorsCount: result.errors.length,
        warningsCount: result.warnings.length,
        fallbacksCount: result.fallbacksUsed.length,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Configuration migration failed: ${errorMessage}`);
      result.success = false;
      
      logger.error('Configuration migration failed', { error: errorMessage });
      
      // Fallback to defaults on critical failure
      await this.fallbackToDefaults(result);
      
      return result;
    }
  }

  /**
   * Extract configuration from various legacy sources
   * Requirements: 7.2
   */
  private extractConfigFromSources(
    sources: {
      legacyConfig?: LegacyAgentSkillsConfig;
      configFiles?: Record<string, any>;
      environmentVars?: Record<string, string>;
    },
    result: ConfigMigrationResult
  ): Partial<AgentSkillsConfig> {
    const extracted: Partial<AgentSkillsConfig> = {};

    // Extract from legacy microservice config
    if (sources.legacyConfig) {
      this.extractFromLegacyConfig(sources.legacyConfig, extracted, result);
    }

    // Extract from configuration files (JSON, YAML, etc.)
    if (sources.configFiles) {
      this.extractFromConfigFiles(sources.configFiles, extracted, result);
    }

    // Extract from environment variables
    if (sources.environmentVars) {
      this.extractFromEnvironmentVars(sources.environmentVars, extracted, result);
    }

    return extracted;
  }

  /**
   * Extract configuration from legacy microservice format
   */
  private extractFromLegacyConfig(
    legacy: LegacyAgentSkillsConfig,
    extracted: Partial<AgentSkillsConfig>,
    result: ConfigMigrationResult
  ): void {
    try {
      // Map legacy feature flags
      if (legacy.features) {
        if (typeof legacy.features.auto_assignment === 'boolean') {
          extracted.auto_assignment_enabled = legacy.features.auto_assignment;
        }
        if (typeof legacy.features.competency_tracking === 'boolean') {
          extracted.competency_tracking_enabled = legacy.features.competency_tracking;
        }
        if (typeof legacy.features.performance_analytics === 'boolean') {
          extracted.performance_tracking_enabled = legacy.features.performance_analytics;
        }
      }

      // Map legacy thresholds
      if (legacy.thresholds) {
        if (typeof legacy.thresholds.skill_recommendation === 'number') {
          extracted.skill_recommendation_threshold = legacy.thresholds.skill_recommendation;
        }
        if (typeof legacy.thresholds.max_assignments === 'number') {
          extracted.max_concurrent_assignments = legacy.thresholds.max_assignments;
        }
      }

      // Map legacy retention settings
      if (legacy.retention) {
        if (typeof legacy.retention.events_days === 'number') {
          extracted.event_retention_days = legacy.retention.events_days;
        }
        if (typeof legacy.retention.logs_days === 'number') {
          extracted.log_retention_days = legacy.retention.logs_days;
        }
      }

      // Map legacy server settings (for WebSocket)
      if (legacy.server) {
        if (typeof legacy.server.port === 'number') {
          extracted.websocket_port = legacy.server.port;
        }
        if (typeof legacy.server.host === 'string') {
          extracted.websocket_host = legacy.server.host;
        }
      }

      // Map legacy logging settings
      if (legacy.logging?.level) {
        const level = legacy.logging.level.toLowerCase();
        if (['debug', 'info', 'warn', 'error'].includes(level)) {
          extracted.log_level = level as 'debug' | 'info' | 'warn' | 'error';
        }
      }

      result.warnings.push('Legacy microservice configuration detected and migrated');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Failed to extract legacy configuration: ${errorMessage}`);
    }
  }

  /**
   * Extract configuration from config files
   */
  private extractFromConfigFiles(
    configFiles: Record<string, any>,
    extracted: Partial<AgentSkillsConfig>,
    result: ConfigMigrationResult
  ): void {
    try {
      for (const [filename, config] of Object.entries(configFiles)) {
        if (config && typeof config === 'object') {
          // Direct mapping for known configuration keys
          for (const [key, value] of Object.entries(config)) {
            if (key in DEFAULT_AGENT_SKILLS_CONFIG) {
              (extracted as any)[key] = value;
            }
          }
          
          result.warnings.push(`Configuration extracted from file: ${filename}`);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Failed to extract configuration from files: ${errorMessage}`);
    }
  }

  /**
   * Extract configuration from environment variables
   */
  private extractFromEnvironmentVars(
    envVars: Record<string, string>,
    extracted: Partial<AgentSkillsConfig>,
    result: ConfigMigrationResult
  ): void {
    try {
      const envMapping: Record<string, keyof AgentSkillsConfig> = {
        'AGENT_SKILLS_AUTO_ASSIGNMENT': 'auto_assignment_enabled',
        'AGENT_SKILLS_COMPETENCY_TRACKING': 'competency_tracking_enabled',
        'AGENT_SKILLS_RECOMMENDATION_THRESHOLD': 'skill_recommendation_threshold',
        'AGENT_SKILLS_MAX_ASSIGNMENTS': 'max_concurrent_assignments',
        'AGENT_SKILLS_EVENT_RETENTION_DAYS': 'event_retention_days',
        'AGENT_SKILLS_PERFORMANCE_TRACKING': 'performance_tracking_enabled',
        'AGENT_SKILLS_CACHE_TTL': 'cache_default_ttl_seconds',
        'AGENT_SKILLS_CACHE_MEMORY_MB': 'cache_max_memory_mb',
        'AGENT_SKILLS_WEBSOCKET_PORT': 'websocket_port',
        'AGENT_SKILLS_WEBSOCKET_HOST': 'websocket_host',
        'AGENT_SKILLS_LOG_LEVEL': 'log_level',
      };

      for (const [envKey, configKey] of Object.entries(envMapping)) {
        const envValue = envVars[envKey];
        if (envValue !== undefined) {
          // Type conversion based on default config
          const defaultValue = DEFAULT_AGENT_SKILLS_CONFIG[configKey];
          
          if (typeof defaultValue === 'boolean') {
            (extracted as any)[configKey] = envValue.toLowerCase() === 'true';
          } else if (typeof defaultValue === 'number') {
            const numValue = parseFloat(envValue);
            if (!isNaN(numValue)) {
              (extracted as any)[configKey] = numValue;
            }
          } else if (typeof defaultValue === 'string') {
            (extracted as any)[configKey] = envValue;
          }
        }
      }

      if (Object.keys(extracted).length > 0) {
        result.warnings.push('Configuration extracted from environment variables');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Failed to extract environment variables: ${errorMessage}`);
    }
  }

  /**
   * Validate extracted configuration
   * Requirements: 7.3
   */
  private validateConfiguration(config: Partial<AgentSkillsConfig>): ConfigValidationResult {
    const result: ConfigValidationResult = {
      isValid: true,
      errors: [],
      warnings: [],
    };

    // Validate skill_recommendation_threshold
    if (config.skill_recommendation_threshold !== undefined) {
      if (config.skill_recommendation_threshold < 0 || config.skill_recommendation_threshold > 1) {
        result.errors.push('skill_recommendation_threshold must be between 0 and 1');
        result.isValid = false;
      }
    }

    // Validate max_concurrent_assignments
    if (config.max_concurrent_assignments !== undefined) {
      if (config.max_concurrent_assignments < 1 || config.max_concurrent_assignments > 100) {
        result.errors.push('max_concurrent_assignments must be between 1 and 100');
        result.isValid = false;
      }
    }

    // Validate retention days
    if (config.event_retention_days !== undefined) {
      if (config.event_retention_days < 1 || config.event_retention_days > 365) {
        result.errors.push('event_retention_days must be between 1 and 365');
        result.isValid = false;
      }
    }

    // Validate cache settings
    if (config.cache_max_memory_mb !== undefined) {
      if (config.cache_max_memory_mb < 64 || config.cache_max_memory_mb > 2048) {
        result.warnings.push('cache_max_memory_mb should be between 64 and 2048 MB');
      }
    }

    // Validate WebSocket port
    if (config.websocket_port !== undefined) {
      if (config.websocket_port < 1024 || config.websocket_port > 65535) {
        result.errors.push('websocket_port must be between 1024 and 65535');
        result.isValid = false;
      }
    }

    // Validate log level
    if (config.log_level !== undefined) {
      if (!['debug', 'info', 'warn', 'error'].includes(config.log_level)) {
        result.errors.push('log_level must be one of: debug, info, warn, error');
        result.isValid = false;
      }
    }

    return result;
  }

  /**
   * Apply defaults for missing or invalid configuration values
   * Requirements: 7.5
   */
  private applyDefaults(
    config: Partial<AgentSkillsConfig>,
    result: ConfigMigrationResult
  ): AgentSkillsConfig {
    const finalConfig: AgentSkillsConfig = { ...DEFAULT_AGENT_SKILLS_CONFIG };

    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined && key in DEFAULT_AGENT_SKILLS_CONFIG) {
        // Validate the value before applying it
        const testConfig = { [key]: value };
        const validation = this.validateConfiguration(testConfig);
        
        if (validation.isValid) {
          // Value is valid, use it
          (finalConfig as any)[key] = value;
        } else {
          // Value is invalid, use default and track fallback
          result.fallbacksUsed.push(`${key}: invalid value ${JSON.stringify(value)}, using default ${JSON.stringify(DEFAULT_AGENT_SKILLS_CONFIG[key as keyof AgentSkillsConfig])}`);
        }
      }
    }

    // Track which defaults were used for missing values
    for (const [key, defaultValue] of Object.entries(DEFAULT_AGENT_SKILLS_CONFIG)) {
      if (config[key as keyof AgentSkillsConfig] === undefined) {
        result.fallbacksUsed.push(`${key}: missing value, using default ${JSON.stringify(defaultValue)}`);
      }
    }

    return finalConfig;
  }

  /**
   * Store configuration in the database
   * Requirements: 7.1
   */
  private async storeConfigurationInDatabase(config: AgentSkillsConfig): Promise<void> {
    const insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_skills_config (key, value, description, config_type, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    const configDescriptions: Record<keyof AgentSkillsConfig, string> = {
      auto_assignment_enabled: 'Enable automatic skill assignment to agents',
      competency_tracking_enabled: 'Enable competency score tracking and analytics',
      skill_recommendation_threshold: 'Minimum confidence threshold for skill recommendations',
      max_concurrent_assignments: 'Maximum number of concurrent skill assignments per agent',
      event_retention_days: 'Number of days to retain skill events in the database',
      performance_tracking_enabled: 'Enable performance analytics and metrics collection',
      cache_default_ttl_seconds: 'Default time-to-live for cache entries in seconds',
      cache_max_memory_mb: 'Maximum memory usage for in-memory cache in megabytes',
      websocket_enabled: 'Enable WebSocket server for real-time updates',
      websocket_port: 'Port number for WebSocket server',
      websocket_host: 'Host address for WebSocket server',
      database_connection_pool_size: 'Maximum number of database connections in pool',
      database_query_timeout_ms: 'Database query timeout in milliseconds',
      log_level: 'Logging level for Agent Skills operations',
      log_retention_days: 'Number of days to retain log files',
    };

    for (const [key, value] of Object.entries(config)) {
      const description = configDescriptions[key as keyof AgentSkillsConfig];
      insertStmt.run(key, JSON.stringify(value), description, 'system');
    }

    logger.info('Agent Skills configuration stored in database');
  }

  /**
   * Integrate with NeuroNest settings system
   * Requirements: 7.1, 7.4
   */
  private async integrateWithNeuroNestSettings(config: AgentSkillsConfig): Promise<void> {
    try {
      // Extend NeuroNest feature flags with Agent Skills settings
      const currentFlags = this.settingsManager.getFeatureFlags();
      this.settingsManager.setFeatureFlags({
        ...currentFlags,
        agentSkillsAutoAssignment: config.auto_assignment_enabled,
        agentSkillsCompetencyTracking: config.competency_tracking_enabled,
        agentSkillsPerformanceTracking: config.performance_tracking_enabled,
        agentSkillsWebSocket: config.websocket_enabled,
      });

      logger.info('Agent Skills configuration integrated with NeuroNest settings');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('Failed to integrate with NeuroNest settings', { error: errorMessage });
    }
  }

  /**
   * Fallback to default configuration on critical failure
   * Requirements: 7.5
   */
  private async fallbackToDefaults(result: ConfigMigrationResult): Promise<void> {
    try {
      logger.warn('Falling back to default Agent Skills configuration');
      
      await this.storeConfigurationInDatabase(DEFAULT_AGENT_SKILLS_CONFIG);
      await this.integrateWithNeuroNestSettings(DEFAULT_AGENT_SKILLS_CONFIG);
      
      result.migratedSettings = DEFAULT_AGENT_SKILLS_CONFIG;
      result.fallbacksUsed.push('Complete fallback to default configuration due to migration failure');
      
      logger.info('Default configuration fallback completed');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      result.errors.push(`Fallback to defaults failed: ${errorMessage}`);
      logger.error('Failed to apply default configuration fallback', { error: errorMessage });
    }
  }

  /**
   * Get current Agent Skills configuration from database
   */
  async getCurrentConfiguration(): Promise<AgentSkillsConfig> {
    const stmt = this.db.prepare('SELECT key, value FROM agent_skills_config WHERE config_type = ?');
    const rows = stmt.all('system') as Array<{ key: string; value: string }>;
    
    const config: Partial<AgentSkillsConfig> = {};
    
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value);
        if (row.key in DEFAULT_AGENT_SKILLS_CONFIG) {
          (config as any)[row.key] = value;
        }
      } catch (error) {
        logger.warn(`Failed to parse configuration value for key: ${row.key}`);
      }
    }
    
    // Apply defaults for missing values
    return { ...DEFAULT_AGENT_SKILLS_CONFIG, ...config };
  }

  /**
   * Update specific configuration value
   */
  async updateConfiguration(key: keyof AgentSkillsConfig, value: any): Promise<void> {
    // Validate the update
    const testConfig = { [key]: value };
    const validation = this.validateConfiguration(testConfig);
    
    if (!validation.isValid) {
      throw new Error(`Invalid configuration value: ${validation.errors.join(', ')}`);
    }
    
    const stmt = this.db.prepare(`
      UPDATE agent_skills_config 
      SET value = ?, updated_at = CURRENT_TIMESTAMP 
      WHERE key = ? AND config_type = 'system'
    `);
    
    stmt.run(JSON.stringify(value), key);
    
    logger.info(`Updated Agent Skills configuration: ${key} = ${JSON.stringify(value)}`);
  }
}