import Database from 'better-sqlite3';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { logger } from '../utils/logger.js';
import { agentSkillsErrorHandler, ErrorContext } from './error-handler.js';

/**
 * Agent Skills Service
 * 
 * Provides Agent Skills functionality using the existing NeuroNest database schema.
 * This service integrates with the existing skills and agent_skill_assignments tables
 * and extends them with Agent Skills-specific functionality.
 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'local' | 'bundled' | 'custom' | 'workspace';
  version: string;
  category: string;
  tags: string[];
  scope: 'global' | 'workspace' | 'project' | 'agent';
  entrypoint?: string;
  enabled: boolean;
  installed: boolean;
  content: string;
  metadata: Record<string, any>;
  bundled_skill_id?: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSkillAssignment {
  agent_id: string;
  skill_id: string;
  proficiency_level: 'beginner' | 'intermediate' | 'advanced' | 'expert';
  success_rate: number;
  total_executions: number;
  successful_executions: number;
  avg_execution_time_ms: number;
  last_used_at?: string;
  learned_at: string;
}

export interface SkillEvent {
  id: string;
  event_type: string;
  entity_type: 'skill' | 'agent' | 'assignment' | 'task';
  entity_id: string;
  event_data?: Record<string, any>;
  timestamp: string;
  correlation_id?: string;
  source?: string;
  session_id?: string;
}

export interface CreateSkillRequest {
  name: string;
  description: string;
  category?: string;
  tags?: string[];
  scope?: 'global' | 'workspace' | 'project' | 'agent';
  content: string;
  metadata?: Record<string, any>;
}

export interface UpdateSkillRequest {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  enabled?: boolean;
  content?: string;
  metadata?: Record<string, any>;
}

export interface SkillSearchCriteria {
  query?: string;
  category?: string;
  tags?: string[];
  scope?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export class AgentSkillsService {
  private adapter: SQLiteAdapter;

  constructor(database: Database.Database) {
    this.adapter = new SQLiteAdapter(database);
    this.adapter.registerCustomFunctions();
    this.adapter.optimizeIndexes();
  }

  /**
   * Create a new skill with comprehensive error handling
   */
  async createSkill(skillData: CreateSkillRequest): Promise<Skill> {
    const context: ErrorContext = {
      component: 'agent-skills-service',
      operation: 'createSkill',
      metadata: { skillName: skillData.name, category: skillData.category },
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      const id = this.generateId();
      const now = new Date().toISOString();
      
      // Prepare metadata with Agent Skills extensions
      const metadata = {
        ...skillData.metadata,
        agent_skills_metadata: {
          auto_assignment_enabled: true,
          competency_tracking: true,
          created_by: 'agent-skills-service'
        }
      };

      const query = `
        INSERT INTO skills (
          id, name, description, source, version, category, tags, scope,
          enabled, installed, content, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        id,
        skillData.name,
        skillData.description,
        'custom', // Agent Skills created skills are marked as custom
        '1.0.0',
        skillData.category || 'general',
        JSON.stringify(skillData.tags || []),
        skillData.scope || 'project',
        1, // enabled by default (boolean -> integer)
        1, // installed by default (boolean -> integer)
        skillData.content,
        JSON.stringify(metadata),
        now,
        now
      ];

      await this.adapter.executeModifyQuery(query, params);

      // Record skill creation event
      await this.recordSkillEvent('skill_created', 'skill', id, {
        name: skillData.name,
        category: skillData.category || 'general'
      });

      const createdSkill = await this.getSkillById(id);
      if (!createdSkill) {
        throw new Error(`Failed to retrieve created skill: ${id}`);
      }
      
      return createdSkill;
    }, context, {
      maxRetries: 3,
      baseDelay: 1000,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_CONSTRAINT']
    });
  }

  /**
   * Get a skill by ID with error handling
   */
  async getSkillById(id: string): Promise<Skill | null> {
    const context: ErrorContext = {
      component: 'agent-skills-service',
      operation: 'getSkillById',
      metadata: { skillId: id },
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      const query = 'SELECT * FROM skills WHERE id = ?';
      const result = await this.adapter.executeQuerySingle(query, [id]);
      
      return result ? this.mapRowToSkill(result) : null;
    }, context, {
      maxRetries: 2,
      baseDelay: 500,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED']
    });
  }

  /**
   * Search skills using the existing skills table with Agent Skills extensions
   */
  async searchSkills(criteria: SkillSearchCriteria): Promise<Skill[]> {
    try {
      let query = 'SELECT * FROM skills WHERE 1=1';
      const params: any[] = [];

      // Text search across name and description
      if (criteria.query) {
        query += ' AND (name LIKE ? OR description LIKE ?)';
        const searchTerm = `%${criteria.query}%`;
        params.push(searchTerm, searchTerm);
      }

      // Category filter
      if (criteria.category) {
        query += ' AND category = ?';
        params.push(criteria.category);
      }

      // Scope filter
      if (criteria.scope) {
        query += ' AND scope = ?';
        params.push(criteria.scope);
      }

      // Enabled filter
      if (criteria.enabled !== undefined) {
        query += ' AND enabled = ?';
        params.push(criteria.enabled ? 1 : 0);
      }

      // Tags filter using JSON operations
      if (criteria.tags && criteria.tags.length > 0) {
        const tagConditions = criteria.tags.map(() => 'tags LIKE ?').join(' OR ');
        query += ` AND (${tagConditions})`;
        criteria.tags.forEach(tag => params.push(`%"${tag}"%`));
      }

      // Ordering
      query += ' ORDER BY name';

      // Pagination
      if (criteria.limit) {
        query += ' LIMIT ?';
        params.push(criteria.limit);
      }

      if (criteria.offset) {
        query += ' OFFSET ?';
        params.push(criteria.offset);
      }

      const results = await this.adapter.executeQuery(query, params);
      return results.map(row => this.mapRowToSkill(row));
    } catch (error) {
      logger.error('Failed to search skills:', { error, criteria });
      throw error;
    }
  }

  /**
   * Update a skill in the existing skills table
   */
  async updateSkill(id: string, updates: UpdateSkillRequest): Promise<Skill | null> {
    try {
      const setClause: string[] = [];
      const params: any[] = [];

      if (updates.name !== undefined) {
        setClause.push('name = ?');
        params.push(updates.name);
      }
      if (updates.description !== undefined) {
        setClause.push('description = ?');
        params.push(updates.description);
      }
      if (updates.category !== undefined) {
        setClause.push('category = ?');
        params.push(updates.category);
      }
      if (updates.tags !== undefined) {
        setClause.push('tags = ?');
        params.push(JSON.stringify(updates.tags));
      }
      if (updates.enabled !== undefined) {
        setClause.push('enabled = ?');
        params.push(updates.enabled ? 1 : 0); // Convert boolean to integer
      }
      if (updates.content !== undefined) {
        setClause.push('content = ?');
        params.push(updates.content);
      }
      if (updates.metadata !== undefined) {
        setClause.push('metadata = ?');
        params.push(JSON.stringify(updates.metadata));
      }

      if (setClause.length === 0) {
        return await this.getSkillById(id);
      }

      setClause.push('updated_at = ?');
      params.push(new Date().toISOString());
      params.push(id);

      const query = `UPDATE skills SET ${setClause.join(', ')} WHERE id = ?`;
      const result = await this.adapter.executeModifyQuery(query, params);

      if (result.changes > 0) {
        // Record skill update event
        await this.recordSkillEvent('skill_updated', 'skill', id, updates);
        return await this.getSkillById(id);
      }

      return null;
    } catch (error) {
      logger.error('Failed to update skill:', { error, id, updates });
      throw error;
    }
  }

  /**
   * Assign a skill to an agent using the existing agent_skill_assignments table
   */
  async assignSkillToAgent(
    agentId: string,
    skillId: string,
    proficiencyLevel: 'beginner' | 'intermediate' | 'advanced' | 'expert' = 'beginner'
  ): Promise<AgentSkillAssignment> {
    try {
      const now = new Date().toISOString();
      
      const query = `
        INSERT OR REPLACE INTO agent_skill_assignments (
          agent_id, skill_id, proficiency_level, success_rate,
          total_executions, successful_executions, avg_execution_time_ms, learned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        agentId,
        skillId,
        proficiencyLevel,
        0.0, // initial success rate
        0,   // initial total executions
        0,   // initial successful executions
        0,   // initial avg execution time
        now
      ];

      await this.adapter.executeModifyQuery(query, params);

      // Record assignment event
      await this.recordSkillEvent('skill_assigned', 'assignment', `${agentId}:${skillId}`, {
        agent_id: agentId,
        skill_id: skillId,
        proficiency_level: proficiencyLevel
      });

      return await this.getAgentSkillAssignment(agentId, skillId) as AgentSkillAssignment;
    } catch (error) {
      logger.error('Failed to assign skill to agent:', { error, agentId, skillId });
      throw error;
    }
  }

  /**
   * Get agent skill assignment
   */
  async getAgentSkillAssignment(agentId: string, skillId: string): Promise<AgentSkillAssignment | null> {
    try {
      const query = 'SELECT * FROM agent_skill_assignments WHERE agent_id = ? AND skill_id = ?';
      const result = await this.adapter.executeQuerySingle(query, [agentId, skillId]);
      
      return result ? this.mapRowToAgentSkillAssignment(result) : null;
    } catch (error) {
      logger.error('Failed to get agent skill assignment:', { error, agentId, skillId });
      throw error;
    }
  }

  /**
   * Get all skills assigned to an agent
   */
  async getAgentSkills(agentId: string): Promise<AgentSkillAssignment[]> {
    try {
      const query = `
        SELECT * FROM agent_skill_assignments 
        WHERE agent_id = ? 
        ORDER BY proficiency_level DESC, learned_at DESC
      `;
      const results = await this.adapter.executeQuery(query, [agentId]);
      
      return results.map(row => this.mapRowToAgentSkillAssignment(row));
    } catch (error) {
      logger.error('Failed to get agent skills:', { error, agentId });
      throw error;
    }
  }

  /**
   * Update agent skill performance metrics
   */
  async updateSkillPerformance(
    agentId: string,
    skillId: string,
    executionTimeMs: number,
    success: boolean
  ): Promise<void> {
    try {
      // Get current metrics
      const current = await this.getAgentSkillAssignment(agentId, skillId);
      if (!current) {
        throw new Error(`Agent skill assignment not found: ${agentId}:${skillId}`);
      }

      // Calculate new metrics
      const newTotalExecutions = current.total_executions + 1;
      const newSuccessfulExecutions = current.successful_executions + (success ? 1 : 0);
      const newSuccessRate = newSuccessfulExecutions / newTotalExecutions;
      
      // Calculate new average execution time
      const currentTotalTime = current.avg_execution_time_ms * current.total_executions;
      const newAvgExecutionTime = Math.round((currentTotalTime + executionTimeMs) / newTotalExecutions);

      const query = `
        UPDATE agent_skill_assignments 
        SET success_rate = ?, total_executions = ?, successful_executions = ?,
            avg_execution_time_ms = ?, last_used_at = ?
        WHERE agent_id = ? AND skill_id = ?
      `;

      const params = [
        newSuccessRate,
        newTotalExecutions,
        newSuccessfulExecutions,
        newAvgExecutionTime,
        new Date().toISOString(),
        agentId,
        skillId
      ];

      await this.adapter.executeModifyQuery(query, params);

      // Record performance event
      await this.recordSkillEvent('skill_performance_updated', 'assignment', `${agentId}:${skillId}`, {
        agent_id: agentId,
        skill_id: skillId,
        execution_time_ms: executionTimeMs,
        success,
        new_success_rate: newSuccessRate
      });
    } catch (error) {
      logger.error('Failed to update skill performance:', { error, agentId, skillId });
      throw error;
    }
  }

  /**
   * Record a skill event with error handling (non-critical operation)
   */
  async recordSkillEvent(
    eventType: string,
    entityType: 'skill' | 'agent' | 'assignment' | 'task',
    entityId: string,
    eventData?: Record<string, any>,
    correlationId?: string,
    sessionId?: string
  ): Promise<void> {
    const context: ErrorContext = {
      component: 'agent-skills-service',
      operation: 'recordSkillEvent',
      metadata: { eventType, entityType, entityId },
      correlationId,
      timestamp: new Date()
    };

    try {
      await agentSkillsErrorHandler.executeWithRetry(async () => {
        const id = this.generateId();
        const now = new Date().toISOString();

        const query = `
          INSERT INTO skill_events (
            id, event_type, entity_type, entity_id, event_data,
            timestamp, correlation_id, source, session_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        const params = [
          id,
          eventType,
          entityType,
          entityId,
          eventData ? JSON.stringify(eventData) : null,
          now,
          correlationId || null,
          'agent-skills-service',
          sessionId || null
        ];

        await this.adapter.executeModifyQuery(query, params);
      }, context, {
        maxRetries: 2,
        baseDelay: 200,
        retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED']
      });
    } catch (error) {
      // Event recording is not critical - log but don't throw
      logger.warn('Failed to record skill event (non-critical)', {
        eventType,
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get skill events with optional filtering
   */
  async getSkillEvents(
    entityType?: 'skill' | 'agent' | 'assignment' | 'task',
    entityId?: string,
    eventType?: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<SkillEvent[]> {
    try {
      let query = 'SELECT * FROM skill_events WHERE 1=1';
      const params: any[] = [];

      if (entityType) {
        query += ' AND entity_type = ?';
        params.push(entityType);
      }

      if (entityId) {
        query += ' AND entity_id = ?';
        params.push(entityId);
      }

      if (eventType) {
        query += ' AND event_type = ?';
        params.push(eventType);
      }

      query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const results = await this.adapter.executeQuery(query, params);
      return results.map(row => this.mapRowToSkillEvent(row));
    } catch (error) {
      logger.error('Failed to get skill events:', { error, entityType, entityId, eventType });
      throw error;
    }
  }

  /**
   * Get skill usage statistics
   */
  async getSkillUsageStats(skillId: string): Promise<{
    totalAgents: number;
    expertAgents: number;
    averageSuccessRate: number;
    totalExecutions: number;
    lastUsed?: string;
  }> {
    try {
      const query = `
        SELECT 
          COUNT(*) as total_agents,
          COUNT(CASE WHEN proficiency_level = 'expert' THEN 1 END) as expert_agents,
          AVG(success_rate) as average_success_rate,
          SUM(total_executions) as total_executions,
          MAX(last_used_at) as last_used
        FROM agent_skill_assignments
        WHERE skill_id = ?
      `;

      const result = await this.adapter.executeQuerySingle(query, [skillId]);
      
      return {
        totalAgents: result?.total_agents || 0,
        expertAgents: result?.expert_agents || 0,
        averageSuccessRate: result?.average_success_rate || 0,
        totalExecutions: result?.total_executions || 0,
        lastUsed: result?.last_used || undefined
      };
    } catch (error) {
      logger.error('Failed to get skill usage stats:', { error, skillId });
      throw error;
    }
  }

  /**
   * Check the health of the Agent Skills Service
   */
  async checkHealth(): Promise<{
    healthy: boolean;
    message: string;
    details: {
      database: { healthy: boolean; message: string };
      skillsTable: { accessible: boolean; count: number };
      assignmentsTable: { accessible: boolean; count: number };
      eventsTable: { accessible: boolean; count: number };
    };
  }> {
    const context: ErrorContext = {
      component: 'agent-skills-service',
      operation: 'checkHealth',
      timestamp: new Date()
    };

    try {
      // Check database health
      const dbHealth = await this.adapter.checkDatabaseHealth();
      
      // Check table accessibility and get counts
      const skillsCount = await agentSkillsErrorHandler.executeWithRetry(async () => {
        const result = await this.adapter.executeQuerySingle('SELECT COUNT(*) as count FROM skills');
        return result?.count || 0;
      }, context, { maxRetries: 2, baseDelay: 500 });

      const assignmentsCount = await agentSkillsErrorHandler.executeWithRetry(async () => {
        const result = await this.adapter.executeQuerySingle('SELECT COUNT(*) as count FROM agent_skill_assignments');
        return result?.count || 0;
      }, context, { maxRetries: 2, baseDelay: 500 });

      const eventsCount = await agentSkillsErrorHandler.executeWithRetry(async () => {
        const result = await this.adapter.executeQuerySingle('SELECT COUNT(*) as count FROM skill_events');
        return result?.count || 0;
      }, context, { maxRetries: 2, baseDelay: 500 });

      const allHealthy = dbHealth.healthy && 
                        skillsCount >= 0 && 
                        assignmentsCount >= 0 && 
                        eventsCount >= 0;

      return {
        healthy: allHealthy,
        message: allHealthy ? 'Agent Skills Service is healthy' : 'Agent Skills Service has issues',
        details: {
          database: dbHealth,
          skillsTable: { accessible: true, count: skillsCount },
          assignmentsTable: { accessible: true, count: assignmentsCount },
          eventsTable: { accessible: true, count: eventsCount }
        }
      };

    } catch (error) {
      logger.error('Agent Skills Service health check failed', {
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {
          database: { healthy: false, message: 'Health check failed' },
          skillsTable: { accessible: false, count: 0 },
          assignmentsTable: { accessible: false, count: 0 },
          eventsTable: { accessible: false, count: 0 }
        }
      };
    }
  }

  /**
   * Close the service and clean up resources
   */
  close(): void {
    this.adapter.close();
  }

  /**
   * Generate a unique ID for database records
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Map database row to Skill object
   */
  private mapRowToSkill(row: any): Skill {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      version: row.version,
      category: row.category,
      tags: JSON.parse(row.tags || '[]'),
      scope: row.scope,
      entrypoint: row.entrypoint,
      enabled: Boolean(row.enabled),
      installed: Boolean(row.installed),
      content: row.content,
      metadata: JSON.parse(row.metadata || '{}'),
      bundled_skill_id: row.bundled_skill_id,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  /**
   * Map database row to AgentSkillAssignment object
   */
  private mapRowToAgentSkillAssignment(row: any): AgentSkillAssignment {
    return {
      agent_id: row.agent_id,
      skill_id: row.skill_id,
      proficiency_level: row.proficiency_level,
      success_rate: row.success_rate,
      total_executions: row.total_executions,
      successful_executions: row.successful_executions,
      avg_execution_time_ms: row.avg_execution_time_ms,
      last_used_at: row.last_used_at,
      learned_at: row.learned_at
    };
  }

  /**
   * Map database row to SkillEvent object
   */
  private mapRowToSkillEvent(row: any): SkillEvent {
    return {
      id: row.id,
      event_type: row.event_type,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      event_data: row.event_data ? JSON.parse(row.event_data) : undefined,
      timestamp: row.timestamp,
      correlation_id: row.correlation_id,
      source: row.source,
      session_id: row.session_id
    };
  }
}