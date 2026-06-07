/**
 * Configuration Migration System Integration Example
 * 
 * This example demonstrates how to use the ConfigMigrationEngine to migrate
 * Agent Skills configuration from legacy microservice format to NeuroNest format.
 */

import Database from 'better-sqlite3';
import { ConfigMigrationEngine, type LegacyAgentSkillsConfig } from './config-migration.js';
import { SettingsManager } from '../settings/settings-manager.js';
import { up as migration004 } from '../storage/migrations/004-agent-skills-integration.js';

/**
 * Example: Migrate legacy Agent Skills configuration
 */
export async function migrateAgentSkillsConfiguration() {
  // 1. Set up database and apply migrations
  const db = new Database(':memory:');
  migration004(db);
  
  // 2. Create settings manager and migration engine
  const settingsManager = new SettingsManager();
  const migrationEngine = new ConfigMigrationEngine(db, settingsManager);
  
  // 3. Example legacy configuration from microservice
  const legacyConfig: LegacyAgentSkillsConfig = {
    features: {
      auto_assignment: true,
      competency_tracking: false,
      performance_analytics: true,
    },
    thresholds: {
      skill_recommendation: 0.8,
      max_assignments: 3,
    },
    retention: {
      events_days: 60,
      logs_days: 14,
    },
    server: {
      port: 4000,
      host: '0.0.0.0',
    },
    logging: {
      level: 'debug',
    },
  };
  
  // 4. Example environment variables
  const environmentVars = {
    'AGENT_SKILLS_AUTO_ASSIGNMENT': 'true',
    'AGENT_SKILLS_WEBSOCKET_PORT': '3002',
    'AGENT_SKILLS_LOG_LEVEL': 'info',
  };
  
  // 5. Example configuration files
  const configFiles = {
    'agent-skills.json': {
      cache_max_memory_mb: 512,
      performance_tracking_enabled: true,
    },
  };
  
  // 6. Perform migration
  console.log('Starting Agent Skills configuration migration...');
  
  const result = await migrationEngine.migrateConfiguration({
    legacyConfig,
    environmentVars,
    configFiles,
  });
  
  // 7. Display results
  console.log('Migration completed:', {
    success: result.success,
    errors: result.errors,
    warnings: result.warnings,
    fallbacksUsed: result.fallbacksUsed.length,
  });
  
  // 8. Show final configuration
  console.log('Final configuration:', result.migratedSettings);
  
  // 9. Verify configuration is stored in database
  const storedConfig = await migrationEngine.getCurrentConfiguration();
  console.log('Configuration stored in database:', storedConfig);
  
  // 10. Example of updating individual configuration values
  await migrationEngine.updateConfiguration('skill_recommendation_threshold', 0.9);
  console.log('Updated skill_recommendation_threshold to 0.9');
  
  const updatedConfig = await migrationEngine.getCurrentConfiguration();
  console.log('Updated configuration:', {
    skill_recommendation_threshold: updatedConfig.skill_recommendation_threshold,
  });
  
  // 11. Clean up
  db.close();
  
  return result;
}

/**
 * Example: Handle invalid configuration with fallbacks
 */
export async function handleInvalidConfiguration() {
  const db = new Database(':memory:');
  migration004(db);
  
  const settingsManager = new SettingsManager();
  const migrationEngine = new ConfigMigrationEngine(db, settingsManager);
  
  // Invalid configuration that will trigger fallbacks
  const invalidConfig: LegacyAgentSkillsConfig = {
    thresholds: {
      skill_recommendation: 1.5, // Invalid: > 1
      max_assignments: 0, // Invalid: < 1
    },
    server: {
      port: 80, // Invalid: < 1024
    },
    logging: {
      level: 'invalid', // Invalid: not in allowed values
    },
  };
  
  console.log('Migrating invalid configuration...');
  
  const result = await migrationEngine.migrateConfiguration({
    legacyConfig: invalidConfig,
  });
  
  console.log('Migration result:', {
    success: result.success,
    errors: result.errors,
    warnings: result.warnings,
    fallbacksUsed: result.fallbacksUsed,
  });
  
  console.log('Final configuration (with defaults applied):', {
    skill_recommendation_threshold: result.migratedSettings.skill_recommendation_threshold, // Should be 0.7 (default)
    max_concurrent_assignments: result.migratedSettings.max_concurrent_assignments, // Should be 5 (default)
    websocket_port: result.migratedSettings.websocket_port, // Should be 3001 (default)
    log_level: result.migratedSettings.log_level, // Should be 'info' (default)
  });
  
  db.close();
  
  return result;
}

/**
 * Example: Migration failure with complete fallback to defaults
 */
export async function handleMigrationFailure() {
  const db = new Database(':memory:');
  migration004(db);
  
  const settingsManager = new SettingsManager();
  const migrationEngine = new ConfigMigrationEngine(db, settingsManager);
  
  // Simulate database failure by closing the database
  db.close();
  
  console.log('Attempting migration with closed database (will fail)...');
  
  const result = await migrationEngine.migrateConfiguration({
    legacyConfig: { features: { auto_assignment: true } },
  });
  
  console.log('Migration result after failure:', {
    success: result.success,
    errors: result.errors,
    fallbacksUsed: result.fallbacksUsed.length,
  });
  
  // Configuration should still be available with defaults
  console.log('Configuration after failure:', {
    hasConfiguration: Object.keys(result.migratedSettings).length > 0,
    auto_assignment_enabled: result.migratedSettings.auto_assignment_enabled,
  });
  
  return result;
}

// Run examples if this file is executed directly
if (process.argv[1] && process.argv[1].includes('config-migration-example')) {
  (async () => {
    console.log('=== Agent Skills Configuration Migration Examples ===\n');
    
    console.log('1. Standard Migration:');
    await migrateAgentSkillsConfiguration();
    
    console.log('\n2. Invalid Configuration Handling:');
    await handleInvalidConfiguration();
    
    console.log('\n3. Migration Failure Handling:');
    await handleMigrationFailure();
    
    console.log('\n=== Examples completed ===');
  })().catch(console.error);
}