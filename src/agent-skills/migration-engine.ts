import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Types for migration operations
export interface MigrationProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
  timestamp: Date;
}

export interface MigrationResult {
  success: boolean;
  migratedSkills: number;
  migratedAgents: number;
  migratedAssignments: number;
  migratedEvents: number;
  errors: string[];
  warnings: string[];
  duration: number;
  checksum: string;
}

export interface MigrationCheckpoint {
  id: string;
  timestamp: Date;
  phase: string;
  data: any;
  checksum: string;
}

export interface AgentSkillsData {
  skills: AgentSkillsSkill[];
  agents: AgentSkillsAgent[];
  assignments: AgentSkillsAssignment[];
  events: AgentSkillsEvent[];
  config: Record<string, any>;
}

// Agent Skills microservice data types
export interface AgentSkillsSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string;
  requirements: any[];
  access_level: string;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface AgentSkillsAgent {
  id: string;
  name: string;
  specialty: string;
  capabilities: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

export interface AgentSkillsAssignment {
  agent_id: string;
  skill_id: string;
  competency_level: string;
  assignment_type: string;
  assigned_at: Date;
  last_used?: Date;
  performance_metrics: Record<string, any>;
}

export interface AgentSkillsEvent {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  event_data: Record<string, any>;
  timestamp: Date;
  correlation_id?: string;
  source?: string;
}

/**
 * MigrationEngine class for integrating Agent Skills microservice data
 * into the existing NeuroNest SQLite database while preserving all existing data.
 * 
 * Requirements: 1.3, 1.5, 1.6, 9.1, 9.2, 9.3
 */
export class MigrationEngine extends EventEmitter {
  private db: Database.Database;
  private checkpoints: MigrationCheckpoint[] = [];
  private startTime: number = 0;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  /**
   * Main migration method that integrates Agent Skills data into existing NeuroNest database
   * while preserving all existing skills and agent data.
   */
  async migrate(agentSkillsData: AgentSkillsData, options: {
    dryRun?: boolean;
    validateOnly?: boolean;
    preserveExisting?: boolean;
  } = {}): Promise<MigrationResult> {
    const { dryRun = false, validateOnly = false, preserveExisting = true } = options;
    
    this.startTime = Date.now();
    const result: MigrationResult = {
      success: false,
      migratedSkills: 0,
      migratedAgents: 0,
      migratedAssignments: 0,
      migratedEvents: 0,
      errors: [],
      warnings: [],
      duration: 0,
      checksum: ''
    };

    try {
      this.emitProgress('validation', 0, 100, 'Starting migration validation');

      // Phase 1: Validate input data and existing database state
      await this.validateInputData(agentSkillsData);
      await this.validateExistingData();
      this.emitProgress('validation', 100, 100, 'Validation completed');

      if (validateOnly) {
        result.success = true;
        result.duration = Date.now() - this.startTime;
        return result;
      }

      // Create initial checkpoint
      const initialCheckpoint = await this.createCheckpoint('initial', {
        existingSkillsCount: this.getExistingSkillsCount(),
        existingAgentsCount: this.getExistingAgentsCount()
      });

      if (!dryRun) {
        // Begin transaction for atomic migration
        this.db.exec('BEGIN TRANSACTION');
      }

      try {
        // Phase 2: Migrate skills (only new ones, preserve existing)
        this.emitProgress('skills', 0, agentSkillsData.skills.length, 'Migrating skills');
        result.migratedSkills = await this.migrateSkills(agentSkillsData.skills, { dryRun, preserveExisting });
        this.emitProgress('skills', agentSkillsData.skills.length, agentSkillsData.skills.length, 'Skills migration completed');

        // Phase 3: Migrate agent data (extend existing agent system)
        this.emitProgress('agents', 0, agentSkillsData.agents.length, 'Migrating agent data');
        result.migratedAgents = await this.migrateAgents(agentSkillsData.agents, { dryRun, preserveExisting });
        this.emitProgress('agents', agentSkillsData.agents.length, agentSkillsData.agents.length, 'Agent migration completed');

        // Phase 4: Migrate skill assignments
        this.emitProgress('assignments', 0, agentSkillsData.assignments.length, 'Migrating skill assignments');
        result.migratedAssignments = await this.migrateAssignments(agentSkillsData.assignments, { dryRun });
        this.emitProgress('assignments', agentSkillsData.assignments.length, agentSkillsData.assignments.length, 'Assignments migration completed');

        // Phase 5: Migrate events
        this.emitProgress('events', 0, agentSkillsData.events.length, 'Migrating events');
        result.migratedEvents = await this.migrateEvents(agentSkillsData.events, { dryRun });
        this.emitProgress('events', agentSkillsData.events.length, agentSkillsData.events.length, 'Events migration completed');

        // Phase 6: Migrate configuration
        this.emitProgress('config', 0, 1, 'Migrating configuration');
        await this.migrateConfiguration(agentSkillsData.config, { dryRun });
        this.emitProgress('config', 1, 1, 'Configuration migration completed');

        // Phase 7: Validate migrated data
        this.emitProgress('final-validation', 0, 100, 'Performing final validation');
        await this.validateMigratedData(agentSkillsData, dryRun);
        this.emitProgress('final-validation', 100, 100, 'Final validation completed');

        // Calculate final checksum
        result.checksum = await this.calculateDataChecksum();

        if (!dryRun) {
          this.db.exec('COMMIT');
        }

        result.success = true;
        this.emitProgress('complete', 100, 100, 'Migration completed successfully');

      } catch (error) {
        if (!dryRun) {
          this.db.exec('ROLLBACK');
        }
        
        // Attempt to rollback to initial checkpoint
        await this.rollbackToCheckpoint(initialCheckpoint.id);
        
        throw error;
      }

    } catch (error) {
      result.success = false;
      result.errors.push(`Migration error: ${error instanceof Error ? error.message : String(error)}`);
      result.duration = Date.now() - this.startTime;
      
      // For validation errors, throw the error to maintain expected behavior
      if (validateOnly || error instanceof Error && error.message.includes('Invalid')) {
        throw error;
      }
      
      return result;
    }

    result.duration = Date.now() - this.startTime;
    return result;
  }

  /**
   * Migrate skills from Agent Skills microservice to existing NeuroNest skills table
   * Only adds new skills, preserves all existing NeuroNest skills
   */
  private async migrateSkills(skills: AgentSkillsSkill[], options: { dryRun: boolean; preserveExisting: boolean }): Promise<number> {
    let migratedCount = 0;
    const { dryRun, preserveExisting } = options;

    // Get existing skill IDs to avoid conflicts
    const existingSkillIds = new Set(
      this.db.prepare('SELECT id FROM skills').all().map((row: any) => row.id)
    );

    const insertSkillStmt = this.db.prepare(`
      INSERT INTO skills (
        id, name, description, source, version, category, tags, scope,
        enabled, installed, content, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const skill of skills) {
      try {
        // Skip if skill already exists and we're preserving existing data
        if (preserveExisting && existingSkillIds.has(skill.id)) {
          const warningMsg = `Skill ${skill.id} already exists, skipping to preserve existing data`;
          this.emit('warning', warningMsg);
          continue;
        }

        if (!dryRun) {
          // Map Agent Skills data to NeuroNest schema
          const neuronestSkill = this.mapAgentSkillToNeuroNest(skill);
          
          insertSkillStmt.run(
            neuronestSkill.id,
            neuronestSkill.name,
            neuronestSkill.description,
            neuronestSkill.source,
            neuronestSkill.version,
            neuronestSkill.category,
            neuronestSkill.tags,
            neuronestSkill.scope,
            neuronestSkill.enabled ? 1 : 0, // Convert boolean to integer for SQLite
            neuronestSkill.installed ? 1 : 0, // Convert boolean to integer for SQLite
            neuronestSkill.content,
            neuronestSkill.metadata,
            neuronestSkill.created_at,
            neuronestSkill.updated_at
          );
        }

        migratedCount++;
        this.emitProgress('skills', migratedCount, skills.length, `Migrated skill: ${skill.name}`);

      } catch (error) {
        const errorMsg = `Failed to migrate skill ${skill.id}: ${error instanceof Error ? error.message : String(error)}`;
        this.emit('error', errorMsg);
        throw new Error(errorMsg);
      }
    }

    return migratedCount;
  }

  /**
   * Migrate agent data by extending existing NeuroNest agent system
   * Preserves all existing agent data and adds Agent Skills metadata
   */
  private async migrateAgents(agents: AgentSkillsAgent[], options: { dryRun: boolean; preserveExisting: boolean }): Promise<number> {
    let migratedCount = 0;
    const { dryRun, preserveExisting } = options;

    // Check if agents exist in existing agent_runtimes table
    const existingAgentIds = new Set(
      this.db.prepare('SELECT id FROM agent_runtimes').all().map((row: any) => row.id)
    );

    const insertAgentStmt = this.db.prepare(`
      INSERT OR IGNORE INTO agent_runtimes (
        id, name, type, status, capabilities, resources, config, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const agent of agents) {
      try {
        // Skip if agent already exists and we're preserving existing data
        if (preserveExisting && existingAgentIds.has(agent.id)) {
          const warningMsg = `Agent ${agent.id} already exists, skipping to preserve existing data`;
          this.emit('warning', warningMsg);
          continue;
        }

        if (!dryRun) {
          // Map Agent Skills agent to NeuroNest agent_runtimes format
          insertAgentStmt.run(
            agent.id,
            agent.name,
            'local', // Default type for migrated agents
            'active', // Default status
            JSON.stringify(agent.capabilities),
            JSON.stringify({}), // Default empty resources
            JSON.stringify({ specialty: agent.specialty }), // Store specialty in config
            agent.created_at.toISOString(),
            agent.updated_at.toISOString()
          );
        }

        migratedCount++;
        this.emitProgress('agents', migratedCount, agents.length, `Migrated agent: ${agent.name}`);

      } catch (error) {
        const errorMsg = `Failed to migrate agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`;
        this.emit('error', errorMsg);
        throw new Error(errorMsg);
      }
    }

    return migratedCount;
  }

  /**
   * Migrate skill assignments to existing agent_skill_assignments table
   */
  private async migrateAssignments(assignments: AgentSkillsAssignment[], options: { dryRun: boolean }): Promise<number> {
    let migratedCount = 0;
    const { dryRun } = options;

    const insertAssignmentStmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_skill_assignments (
        agent_id, skill_id, proficiency_level, success_rate,
        total_executions, successful_executions, avg_execution_time_ms,
        last_used_at, learned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const assignment of assignments) {
      try {
        if (!dryRun) {
          // Map competency levels from Agent Skills to NeuroNest format
          const proficiencyLevel = this.mapCompetencyLevel(assignment.competency_level);
          const metrics = assignment.performance_metrics || {};
          
          insertAssignmentStmt.run(
            assignment.agent_id,
            assignment.skill_id,
            proficiencyLevel,
            metrics.successRate || 0.0,
            metrics.totalExecutions || 0,
            metrics.successfulExecutions || 0,
            metrics.avgExecutionTime || 0,
            assignment.last_used?.toISOString() || null,
            assignment.assigned_at.toISOString()
          );
        }

        migratedCount++;
        this.emitProgress('assignments', migratedCount, assignments.length, `Migrated assignment: ${assignment.agent_id} -> ${assignment.skill_id}`);

      } catch (error) {
        const errorMsg = `Failed to migrate assignment ${assignment.agent_id}-${assignment.skill_id}: ${error instanceof Error ? error.message : String(error)}`;
        this.emit('error', errorMsg);
        throw new Error(errorMsg);
      }
    }

    return migratedCount;
  }

  /**
   * Migrate events to skill_events table
   */
  private async migrateEvents(events: AgentSkillsEvent[], options: { dryRun: boolean }): Promise<number> {
    let migratedCount = 0;
    const { dryRun } = options;

    const insertEventStmt = this.db.prepare(`
      INSERT INTO skill_events (
        id, event_type, entity_type, entity_id, event_data,
        timestamp, correlation_id, source, partition_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const event of events) {
      try {
        if (!dryRun) {
          insertEventStmt.run(
            event.id,
            event.event_type,
            event.entity_type,
            event.entity_id,
            JSON.stringify(event.event_data),
            event.timestamp.toISOString(),
            event.correlation_id || null,
            event.source || 'agent-skills-migration',
            event.timestamp.toISOString().split('T')[0] // Extract date for partition
          );
        }

        migratedCount++;
        this.emitProgress('events', migratedCount, events.length, `Migrated event: ${event.event_type}`);

      } catch (error) {
        const errorMsg = `Failed to migrate event ${event.id}: ${error instanceof Error ? error.message : String(error)}`;
        this.emit('error', errorMsg);
        throw new Error(errorMsg);
      }
    }

    return migratedCount;
  }

  /**
   * Migrate configuration to agent_skills_config table
   */
  private async migrateConfiguration(config: Record<string, any>, options: { dryRun: boolean }): Promise<void> {
    const { dryRun } = options;

    if (!dryRun) {
      const insertConfigStmt = this.db.prepare(`
        INSERT OR REPLACE INTO agent_skills_config (key, value, description, config_type)
        VALUES (?, ?, ?, ?)
      `);

      for (const [key, value] of Object.entries(config)) {
        insertConfigStmt.run(
          key,
          JSON.stringify(value),
          `Migrated from Agent Skills microservice`,
          'system' // Use 'system' instead of 'migrated' to satisfy CHECK constraint
        );
      }
    }
  }

  /**
   * Map Agent Skills skill to NeuroNest skills table format
   */
  protected mapAgentSkillToNeuroNest(skill: AgentSkillsSkill): any {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: 'custom', // Mark as custom since it's from Agent Skills
      version: skill.version,
      category: skill.category,
      tags: JSON.stringify([]), // Default empty tags
      scope: 'agent', // Agent-specific scope
      enabled: true,
      installed: true,
      content: JSON.stringify({
        requirements: skill.requirements,
        access_level: skill.access_level
      }),
      metadata: JSON.stringify({
        ...skill.metadata,
        agent_skills_metadata: {
          original_access_level: skill.access_level,
          migrated_at: new Date().toISOString(),
          migration_source: 'agent-skills-microservice'
        }
      }),
      created_at: skill.created_at.toISOString(),
      updated_at: skill.updated_at.toISOString()
    };
  }

  /**
   * Map Agent Skills competency levels to NeuroNest proficiency levels
   */
  private mapCompetencyLevel(competencyLevel: string): string {
    const mapping: Record<string, string> = {
      'novice': 'beginner',
      'intermediate': 'intermediate',
      'advanced': 'advanced',
      'expert': 'expert'
    };
    return mapping[competencyLevel] || 'beginner';
  }

  /**
   * Validate input data structure and integrity
   */
  private async validateInputData(data: AgentSkillsData): Promise<void> {
    if (!data.skills || !Array.isArray(data.skills)) {
      throw new Error('Invalid skills data: must be an array');
    }

    if (!data.agents || !Array.isArray(data.agents)) {
      throw new Error('Invalid agents data: must be an array');
    }

    if (!data.assignments || !Array.isArray(data.assignments)) {
      throw new Error('Invalid assignments data: must be an array');
    }

    if (!data.events || !Array.isArray(data.events)) {
      throw new Error('Invalid events data: must be an array');
    }

    // Validate required fields for each skill
    for (const skill of data.skills) {
      if (!skill.id || !skill.name || !skill.description) {
        throw new Error(`Invalid skill data: missing required fields for skill ${skill.id}`);
      }
    }

    // Validate required fields for each agent
    for (const agent of data.agents) {
      if (!agent.id || !agent.name) {
        throw new Error(`Invalid agent data: missing required fields for agent ${agent.id}`);
      }
    }

    // Validate assignment references
    const skillIds = new Set(data.skills.map(s => s.id));
    const agentIds = new Set(data.agents.map(a => a.id));

    for (const assignment of data.assignments) {
      if (!skillIds.has(assignment.skill_id)) {
        throw new Error(`Assignment references non-existent skill: ${assignment.skill_id}`);
      }
      if (!agentIds.has(assignment.agent_id)) {
        throw new Error(`Assignment references non-existent agent: ${assignment.agent_id}`);
      }
    }
  }

  /**
   * Validate existing database state
   */
  private async validateExistingData(): Promise<void> {
    // Check that required tables exist
    const requiredTables = ['skills', 'agent_skill_assignments', 'agent_runtimes', 'skill_events', 'agent_skills_config'];
    
    for (const table of requiredTables) {
      const result = this.db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name=?
      `).get(table);
      
      if (!result) {
        throw new Error(`Required table '${table}' does not exist in database`);
      }
    }

    // Validate existing data integrity
    const skillsCount = this.getExistingSkillsCount();
    const agentsCount = this.getExistingAgentsCount();
    
    this.emit('info', `Found ${skillsCount} existing skills and ${agentsCount} existing agents`);
  }

  /**
   * Validate migrated data integrity
   */
  private async validateMigratedData(originalData: AgentSkillsData, dryRun: boolean = false): Promise<void> {
    if (dryRun) {
      // Skip validation for dry runs since no data was actually migrated
      return;
    }

    // Verify skill counts
    const finalSkillsCount = this.getExistingSkillsCount();
    const expectedMinSkills = this.getInitialSkillsCount();
    
    if (finalSkillsCount < expectedMinSkills) {
      throw new Error(`Data validation failed: expected at least ${expectedMinSkills} skills, found ${finalSkillsCount}`);
    }

    // Verify assignment integrity
    const assignmentCount = this.db.prepare('SELECT COUNT(*) as count FROM agent_skill_assignments').get() as any;
    if (assignmentCount.count < originalData.assignments.length) {
      throw new Error(`Assignment validation failed: expected at least ${originalData.assignments.length} assignments`);
    }

    // Verify referential integrity
    const orphanedAssignments = this.db.prepare(`
      SELECT COUNT(*) as count FROM agent_skill_assignments asa
      LEFT JOIN skills s ON asa.skill_id = s.id
      WHERE s.id IS NULL
    `).get() as any;

    if (orphanedAssignments.count > 0) {
      throw new Error(`Referential integrity violation: ${orphanedAssignments.count} orphaned assignments found`);
    }
  }

  /**
   * Create a checkpoint for rollback purposes
   */
  private async createCheckpoint(phase: string, data: any): Promise<MigrationCheckpoint> {
    const checkpoint: MigrationCheckpoint = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      phase,
      data,
      checksum: this.calculateChecksum(JSON.stringify(data))
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Rollback to a specific checkpoint
   */
  private async rollbackToCheckpoint(checkpointId: string): Promise<void> {
    const checkpoint = this.checkpoints.find(cp => cp.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    this.emit('info', `Rolling back to checkpoint: ${checkpoint.phase} at ${checkpoint.timestamp}`);
    
    // Implementation would restore database state to checkpoint
    // For now, we rely on transaction rollback
  }

  /**
   * Calculate checksum for data integrity verification
   */
  private calculateChecksum(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Calculate checksum of current database state
   */
  private async calculateDataChecksum(): Promise<string> {
    // Get data without timestamps to ensure consistent checksums
    const skillsData = this.db.prepare(`
      SELECT id, name, description, source, version, category, tags, scope, 
             enabled, installed, content, metadata
      FROM skills ORDER BY id
    `).all();
    
    const assignmentsData = this.db.prepare(`
      SELECT agent_id, skill_id, proficiency_level, success_rate, 
             total_executions, successful_executions, avg_execution_time_ms
      FROM agent_skill_assignments ORDER BY agent_id, skill_id
    `).all();
    
    const combinedData = JSON.stringify({ skills: skillsData, assignments: assignmentsData });
    return this.calculateChecksum(combinedData);
  }

  /**
   * Get count of existing skills
   */
  private getExistingSkillsCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM skills').get() as any;
    return result.count;
  }

  /**
   * Get count of existing agents
   */
  private getExistingAgentsCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM agent_runtimes').get() as any;
    return result.count;
  }

  /**
   * Store initial skills count for validation
   */
  private initialSkillsCount: number = 0;
  
  private getInitialSkillsCount(): number {
    if (this.initialSkillsCount === 0) {
      this.initialSkillsCount = this.getExistingSkillsCount();
    }
    return this.initialSkillsCount;
  }

  /**
   * Emit progress events
   */
  private emitProgress(phase: string, current: number, total: number, message: string): void {
    const progress: MigrationProgress = {
      phase,
      current,
      total,
      message,
      timestamp: new Date()
    };
    
    this.emit('progress', progress);
  }
}