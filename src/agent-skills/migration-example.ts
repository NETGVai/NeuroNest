import { MigrationEngine, type AgentSkillsData } from './migration-engine.js';
import { initDatabase } from '../storage/database.js';

/**
 * Example usage of the MigrationEngine for integrating Agent Skills microservice data
 * into the existing NeuroNest SQLite database.
 * 
 * This example demonstrates how to:
 * 1. Load Agent Skills data from the microservice
 * 2. Validate the data before migration
 * 3. Perform the migration with progress monitoring
 * 4. Handle errors and rollback if needed
 */

async function migrateAgentSkillsData() {
  // Initialize the NeuroNest database
  const db = initDatabase();
  
  // Create the migration engine
  const migrationEngine = new MigrationEngine(db);
  
  // Example Agent Skills data (in practice, this would come from the microservice database)
  const agentSkillsData: AgentSkillsData = {
    skills: [
      {
        id: 'typescript-development',
        name: 'TypeScript Development',
        description: 'Advanced TypeScript programming and application development',
        category: 'technical',
        version: '2.1.0',
        requirements: [
          { type: 'prerequisite', value: 'javascript-fundamentals' },
          { type: 'tool', value: 'typescript-compiler' }
        ],
        access_level: 'public',
        metadata: {
          complexity: 'advanced',
          tags: ['programming', 'web-development', 'typescript'],
          estimated_learning_time: '40 hours'
        },
        created_at: new Date('2024-01-15'),
        updated_at: new Date('2024-01-20')
      },
      {
        id: 'ui-design',
        name: 'User Interface Design',
        description: 'Creating intuitive and accessible user interfaces',
        category: 'creative',
        version: '1.5.0',
        requirements: [
          { type: 'tool', value: 'figma' },
          { type: 'knowledge', value: 'design-principles' }
        ],
        access_level: 'public',
        metadata: {
          complexity: 'intermediate',
          tags: ['design', 'ui', 'accessibility'],
          estimated_learning_time: '25 hours'
        },
        created_at: new Date('2024-01-10'),
        updated_at: new Date('2024-01-18')
      }
    ],
    agents: [
      {
        id: 'dev-agent-001',
        name: 'Development Specialist',
        specialty: 'full-stack-development',
        capabilities: {
          languages: ['typescript', 'python', 'rust'],
          frameworks: ['react', 'node.js', 'fastapi'],
          tools: ['git', 'docker', 'kubernetes']
        },
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-15')
      },
      {
        id: 'design-agent-001',
        name: 'Design Specialist',
        specialty: 'ui-ux-design',
        capabilities: {
          tools: ['figma', 'sketch', 'adobe-creative-suite'],
          skills: ['user-research', 'prototyping', 'accessibility-testing'],
          methodologies: ['design-thinking', 'agile-design']
        },
        created_at: new Date('2024-01-05'),
        updated_at: new Date('2024-01-12')
      }
    ],
    assignments: [
      {
        agent_id: 'dev-agent-001',
        skill_id: 'typescript-development',
        competency_level: 'expert',
        assignment_type: 'auto_assigned',
        assigned_at: new Date('2024-01-16'),
        last_used: new Date('2024-01-22'),
        performance_metrics: {
          successRate: 0.95,
          totalExecutions: 50,
          successfulExecutions: 47,
          avgExecutionTime: 1200
        }
      },
      {
        agent_id: 'design-agent-001',
        skill_id: 'ui-design',
        competency_level: 'advanced',
        assignment_type: 'manually_assigned',
        assigned_at: new Date('2024-01-11'),
        last_used: new Date('2024-01-19'),
        performance_metrics: {
          successRate: 0.88,
          totalExecutions: 25,
          successfulExecutions: 22,
          avgExecutionTime: 2400
        }
      }
    ],
    events: [
      {
        id: 'event-001',
        event_type: 'skill_assigned',
        entity_type: 'assignment',
        entity_id: 'dev-agent-001-typescript-development',
        event_data: {
          reason: 'high_competency_match',
          confidence: 0.95,
          algorithm: 'skill-matching-v2'
        },
        timestamp: new Date('2024-01-16T10:30:00Z'),
        correlation_id: 'assignment-batch-001',
        source: 'auto-assignment-engine'
      },
      {
        id: 'event-002',
        event_type: 'skill_executed',
        entity_type: 'task',
        entity_id: 'task-typescript-refactor-001',
        event_data: {
          duration_ms: 1200,
          success: true,
          quality_score: 0.92,
          lines_of_code: 450
        },
        timestamp: new Date('2024-01-22T14:15:00Z'),
        correlation_id: 'execution-session-001',
        source: 'execution-engine'
      }
    ],
    config: {
      auto_assignment_enabled: true,
      skill_recommendation_threshold: 0.8,
      max_concurrent_assignments: 3,
      competency_tracking_enabled: true,
      performance_analytics_enabled: true
    }
  };

  // Set up progress monitoring
  migrationEngine.on('progress', (progress) => {
    console.log(`[${progress.phase}] ${progress.current}/${progress.total} - ${progress.message}`);
  });

  // Set up warning monitoring
  migrationEngine.on('warning', (warning) => {
    console.warn(`⚠️  ${warning}`);
  });

  // Set up error monitoring
  migrationEngine.on('error', (error) => {
    console.error(`❌ ${error}`);
  });

  try {
    console.log('🚀 Starting Agent Skills data migration...');
    
    // Step 1: Validate data before migration
    console.log('📋 Validating data...');
    const validationResult = await migrationEngine.migrate(agentSkillsData, { 
      validateOnly: true 
    });
    
    if (!validationResult.success) {
      console.error('❌ Data validation failed:', validationResult.errors);
      return;
    }
    
    console.log('✅ Data validation passed');

    // Step 2: Perform dry run to test migration without making changes
    console.log('🧪 Performing dry run...');
    const dryRunResult = await migrationEngine.migrate(agentSkillsData, { 
      dryRun: true 
    });
    
    if (!dryRunResult.success) {
      console.error('❌ Dry run failed:', dryRunResult.errors);
      return;
    }
    
    console.log('✅ Dry run completed successfully');
    console.log(`   - Would migrate ${dryRunResult.migratedSkills} skills`);
    console.log(`   - Would migrate ${dryRunResult.migratedAgents} agents`);
    console.log(`   - Would migrate ${dryRunResult.migratedAssignments} assignments`);
    console.log(`   - Would migrate ${dryRunResult.migratedEvents} events`);

    // Step 3: Perform actual migration
    console.log('💾 Performing actual migration...');
    const migrationResult = await migrationEngine.migrate(agentSkillsData, {
      preserveExisting: true // Preserve all existing NeuroNest data
    });
    
    if (!migrationResult.success) {
      console.error('❌ Migration failed:', migrationResult.errors);
      if (migrationResult.warnings.length > 0) {
        console.warn('⚠️  Warnings:', migrationResult.warnings);
      }
      return;
    }

    // Step 4: Report migration results
    console.log('🎉 Migration completed successfully!');
    console.log(`   ✅ Migrated ${migrationResult.migratedSkills} skills`);
    console.log(`   ✅ Migrated ${migrationResult.migratedAgents} agents`);
    console.log(`   ✅ Migrated ${migrationResult.migratedAssignments} assignments`);
    console.log(`   ✅ Migrated ${migrationResult.migratedEvents} events`);
    console.log(`   ⏱️  Duration: ${migrationResult.duration}ms`);
    console.log(`   🔐 Checksum: ${migrationResult.checksum.substring(0, 16)}...`);
    
    if (migrationResult.warnings.length > 0) {
      console.log(`   ⚠️  Warnings: ${migrationResult.warnings.length}`);
      migrationResult.warnings.forEach(warning => console.warn(`      - ${warning}`));
    }

  } catch (error) {
    console.error('💥 Migration failed with error:', error);
    
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack trace:', error.stack);
    }
  } finally {
    // Clean up
    db.close();
    console.log('🔒 Database connection closed');
  }
}

// Example of how to run the migration
// Note: This check is disabled due to TypeScript module configuration
// if (import.meta.url === `file://${process.argv[1]}`) {
//   migrateAgentSkillsData()
//     .then(() => {
//       console.log('✨ Migration process completed');
//       process.exit(0);
//     })
//     .catch((error) => {
//       console.error('💥 Migration process failed:', error);
//       process.exit(1);
//     });
// }

export { migrateAgentSkillsData };