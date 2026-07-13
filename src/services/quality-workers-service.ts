/**
 * QualityWorkersService — Auto-triggered background quality workers.
 *
 * Subscribes to the Event Stream and an idle scheduler to run background
 * quality sweeps (testgaps, e2e-replay, audit, bloat, docs-drift) without
 * editing code autonomously. Workers produce findings and recommendations only.
 *
 * Key constraints:
 * - Concurrency: max 1 worker at a time
 * - Checks Edit Lock before starting any worker task
 * - Executes all worker logic in Docker sandbox (interface-based)
 * - Never edits code — findings and recommendations only
 * - Writes findings to `worker_findings` SQLite table
 * - Surfaces ranked "project health" queue via getHealthQueue()
 * - Spawns specialists with role-matched skills via SubagentSpawner
 * - Gated behind `quality_workers` feature flag
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 25.8
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import { type Role } from '../orchestration/role-vocabulary.js';
import { checkSandboxIsolation } from '../pipeline/sandbox-environment';

// ─── Types ──────────────────────────────────────────────────────

export type WorkerType = 'testgaps' | 'e2e-replay' | 'audit' | 'bloat' | 'docs-drift';

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface WorkerFinding {
  id: string;
  worker: WorkerType;
  severity: FindingSeverity;
  file?: string;
  description: string;
  recommendation: string;
  createdAt: string;
  resolved: boolean;
}

export interface WorkerFindingRow {
  id: string;
  worker_type: string;
  severity: string;
  file_path: string | null;
  description: string;
  recommendation: string;
  created_at: string;
  resolved: number;
}

/** Interface for Event Stream subscription (interface-based) */
export interface EventStreamSubscriber {
  on(event: string, callback: () => void): void;
  off(event: string, callback: () => void): void;
}

/** Interface for idle scheduler (interface-based) */
export interface IdleScheduler {
  onIdle(callback: () => void): void;
  offIdle(callback: () => void): void;
}

/** Interface for Edit Lock checking (interface-based) */
export interface EditLockChecker {
  isLocked(): boolean;
}

/** Interface for Docker sandbox execution (interface-based, mock for now) */
export interface DockerSandbox {
  /** Identifies whether this sandbox provides real Docker isolation or is a no-op (R5.1) */
  readonly isolationKind: 'docker' | 'noop';
  execute(workerType: WorkerType, projectDir: string): Promise<WorkerFinding[]>;
}

/** Interface for SubagentSpawner to spawn specialists with role-matched skills */
export interface SubagentSpawner {
  spawnSpecialist(role: string, task: string, skills: string[]): Promise<WorkerFinding[]>;
}

// ─── Worker Role Mappings ───────────────────────────────────────

/**
 * Maps each worker type to a canonical role from the shared Role_Vocabulary.
 * Every role name here MUST be an exact-string member of ROLE_VOCABULARY (R19.2).
 */
const WORKER_ROLES: Record<WorkerType, Role> = {
  testgaps: 'tester',
  'e2e-replay': 'tester',
  audit: 'reviewer',
  bloat: 'reviewer',
  'docs-drift': 'reviewer',
};

const WORKER_SKILLS: Record<WorkerType, string[]> = {
  testgaps: ['test-generation'],
  'e2e-replay': ['e2e-testing'],
  audit: ['security-audit', 'supply-chain'],
  bloat: ['lean-minimalism', 'over-engineering-review'],
  'docs-drift': ['documentation', 'lean-minimalism'],
};

/** Severity rank for sorting findings (higher = more severe) */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

// ─── Constants ──────────────────────────────────────────────────

const ALL_WORKERS: WorkerType[] = ['testgaps', 'e2e-replay', 'audit', 'bloat', 'docs-drift'];
const FEATURE_FLAG = 'quality_workers' as const;

// ─── QualityWorkersService Implementation ───────────────────────

export class QualityWorkersService {
  private readonly db: Database.Database;
  private readonly featureGate: FeatureGateSystem;
  private readonly eventStream: EventStreamSubscriber;
  private readonly idleScheduler: IdleScheduler;
  private readonly editLockChecker: EditLockChecker;
  private readonly dockerSandbox: DockerSandbox;
  private readonly subagentSpawner: SubagentSpawner;
  private readonly projectDir: string;

  private running = false;
  private currentWorker: WorkerType | null = null;
  private workerQueue: WorkerType[] = [];
  private started = false;

  // Prepared statements (lazily initialized)
  private stmtInsertFinding!: Database.Statement;
  private stmtGetFindings!: Database.Statement;
  private stmtResolveFinding!: Database.Statement;

  constructor(config: {
    db: Database.Database;
    featureGate: FeatureGateSystem;
    eventStream: EventStreamSubscriber;
    idleScheduler: IdleScheduler;
    editLockChecker: EditLockChecker;
    dockerSandbox: DockerSandbox;
    subagentSpawner: SubagentSpawner;
    projectDir: string;
  }) {
    this.db = config.db;
    this.featureGate = config.featureGate;
    this.eventStream = config.eventStream;
    this.idleScheduler = config.idleScheduler;
    this.editLockChecker = config.editLockChecker;
    this.dockerSandbox = config.dockerSandbox;
    this.subagentSpawner = config.subagentSpawner;
    this.projectDir = config.projectDir;

    this.ensureTable();
    this.initStatements();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Start the Quality Workers Service.
   * Subscribes to Event Stream and idle scheduler for triggers.
   * No-op if feature flag is disabled or already started.
   */
  start(): void {
    if (!this.isEnabled()) return;
    if (this.started) return;

    this.started = true;
    this.eventStream.on('session_end', this.handleTrigger);
    this.idleScheduler.onIdle(this.handleTrigger);
  }

  /**
   * Stop the Quality Workers Service.
   * Unsubscribes from event stream and idle scheduler.
   */
  stop(): void {
    if (!this.started) return;

    this.started = false;
    this.eventStream.off('session_end', this.handleTrigger);
    this.idleScheduler.offIdle(this.handleTrigger);
  }

  /**
   * Get the ranked project health queue.
   * Returns all unresolved findings ordered by severity (descending) then created_at (descending).
   */
  getHealthQueue(): WorkerFinding[] {
    if (!this.isEnabled()) return [];

    const rows = this.stmtGetFindings.all() as WorkerFindingRow[];
    return rows.map(this.rowToFinding).sort((a, b) => {
      const severityDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (severityDiff !== 0) return severityDiff;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  /**
   * Resolve a finding by ID.
   */
  resolveFinding(findingId: string): boolean {
    if (!this.isEnabled()) return false;
    const result = this.stmtResolveFinding.run(findingId);
    return result.changes > 0;
  }

  /**
   * Manually trigger a specific worker (for testing/debugging).
   * Returns findings produced by the worker.
   */
  async triggerWorker(workerType: WorkerType): Promise<WorkerFinding[]> {
    if (!this.isEnabled()) return [];
    if (this.running) return [];
    if (!this.canStart()) return [];

    return this.executeWorker(workerType);
  }

  /**
   * Check if a worker is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the currently running worker type, or null.
   */
  getCurrentWorker(): WorkerType | null {
    return this.currentWorker;
  }

  /**
   * Check if the service is enabled via feature flag.
   */
  isEnabled(): boolean {
    return this.featureGate.isEnabled(FEATURE_FLAG as any);
  }

  // ─── Internal Implementation ────────────────────────────────────

  private handleTrigger = async (): Promise<void> => {
    if (!this.isEnabled()) return;
    if (this.running) return;

    // Queue all workers for a full sweep
    this.workerQueue = [...ALL_WORKERS];
    await this.processQueue();
  };

  private async processQueue(): Promise<void> {
    while (this.workerQueue.length > 0) {
      if (!this.isEnabled()) break;
      if (!this.canStart()) break;

      const workerType = this.workerQueue.shift()!;
      await this.executeWorker(workerType);
    }
  }

  /**
   * Check Edit Lock before starting any worker task.
   * Returns false if the edit lock is active.
   */
  private canStart(): boolean {
    return !this.editLockChecker.isLocked();
  }

  /**
   * Execute a single worker in the Docker sandbox.
   * Enforces concurrency of 1 worker at a time.
   */
  private async executeWorker(workerType: WorkerType): Promise<WorkerFinding[]> {
    if (this.running) return [];

    this.running = true;
    this.currentWorker = workerType;

    try {
      // Check Edit Lock before starting
      if (!this.canStart()) {
        return [];
      }

      // R5.3, R5.4: In production with a no-op sandbox, refuse execution
      const refusal = checkSandboxIsolation(this.dockerSandbox.isolationKind);
      if (refusal) {
        return [];
      }

      // Execute worker logic in Docker sandbox
      const sandboxFindings = await this.dockerSandbox.execute(workerType, this.projectDir);

      // For testgaps and e2e-replay, also spawn specialist agents
      let specialistFindings: WorkerFinding[] = [];
      if (workerType === 'testgaps' || workerType === 'e2e-replay') {
        const role = WORKER_ROLES[workerType];
        const skills = WORKER_SKILLS[workerType];
        specialistFindings = await this.subagentSpawner.spawnSpecialist(
          role,
          `Run ${workerType} analysis on project`,
          skills,
        );
      }

      const allFindings = [...sandboxFindings, ...specialistFindings];

      // Write findings to SQLite — never edit code
      for (const finding of allFindings) {
        this.writeFinding(finding);
      }

      return allFindings;
    } finally {
      this.running = false;
      this.currentWorker = null;
    }
  }

  /**
   * Write a finding to the worker_findings table.
   */
  private writeFinding(finding: WorkerFinding): void {
    this.stmtInsertFinding.run(
      finding.id || randomUUID(),
      finding.worker,
      finding.severity,
      finding.file ?? null,
      finding.description,
      finding.recommendation,
      finding.createdAt || new Date().toISOString(),
      finding.resolved ? 1 : 0,
    );
  }

  /**
   * Convert a database row to a WorkerFinding.
   */
  private rowToFinding(row: WorkerFindingRow): WorkerFinding {
    return {
      id: row.id,
      worker: row.worker_type as WorkerType,
      severity: row.severity as FindingSeverity,
      file: row.file_path ?? undefined,
      description: row.description,
      recommendation: row.recommendation,
      createdAt: row.created_at,
      resolved: row.resolved === 1,
    };
  }

  /**
   * Ensure the worker_findings table exists.
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_findings (
        id TEXT PRIMARY KEY,
        worker_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'error')),
        file_path TEXT,
        description TEXT NOT NULL,
        recommendation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_worker_findings_type ON worker_findings(worker_type);
      CREATE INDEX IF NOT EXISTS idx_worker_findings_severity ON worker_findings(severity);
      CREATE INDEX IF NOT EXISTS idx_worker_findings_resolved ON worker_findings(resolved);
    `);
  }

  /**
   * Initialize prepared statements for performance.
   */
  private initStatements(): void {
    this.stmtInsertFinding = this.db.prepare(`
      INSERT OR REPLACE INTO worker_findings (id, worker_type, severity, file_path, description, recommendation, created_at, resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtGetFindings = this.db.prepare(`
      SELECT id, worker_type, severity, file_path, description, recommendation, created_at, resolved
      FROM worker_findings
      WHERE resolved = 0
      ORDER BY severity DESC, created_at DESC
    `);

    this.stmtResolveFinding = this.db.prepare(`
      UPDATE worker_findings SET resolved = 1 WHERE id = ?
    `);
  }
}
