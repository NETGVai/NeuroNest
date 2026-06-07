/**
 * Data Validation System for Agent Skills SQLite Integration
 *
 * Validates existing NeuroNest data integrity, Agent Skills source data,
 * referential integrity after integration, and row counts/checksums.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AgentSkillsData } from './migration-engine.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  table: string;
  message: string;
  details?: string;
}

export interface TableRowCount {
  table: string;
  count: number;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
  rowCounts: TableRowCount[];
  checksum: string;
  timestamp: Date;
}

export interface ReferentialIntegrityResult {
  valid: boolean;
  orphanedRecords: Array<{
    table: string;
    column: string;
    referencedTable: string;
    orphanCount: number;
  }>;
}

export interface FunctionalEquivalenceResult {
  valid: boolean;
  issues: ValidationIssue[];
  skillCountBefore: number;
  skillCountAfter: number;
  agentCountBefore: number;
  agentCountAfter: number;
}

// ─── Helpers ────────────────────────────────────────────────────

interface CountRow {
  count: number;
}

interface IntegrityRow {
  integrity_check: string;
}

interface ForeignKeyRow {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

interface TableNameRow {
  name: string;
}

// ─── DataValidator ──────────────────────────────────────────────

export class DataValidator {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Run full validation of existing NeuroNest data integrity.
   * Checks table existence, integrity_check pragma, and row counts.
   */
  validateExistingData(): ValidationReport {
    const issues: ValidationIssue[] = [];
    const rowCounts: TableRowCount[] = [];

    // 1. Check required tables exist
    const requiredTables = [
      'skills',
      'agent_skill_assignments',
      'agent_runtimes',
      'skill_events',
      'agent_skills_config',
    ];

    for (const table of requiredTables) {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as TableNameRow | undefined;

      if (!row) {
        issues.push({
          severity: 'error',
          table,
          message: `Required table '${table}' does not exist`,
        });
      }
    }

    // If critical tables are missing, return early
    if (issues.some((i) => i.severity === 'error')) {
      return {
        valid: false,
        issues,
        rowCounts,
        checksum: '',
        timestamp: new Date(),
      };
    }

    // 2. Run SQLite integrity check
    const integrityResults = this.db.pragma('integrity_check') as IntegrityRow[];
    const firstResult = integrityResults[0];
    if (!firstResult || firstResult.integrity_check !== 'ok') {
      issues.push({
        severity: 'error',
        table: '*',
        message: 'SQLite integrity check failed',
        details: integrityResults.map((r) => r.integrity_check).join('; '),
      });
    }

    // 3. Collect row counts for all relevant tables
    for (const table of requiredTables) {
      const row = this.db
        .prepare(`SELECT COUNT(*) as count FROM ${table}`)
        .get() as CountRow;
      rowCounts.push({ table, count: row.count });
    }

    // 4. Check for foreign key violations
    const fkIssues = this.checkForeignKeys();
    issues.push(...fkIssues);

    const checksum = this.computeDatabaseChecksum();

    return {
      valid: issues.every((i) => i.severity !== 'error'),
      issues,
      rowCounts,
      checksum,
      timestamp: new Date(),
    };
  }

  /**
   * Validate Agent Skills source data before integration.
   * Ensures the data conforms to expected schema and has no internal inconsistencies.
   */
  validateSourceData(data: AgentSkillsData): ValidationReport {
    const issues: ValidationIssue[] = [];
    const rowCounts: TableRowCount[] = [];

    // Validate skills array
    if (!Array.isArray(data.skills)) {
      issues.push({ severity: 'error', table: 'skills', message: 'skills must be an array' });
    } else {
      rowCounts.push({ table: 'source_skills', count: data.skills.length });
      for (const skill of data.skills) {
        if (!skill.id || !skill.name || !skill.description) {
          issues.push({
            severity: 'error',
            table: 'skills',
            message: `Skill missing required fields (id, name, or description)`,
            details: `skill.id=${String(skill.id)}`,
          });
        }
      }
    }

    // Validate agents array
    if (!Array.isArray(data.agents)) {
      issues.push({ severity: 'error', table: 'agents', message: 'agents must be an array' });
    } else {
      rowCounts.push({ table: 'source_agents', count: data.agents.length });
      for (const agent of data.agents) {
        if (!agent.id || !agent.name) {
          issues.push({
            severity: 'error',
            table: 'agents',
            message: `Agent missing required fields (id or name)`,
            details: `agent.id=${String(agent.id)}`,
          });
        }
      }
    }

    // Validate assignments array
    if (!Array.isArray(data.assignments)) {
      issues.push({ severity: 'error', table: 'assignments', message: 'assignments must be an array' });
    } else {
      rowCounts.push({ table: 'source_assignments', count: data.assignments.length });

      const skillIds = new Set(
        Array.isArray(data.skills) ? data.skills.map((s) => s.id) : [],
      );
      const agentIds = new Set(
        Array.isArray(data.agents) ? data.agents.map((a) => a.id) : [],
      );

      for (const assignment of data.assignments) {
        if (!skillIds.has(assignment.skill_id)) {
          issues.push({
            severity: 'error',
            table: 'assignments',
            message: `Assignment references non-existent skill: ${assignment.skill_id}`,
          });
        }
        if (!agentIds.has(assignment.agent_id)) {
          issues.push({
            severity: 'error',
            table: 'assignments',
            message: `Assignment references non-existent agent: ${assignment.agent_id}`,
          });
        }
      }
    }

    // Validate events array
    if (!Array.isArray(data.events)) {
      issues.push({ severity: 'error', table: 'events', message: 'events must be an array' });
    } else {
      rowCounts.push({ table: 'source_events', count: data.events.length });
      for (const event of data.events) {
        if (!event.id || !event.event_type || !event.entity_type || !event.entity_id) {
          issues.push({
            severity: 'error',
            table: 'events',
            message: 'Event missing required fields',
            details: `event.id=${String(event.id)}`,
          });
        }
      }
    }

    const checksum = this.computeSourceChecksum(data);

    return {
      valid: issues.every((i) => i.severity !== 'error'),
      issues,
      rowCounts,
      checksum,
      timestamp: new Date(),
    };
  }

  /**
   * Check referential integrity across all related tables in the database.
   */
  checkReferentialIntegrity(): ReferentialIntegrityResult {
    const orphanedRecords: ReferentialIntegrityResult['orphanedRecords'] = [];

    // agent_skill_assignments.skill_id → skills.id
    const orphanedSkillAssignments = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM agent_skill_assignments asa
         LEFT JOIN skills s ON asa.skill_id = s.id
         WHERE s.id IS NULL`,
      )
      .get() as CountRow;

    if (orphanedSkillAssignments.count > 0) {
      orphanedRecords.push({
        table: 'agent_skill_assignments',
        column: 'skill_id',
        referencedTable: 'skills',
        orphanCount: orphanedSkillAssignments.count,
      });
    }

    // skill_learning_history.skill_id → skills.id
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_learning_history'")
      .get() as TableNameRow | undefined;

    if (tableExists) {
      const orphanedLearning = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM skill_learning_history slh
           LEFT JOIN skills s ON slh.skill_id = s.id
           WHERE s.id IS NULL`,
        )
        .get() as CountRow;

      if (orphanedLearning.count > 0) {
        orphanedRecords.push({
          table: 'skill_learning_history',
          column: 'skill_id',
          referencedTable: 'skills',
          orphanCount: orphanedLearning.count,
        });
      }
    }

    // skill_executions.skill_id → skills.id
    const execTableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_executions'")
      .get() as TableNameRow | undefined;

    if (execTableExists) {
      const orphanedExecs = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM skill_executions se
           LEFT JOIN skills s ON se.skill_id = s.id
           WHERE s.id IS NULL`,
        )
        .get() as CountRow;

      if (orphanedExecs.count > 0) {
        orphanedRecords.push({
          table: 'skill_executions',
          column: 'skill_id',
          referencedTable: 'skills',
          orphanCount: orphanedExecs.count,
        });
      }
    }

    return {
      valid: orphanedRecords.length === 0,
      orphanedRecords,
    };
  }

  /**
   * Verify functional equivalence: existing NeuroNest operations still work
   * after Agent Skills data has been integrated.
   *
   * Takes a snapshot of counts before and after, and verifies core queries still function.
   */
  checkFunctionalEquivalence(
    snapshotBefore: { skillCount: number; agentCount: number },
  ): FunctionalEquivalenceResult {
    const issues: ValidationIssue[] = [];

    const skillCountAfter = (
      this.db.prepare('SELECT COUNT(*) as count FROM skills').get() as CountRow
    ).count;

    const agentCountAfter = (
      this.db.prepare('SELECT COUNT(*) as count FROM agent_runtimes').get() as CountRow
    ).count;

    // Existing data must not decrease
    if (skillCountAfter < snapshotBefore.skillCount) {
      issues.push({
        severity: 'error',
        table: 'skills',
        message: `Skill count decreased from ${snapshotBefore.skillCount} to ${skillCountAfter}`,
      });
    }

    if (agentCountAfter < snapshotBefore.agentCount) {
      issues.push({
        severity: 'error',
        table: 'agent_runtimes',
        message: `Agent count decreased from ${snapshotBefore.agentCount} to ${agentCountAfter}`,
      });
    }

    // Verify core queries still execute without error
    try {
      this.db.prepare('SELECT id, name, source, category FROM skills LIMIT 1').get();
    } catch {
      issues.push({
        severity: 'error',
        table: 'skills',
        message: 'Core skills query failed after integration',
      });
    }

    try {
      this.db
        .prepare(
          `SELECT asa.agent_id, asa.skill_id, asa.proficiency_level, s.name
           FROM agent_skill_assignments asa
           JOIN skills s ON asa.skill_id = s.id
           LIMIT 1`,
        )
        .get();
    } catch {
      issues.push({
        severity: 'error',
        table: 'agent_skill_assignments',
        message: 'Core assignment join query failed after integration',
      });
    }

    try {
      this.db
        .prepare('SELECT id, name, type, status FROM agent_runtimes LIMIT 1')
        .get();
    } catch {
      issues.push({
        severity: 'error',
        table: 'agent_runtimes',
        message: 'Core agent_runtimes query failed after integration',
      });
    }

    return {
      valid: issues.every((i) => i.severity !== 'error'),
      issues,
      skillCountBefore: snapshotBefore.skillCount,
      skillCountAfter,
      agentCountBefore: snapshotBefore.agentCount,
      agentCountAfter,
    };
  }

  /**
   * Compute a SHA-256 checksum of the current database state
   * (skills + assignments, ordered deterministically).
   */
  computeDatabaseChecksum(): string {
    const skills = this.db
      .prepare(
        `SELECT id, name, description, source, version, category, tags, scope,
                enabled, installed, content, metadata
         FROM skills ORDER BY id`,
      )
      .all();

    const assignments = this.db
      .prepare(
        `SELECT agent_id, skill_id, proficiency_level, success_rate,
                total_executions, successful_executions, avg_execution_time_ms
         FROM agent_skill_assignments ORDER BY agent_id, skill_id`,
      )
      .all();

    const payload = JSON.stringify({ skills, assignments });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  // ─── Private helpers ────────────────────────────────────────

  private checkForeignKeys(): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    const violations = this.db.pragma('foreign_key_check') as ForeignKeyRow[];
    for (const v of violations) {
      issues.push({
        severity: 'error',
        table: v.table,
        message: `Foreign key violation: row ${v.rowid} references missing parent in '${v.parent}'`,
      });
    }

    return issues;
  }

  private computeSourceChecksum(data: AgentSkillsData): string {
    // Deterministic serialisation: sort arrays by id, guard against non-arrays
    const safeArr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

    const sorted = {
      skills: safeArr<AgentSkillsData['skills'][number]>(data.skills).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      agents: safeArr<AgentSkillsData['agents'][number]>(data.agents).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
      assignments: safeArr<AgentSkillsData['assignments'][number]>(data.assignments).sort(
        (a, b) =>
          `${a.agent_id}:${a.skill_id}`.localeCompare(`${b.agent_id}:${b.skill_id}`),
      ),
      events: safeArr<AgentSkillsData['events'][number]>(data.events).sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    };

    const payload = JSON.stringify(sorted, (_key, value) => {
      // Normalise Date objects to ISO strings for consistent hashing
      if (value instanceof Date) {
        return value.toISOString();
      }
      return value as unknown;
    });

    return crypto.createHash('sha256').update(payload).digest('hex');
  }
}
