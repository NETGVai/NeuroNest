import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { SQLiteAdapter } from './sqlite-adapter.js';
import { logger } from '../utils/logger.js';
import { agentSkillsErrorHandler, ErrorContext } from './error-handler.js';
import type {
  BundlePersistencePlan,
  BundlePersistenceStatus,
  BundleStateRow,
  AssignmentEvidenceRow,
  CurrentAssignment,
} from './bundle-persistence-plan.js';
import { validatePlan, computeEvidenceRowsFingerprint } from './bundle-persistence-plan.js';

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

/**
 * A single entry in the authoritative skill catalog snapshot.
 * Maps persisted skill row fields to explicit booleans and extracted metadata.
 */
export interface SkillCatalogEntry {
  skillId: string;
  name: string;
  category: string;
  enabled: boolean;
  installed: boolean;
  capabilityKeys: readonly string[];
  technologyKeys: readonly string[];
  deliverableKeys: readonly string[];
  description: string;
  version: string;
}

/**
 * Immutable snapshot of the entire authoritative skill catalog.
 *
 * `byId` intentionally stores arrays so multiply resolved IDs are preserved
 * and validation can fail closed rather than hiding malformed catalog state.
 * `byCategory` provides multi-value lookups grouped by category.
 *
 * Both indexes and `entries` are sorted and deeply frozen.
 * `fingerprint` is a stable SHA-256 digest over canonical entry data.
 */
export interface AuthoritativeSkillCatalogSnapshot {
  entries: readonly SkillCatalogEntry[];
  byId: ReadonlyMap<string, readonly SkillCatalogEntry[]>;
  byCategory: ReadonlyMap<string, readonly SkillCatalogEntry[]>;
  fingerprint: string;
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
   * Ensures the bundle persistence schema tables exist.
   * Creates `agent_skill_assignment_evidence` and `agent_skill_bundle_state`
   * tables if they don't already exist.
   *
   * Requirements: 10.13–10.16
   */
  ensureBundlePersistenceSchema(): void {
    const db = this.getDatabase();

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_skill_assignment_evidence (
        agent_id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        capability_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK(source_kind IN ('taxonomy', 'reviewed-override')),
        source_id TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, skill_id, capability_key, source_id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_skill_bundle_state (
        agent_id TEXT NOT NULL PRIMARY KEY,
        input_fingerprint TEXT NOT NULL,
        bundle_fingerprint TEXT NOT NULL,
        catalog_fingerprint TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Indexes for efficient lookups
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evidence_agent ON agent_skill_assignment_evidence(agent_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_evidence_skill ON agent_skill_assignment_evidence(skill_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bundle_state_fingerprint ON agent_skill_bundle_state(input_fingerprint)`);
  }

  /**
   * Reads current assignments for a given agent from the assignment store.
   * Used for planning: determining retained/stale/added rows.
   */
  async getCurrentAssignments(agentId: string): Promise<CurrentAssignment[]> {
    const query = 'SELECT * FROM agent_skill_assignments WHERE agent_id = ? ORDER BY skill_id ASC';
    const rows = await this.adapter.executeQuery(query, [agentId]);
    return rows.map(row => ({
      agentId: row.agent_id,
      skillId: row.skill_id,
      proficiencyLevel: row.proficiency_level || 'beginner',
      successRate: row.success_rate ?? 0,
      totalExecutions: row.total_executions ?? 0,
      successfulExecutions: row.successful_executions ?? 0,
      avgExecutionTimeMs: row.avg_execution_time_ms ?? 0,
      lastUsedAt: row.last_used_at || null,
      learnedAt: row.learned_at || new Date().toISOString(),
    }));
  }

  /**
   * Reads the stored bundle-state for an agent (if any).
   * Returns null if no state has been stored yet.
   */
  async getStoredBundleState(agentId: string): Promise<BundleStateRow | null> {
    const query = 'SELECT * FROM agent_skill_bundle_state WHERE agent_id = ?';
    const row = await this.adapter.executeQuerySingle(query, [agentId]);
    if (!row) return null;
    return {
      agentId: row.agent_id,
      inputFingerprint: row.input_fingerprint,
      bundleFingerprint: row.bundle_fingerprint,
      catalogFingerprint: row.catalog_fingerprint,
      skillIdsJson: row.skill_ids_json,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Gets the current evidence fingerprint for an agent from the bundle-state table.
   * Returns null if no state exists.
   */
  async getCurrentEvidenceFingerprint(agentId: string): Promise<string | null> {
    const query = 'SELECT evidence_fingerprint FROM agent_skill_bundle_state WHERE agent_id = ?';
    const row = await this.adapter.executeQuerySingle(query, [agentId]);
    return row?.evidence_fingerprint ?? null;
  }

  /**
   * Reconciles an agent's complete skill bundle atomically.
   *
   * Implements fingerprint-guarded atomic complete-bundle persistence:
   * 1. Pre-write catalog fingerprint recheck
   * 2. Deterministic transaction statements
   * 3. Evidence/state upserts
   * 4. Exact postcondition verification
   * 5. Whole-transaction retry on transient errors
   * 6. Roll back on any statement/postcondition failure
   * 7. No mutation for valid no-op plans
   *
   * The transaction contains, in deterministic order:
   * 1. Catalog fingerprint precondition check
   * 2. Stale assignment/evidence deletes
   * 3. Missing assignment inserts (INSERT OR IGNORE for retained rows)
   * 4. Evidence upserts
   * 5. Bundle-state upsert with input and bundle fingerprints
   * 6. Postcondition: persisted IDs exactly equal desired sorted set
   *
   * Requirements: 10.13–10.16, 10.18
   *
   * @param plan - The deterministic bundle persistence plan
   * @returns Committed (with changed flag) or rolled-back status
   */
  async reconcileAgentSkillBundle(
    plan: BundlePersistencePlan,
  ): Promise<BundlePersistenceStatus> {
    const context: ErrorContext = {
      component: 'agent-skills-service',
      operation: 'reconcileAgentSkillBundle',
      metadata: { agentId: plan.agentId, noOp: plan.noOp, desiredCount: plan.desiredSkillIds.length },
      timestamp: new Date()
    };

    // Validate plan integrity
    const validationError = validatePlan(plan);
    if (validationError) {
      return { state: 'rolled-back', errorCode: 'INVALID_PLAN', errorMessage: validationError };
    }

    // No-op plans: no mutations, no events, committed with changed=false
    if (plan.noOp) {
      return { state: 'committed', changed: false };
    }

    // Attempt whole-transaction with retry for transient errors
    return agentSkillsErrorHandler.executeWithRetry(async () => {
      return this.executeReconciliationTransaction(plan);
    }, context, {
      maxRetries: 3,
      baseDelay: 500,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
  }

  /**
   * Executes the reconciliation transaction.
   * Rolls back all changes on any statement or postcondition failure.
   * Returns committed or rolled-back status.
   */
  private executeReconciliationTransaction(
    plan: BundlePersistencePlan,
  ): BundlePersistenceStatus {
    const db = this.getDatabase();
    const now = new Date().toISOString();

    // Use a raw SQLite transaction for atomic rollback behavior
    const transactionFn = db.transaction(() => {
      // Step 1: Catalog fingerprint precondition recheck
      // Re-read the current catalog fingerprint to ensure it hasn't changed
      // since the plan was computed.
      const currentFp = this.recheckCatalogFingerprint(db);
      if (currentFp !== null && currentFp !== plan.catalogFingerprint) {
        throw new CatalogStaleError(
          `Catalog fingerprint changed: expected '${plan.catalogFingerprint}', got '${currentFp}'`
        );
      }

      // Step 2: Stale assignment/evidence deletes
      for (const stale of plan.staleAssignments) {
        const deleteAssignment = db.prepare(
          'DELETE FROM agent_skill_assignments WHERE agent_id = ? AND skill_id = ?'
        );
        deleteAssignment.run(plan.agentId, stale.skillId);

        const deleteEvidence = db.prepare(
          'DELETE FROM agent_skill_assignment_evidence WHERE agent_id = ? AND skill_id = ?'
        );
        deleteEvidence.run(plan.agentId, stale.skillId);
      }

      // Step 3: Missing assignment inserts using INSERT OR IGNORE
      // Never INSERT OR REPLACE for retained rows — that would reset metrics
      for (const skillId of plan.addedSkillIds) {
        const insertAssignment = db.prepare(`
          INSERT OR IGNORE INTO agent_skill_assignments (
            agent_id, skill_id, proficiency_level, success_rate,
            total_executions, successful_executions, avg_execution_time_ms, learned_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        insertAssignment.run(
          plan.agentId,
          skillId,
          'beginner',
          0.0,
          0,
          0,
          0,
          now,
        );
      }

      // Step 4: Evidence upserts — remove all old evidence for this agent, then insert fresh
      const deleteAllEvidence = db.prepare(
        'DELETE FROM agent_skill_assignment_evidence WHERE agent_id = ?'
      );
      deleteAllEvidence.run(plan.agentId);

      const insertEvidence = db.prepare(`
        INSERT INTO agent_skill_assignment_evidence (
          agent_id, skill_id, capability_key, reason, source_kind, source_id, evidence_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of plan.evidenceRows) {
        insertEvidence.run(
          row.agentId,
          row.skillId,
          row.capabilityKey,
          row.reason,
          row.sourceKind,
          row.sourceId,
          row.evidenceJson,
          now,
          now,
        );
      }

      // Step 5: Bundle-state upsert
      const evidenceFp = computeEvidenceRowsFingerprint(plan.evidenceRows);
      const bundleFingerprint = this.computeBundleContentFingerprint(plan.desiredSkillIds, plan.evidenceRows);

      const upsertState = db.prepare(`
        INSERT INTO agent_skill_bundle_state (
          agent_id, input_fingerprint, bundle_fingerprint, catalog_fingerprint,
          skill_ids_json, evidence_fingerprint, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          input_fingerprint = excluded.input_fingerprint,
          bundle_fingerprint = excluded.bundle_fingerprint,
          catalog_fingerprint = excluded.catalog_fingerprint,
          skill_ids_json = excluded.skill_ids_json,
          evidence_fingerprint = excluded.evidence_fingerprint,
          updated_at = excluded.updated_at
      `);
      upsertState.run(
        plan.agentId,
        plan.inputFingerprint,
        bundleFingerprint,
        plan.catalogFingerprint,
        JSON.stringify([...plan.desiredSkillIds]),
        evidenceFp,
        now,
      );

      // Step 6: Postcondition verification — persisted IDs must exactly equal desired
      const postconditionRows = db.prepare(
        'SELECT skill_id FROM agent_skill_assignments WHERE agent_id = ? ORDER BY skill_id ASC'
      ).all(plan.agentId) as Array<{ skill_id: string }>;

      const persistedIds = postconditionRows.map(r => r.skill_id);
      const desiredSorted = [...plan.desiredSkillIds].sort();

      if (persistedIds.length !== desiredSorted.length) {
        throw new PostconditionError(
          `Postcondition failed: expected ${desiredSorted.length} assignments, found ${persistedIds.length}`
        );
      }
      for (let i = 0; i < desiredSorted.length; i++) {
        if (persistedIds[i] !== desiredSorted[i]) {
          throw new PostconditionError(
            `Postcondition failed: expected '${desiredSorted[i]}' at position ${i}, found '${persistedIds[i]}'`
          );
        }
      }
    });

    // Execute the transaction — SQLite automatically rolls back on throw
    try {
      transactionFn();
      return { state: 'committed', changed: true };
    } catch (error) {
      if (error instanceof CatalogStaleError) {
        return {
          state: 'rolled-back',
          errorCode: 'STALE_CATALOG_SNAPSHOT',
          errorMessage: error.message,
        };
      }
      if (error instanceof PostconditionError) {
        return {
          state: 'rolled-back',
          errorCode: 'POSTCONDITION_FAILED',
          errorMessage: error.message,
        };
      }
      // Any other error (statement failure, constraint violation, etc.)
      const msg = error instanceof Error ? error.message : String(error);
      return {
        state: 'rolled-back',
        errorCode: 'TRANSACTION_FAILED',
        errorMessage: msg,
      };
    }
  }

  /**
   * Rechecks the catalog fingerprint by re-reading the skills table.
   * Returns the current fingerprint or null if the table is empty/inaccessible.
   */
  private recheckCatalogFingerprint(db: Database.Database): string | null {
    try {
      const rows = db.prepare('SELECT * FROM skills ORDER BY id ASC').all() as any[];
      if (rows.length === 0) return null;

      const entries = rows.map(row => this.mapRowToSkillCatalogEntry(row));
      entries.sort((a, b) => a.skillId.localeCompare(b.skillId));
      return this.computeCatalogFingerprint(entries);
    } catch {
      // If skills table doesn't exist or can't be read, return null
      // (no catalog fingerprint check possible)
      return null;
    }
  }

  /**
   * Computes a fingerprint over bundle content (skill IDs + evidence rows).
   */
  private computeBundleContentFingerprint(
    skillIds: readonly string[],
    evidenceRows: readonly AssignmentEvidenceRow[],
  ): string {
    const hash = createHash('sha256');
    hash.update('bundle-content:');
    hash.update(JSON.stringify([...skillIds]));
    hash.update('\n');
    for (const row of evidenceRows) {
      hash.update(`${row.skillId}|${row.capabilityKey}|${row.sourceKind}|${row.sourceId}\n`);
    }
    return `bundle-${hash.digest('hex').slice(0, 32)}`;
  }

  /**
   * Gets the underlying database instance.
   * Used for direct transaction execution.
   */
  private getDatabase(): Database.Database {
    return (this.adapter as any).db;
  }

  /**
   * Close the service and clean up resources
   */
  close(): void {
    this.adapter.close();
  }

  /**
   * Read all skill rows in one consistent operation, map persisted booleans
   * explicitly, extract capability/technology/deliverable metadata from tags and
   * metadata JSON, create sorted `byId` and `byCategory` multi-value indexes,
   * freeze all results, and compute a stable SHA-256 content fingerprint.
   *
   * Multiply resolved IDs (multiple rows with the same skill ID) are preserved
   * in the `byId` index so downstream validation can detect and fail closed on
   * malformed catalog state rather than silently hiding duplicates.
   *
   * Requirements: 10.2, 10.3, 10.12, 10.14, 10.15
   */
  async getAuthoritativeCatalogSnapshot(): Promise<AuthoritativeSkillCatalogSnapshot> {
    const context: ErrorContext = {
      component: 'agent-skills-service',
      operation: 'getAuthoritativeCatalogSnapshot',
      timestamp: new Date()
    };

    return agentSkillsErrorHandler.executeWithRetry(async () => {
      // Read all skill rows in one consistent query
      const query = 'SELECT * FROM skills ORDER BY id ASC';
      const rows = await this.adapter.executeQuery(query, []);

      // Map each row to a SkillCatalogEntry with explicit boolean mapping
      const entries: SkillCatalogEntry[] = rows.map(row => this.mapRowToSkillCatalogEntry(row));

      // Sort entries by skillId for deterministic output
      entries.sort((a, b) => a.skillId.localeCompare(b.skillId));

      // Build byId index: intentionally stores arrays to preserve multiply resolved IDs
      const byIdMutable = new Map<string, SkillCatalogEntry[]>();
      for (const entry of entries) {
        const existing = byIdMutable.get(entry.skillId);
        if (existing) {
          existing.push(entry);
        } else {
          byIdMutable.set(entry.skillId, [entry]);
        }
      }

      // Build byCategory index: multi-value grouped by category
      const byCategoryMutable = new Map<string, SkillCatalogEntry[]>();
      for (const entry of entries) {
        const existing = byCategoryMutable.get(entry.category);
        if (existing) {
          existing.push(entry);
        } else {
          byCategoryMutable.set(entry.category, [entry]);
        }
      }

      // Sort each index bucket entries by skillId and freeze each bucket
      const byId = new Map<string, readonly SkillCatalogEntry[]>();
      for (const [id, bucket] of [...byIdMutable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        bucket.sort((a, b) => a.skillId.localeCompare(b.skillId) || a.name.localeCompare(b.name));
        byId.set(id, Object.freeze([...bucket]));
      }

      const byCategory = new Map<string, readonly SkillCatalogEntry[]>();
      for (const [cat, bucket] of [...byCategoryMutable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        bucket.sort((a, b) => a.skillId.localeCompare(b.skillId) || a.name.localeCompare(b.name));
        byCategory.set(cat, Object.freeze([...bucket]));
      }

      // Compute stable content fingerprint from canonical entry data
      const fingerprint = this.computeCatalogFingerprint(entries);

      // Freeze the entries array
      const frozenEntries: readonly SkillCatalogEntry[] = Object.freeze(entries.map(e => Object.freeze(e)));

      const snapshot: AuthoritativeSkillCatalogSnapshot = Object.freeze({
        entries: frozenEntries,
        byId,
        byCategory,
        fingerprint
      });

      return snapshot;
    }, context, {
      maxRetries: 3,
      baseDelay: 500,
      retryableErrors: ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR']
    });
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

  /**
   * Map a database row to a SkillCatalogEntry with explicit boolean mapping
   * and metadata extraction for capability, technology, and deliverable keys.
   */
  private mapRowToSkillCatalogEntry(row: any): SkillCatalogEntry {
    // Map persisted integer booleans explicitly
    const enabled = Boolean(row.enabled);
    const installed = Boolean(row.installed);

    // Parse metadata JSON to extract capability/technology/deliverable keys
    let metadata: Record<string, any> = {};
    try {
      metadata = row.metadata ? JSON.parse(row.metadata) : {};
    } catch {
      // If metadata is malformed, treat as empty
      metadata = {};
    }

    // Parse tags for additional categorization
    let tags: string[] = [];
    try {
      tags = row.tags ? JSON.parse(row.tags) : [];
    } catch {
      tags = [];
    }

    // Extract capability keys from metadata or tags
    const capabilityKeys = this.extractMetadataKeys(metadata, tags, 'capability');
    const technologyKeys = this.extractMetadataKeys(metadata, tags, 'technology');
    const deliverableKeys = this.extractMetadataKeys(metadata, tags, 'deliverable');

    return {
      skillId: row.id,
      name: row.name || '',
      category: row.category || '',
      enabled,
      installed,
      capabilityKeys: Object.freeze([...capabilityKeys].sort()),
      technologyKeys: Object.freeze([...technologyKeys].sort()),
      deliverableKeys: Object.freeze([...deliverableKeys].sort()),
      description: row.description || '',
      version: row.version || ''
    };
  }

  /**
   * Extract metadata keys of a specific dimension from the metadata object and tags.
   * Looks in metadata.capabilities, metadata.technologies, metadata.deliverables,
   * metadata.agent_skills_metadata, and tags prefixed with the dimension name.
   */
  private extractMetadataKeys(
    metadata: Record<string, any>,
    tags: string[],
    dimension: 'capability' | 'technology' | 'deliverable'
  ): string[] {
    const keys = new Set<string>();

    // Check direct metadata arrays (plural form)
    const pluralKey = dimension === 'capability' ? 'capabilities'
      : dimension === 'technology' ? 'technologies'
      : 'deliverables';

    if (Array.isArray(metadata[pluralKey])) {
      for (const item of metadata[pluralKey]) {
        if (typeof item === 'string' && item.trim()) {
          keys.add(item.trim());
        }
      }
    }

    // Check agent_skills_metadata nested object
    const agentSkillsMeta = metadata.agent_skills_metadata;
    if (agentSkillsMeta && typeof agentSkillsMeta === 'object') {
      if (Array.isArray(agentSkillsMeta[pluralKey])) {
        for (const item of agentSkillsMeta[pluralKey]) {
          if (typeof item === 'string' && item.trim()) {
            keys.add(item.trim());
          }
        }
      }
    }

    // Extract from tags with dimension prefix (e.g., "capability:code-review")
    const prefix = `${dimension}:`;
    for (const tag of tags) {
      if (typeof tag === 'string' && tag.startsWith(prefix)) {
        const value = tag.slice(prefix.length).trim();
        if (value) {
          keys.add(value);
        }
      }
    }

    return [...keys];
  }

  /**
   * Compute a stable SHA-256 fingerprint over canonical entry data.
   * Uses only fields that define catalog identity and eligibility:
   * skillId, category, enabled, installed, capabilityKeys, technologyKeys, deliverableKeys.
   * Produces the same hash for the same logical catalog content regardless of
   * non-canonical field variations (description whitespace, version bumps, etc.).
   */
  private computeCatalogFingerprint(entries: SkillCatalogEntry[]): string {
    const hash = createHash('sha256');

    for (const entry of entries) {
      // Use a deterministic canonical representation for each entry
      const canonical = JSON.stringify([
        entry.skillId,
        entry.category,
        entry.enabled,
        entry.installed,
        [...entry.capabilityKeys],
        [...entry.technologyKeys],
        [...entry.deliverableKeys]
      ]);
      hash.update(canonical);
      hash.update('\n');
    }

    return hash.digest('hex');
  }
}


// ─────────────────────────────────────────────
// Transaction Error Classes
// ─────────────────────────────────────────────

/**
 * Error thrown when the catalog fingerprint has changed between plan creation
 * and persistence execution. Triggers STALE_CATALOG_SNAPSHOT rollback.
 */
export class CatalogStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogStaleError';
  }
}

/**
 * Error thrown when the postcondition verification fails after executing
 * all transaction statements. The persisted IDs did not match the desired
 * sorted set. Triggers full rollback.
 */
export class PostconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostconditionError';
  }
}
