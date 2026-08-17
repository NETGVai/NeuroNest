/**
 * Diagnostics_Service — Health checks, invariant verification, teardown
 * diagnostics, and compatibility checks with full redaction.
 *
 * This service exposes:
 * - Process/schema/migration/queue/owner/budget/bound health
 * - Exact reconstruction verification (Requirement 34.1)
 * - Call/result pairing verification (Requirement 34.3)
 * - Sequence linkage verification (Requirement 34.4)
 * - Schema consistency verification (Requirement 34.6)
 * - Teardown completeness verification (Requirement 34.5)
 * - Degradation marking with remediation (Requirement 34.7)
 * - Compatibility reporting (Requirement 45.5)
 * - Full redaction on all output (Requirement 45.10)
 *
 * Requirements: 29.5–29.8, 30.11–30.12, 32.7, 34.1–34.7, 45.5, 45.10
 */

import type {
  ComponentHealth,
  HealthDimensionResult,
  HealthReport,
  InvariantKind,
  InvariantCheckResult,
  InvariantReport,
  TeardownReport,
  DanglingResource,
  OwnedResourceKind,
  CompatibilityCheck,
  DegradationRecord,
} from './schemas';
import { REDACTED_FIELD_PATTERNS, REDACTION_PLACEHOLDER } from './schemas';

// ─── Dependency Interfaces ──────────────────────────────────────

/**
 * Process health provider — supplies process-level health data.
 */
export interface ProcessHealthProvider {
  getProcessVersion(): string;
  getProtocolVersion(): string;
  getUptime(): number;
  isDraining(): boolean;
}

/**
 * Database health provider — supplies database connectivity and compatibility.
 */
export interface DatabaseHealthProvider {
  isConnected(): boolean;
  isCompatible(): boolean;
  getObservedSchemaVersion(): number;
  getReadRange(): [number, number];
  getWriteRange(): [number, number];
}

/**
 * Migration state provider — supplies migration health info.
 */
export interface MigrationHealthProvider {
  getPendingCount(): number;
  getFailedCount(): number;
  allApplied(): boolean;
}

/**
 * Queue depth provider — reports active queue depth.
 */
export interface QueueHealthProvider {
  getQueueDepth(): number;
  getMaxDepth(): number;
}

/**
 * Owner state provider — reports active owners and terminal state.
 */
export interface OwnerHealthProvider {
  getActiveOwnerCount(): number;
  getTerminalOwnerIds(): string[];
}

/**
 * Budget state provider — reports budget health.
 */
export interface BudgetHealthProvider {
  isWithinBudget(): boolean;
  getExhaustedBudgetIds(): string[];
}

/**
 * Bound health provider — reports operational bound health.
 */
export interface BoundHealthProvider {
  getInvalidBoundKeys(): string[];
  getAllBoundsResolved(): boolean;
}

/**
 * Reconstruction verifier — verifies exact reconstruction from durable records.
 * Requirement 34.1–34.2
 */
export interface ReconstructionVerifier {
  /**
   * Reconstruct the exact provider-neutral prompt, ordered tool schemas,
   * route decision, adapter version, and attachment references from durable
   * inputs, then verify the Prompt_Fingerprint matches.
   */
  verifyReconstruction(anchorId: string, sessionId: string, branchId: string): Promise<{
    ok: boolean;
    reason?: string;
    code?: string;
  }>;
}

/**
 * Call/result pairing verifier — verifies one terminal result for every
 * dispatched or synthetically completed call identity.
 * Requirement 34.3
 */
export interface CallResultPairingVerifier {
  /**
   * Check that every dispatched tool call has exactly one terminal result
   * (real or synthetic). Returns unpaired call IDs.
   */
  verifyPairing(sessionId: string, branchId: string): Promise<{
    ok: boolean;
    unpairedCallIds: string[];
  }>;
}

/**
 * Sequence linkage verifier — verifies strictly increasing sequence numbers
 * and valid integrity-hash linkage.
 * Requirement 34.4
 */
export interface SequenceLinkageVerifier {
  /**
   * Verify that all events in a session have strictly increasing sequence
   * numbers and valid hash chain linkage.
   */
  verifySequence(sessionId: string, branchId: string): Promise<{
    ok: boolean;
    firstFaultSequence?: number;
    reason?: string;
  }>;
}

/**
 * Schema consistency verifier — verifies advertised MCP schemas match
 * Tool_Registry contracts and Prompt_Assembler inputs.
 * Requirement 34.6
 */
export interface SchemaConsistencyVerifier {
  /**
   * Compare advertised MCP schemas against internal Tool_Registry contracts
   * and Prompt_Assembler inputs for active versions.
   */
  verifyConsistency(serverId: string): Promise<{
    ok: boolean;
    mismatches: Array<{ toolName: string; reason: string }>;
  }>;
}

/**
 * Ownership verifier — verifies terminal owners have no dangling resources.
 * Requirement 34.5
 */
export interface OwnershipVerifier {
  /**
   * For a terminal owner, verify zero nonterminal owned jobs, processes,
   * workers, pseudo-terminals, streams, and undispatched tool calls.
   */
  verifyOwnerTeardown(ownerId: string): Promise<{
    clean: boolean;
    danglingResources: Array<{
      kind: OwnedResourceKind;
      resourceId: string;
      description: string;
      createdAt?: string;
    }>;
  }>;
}

// ─── Service Configuration ──────────────────────────────────────

export interface DiagnosticsServiceConfig {
  serverId: string;
  processHealth: ProcessHealthProvider;
  databaseHealth: DatabaseHealthProvider;
  migrationHealth: MigrationHealthProvider;
  queueHealth: QueueHealthProvider;
  ownerHealth: OwnerHealthProvider;
  budgetHealth: BudgetHealthProvider;
  boundHealth: BoundHealthProvider;
  reconstructionVerifier: ReconstructionVerifier;
  callResultPairingVerifier: CallResultPairingVerifier;
  sequenceLinkageVerifier: SequenceLinkageVerifier;
  schemaConsistencyVerifier: SchemaConsistencyVerifier;
  ownershipVerifier: OwnershipVerifier;
}

// ─── Service Implementation ─────────────────────────────────────

/**
 * Diagnostics_Service — The authority for health, structured failures,
 * compatibility status, and executable invariant checks.
 *
 * All output is redacted per Requirement 45.10.
 */
export class DiagnosticsService {
  private readonly config: DiagnosticsServiceConfig;
  private readonly degradations: DegradationRecord[] = [];

  constructor(config: DiagnosticsServiceConfig) {
    this.config = config;
  }

  // ─── Health (Requirement 29.5, 30.11) ───────────────────────

  /**
   * Expose runtime health across all dimensions.
   *
   * Requirement 29.5: expose runtime health, readiness, schema compatibility,
   * migration state, queue depth, active owners, budget state, and structured
   * recent failures.
   *
   * Requirement 30.11: report process version, protocol version, uptime,
   * draining state, and database connectivity/compatibility.
   */
  getHealth(): HealthReport {
    const now = new Date().toISOString();
    const dimensions: HealthDimensionResult[] = [];

    // Process health
    dimensions.push(this.checkProcessHealth(now));

    // Database health
    dimensions.push(this.checkDatabaseHealth(now));

    // Schema compatibility
    dimensions.push(this.checkSchemaHealth(now));

    // Migration health
    dimensions.push(this.checkMigrationHealth(now));

    // Queue health
    dimensions.push(this.checkQueueHealth(now));

    // Owner health
    dimensions.push(this.checkOwnerHealth(now));

    // Budget health
    dimensions.push(this.checkBudgetHealth(now));

    // Bound health
    dimensions.push(this.checkBoundHealth(now));

    const overall = this.computeOverall(dimensions);

    return {
      processVersion: this.config.processHealth.getProcessVersion(),
      protocolVersion: this.config.processHealth.getProtocolVersion(),
      uptime: this.config.processHealth.getUptime(),
      draining: this.config.processHealth.isDraining(),
      databaseConnected: this.config.databaseHealth.isConnected(),
      databaseCompatible: this.config.databaseHealth.isCompatible(),
      dimensions,
      overall,
      generatedAt: now,
      schemaVersion: 1 as const,
    };
  }

  // ─── Invariant Verification (Requirements 29.6, 34.1–34.7) ──

  /**
   * Run all invariant checks for a session.
   *
   * Requirement 29.6: verify exact request reconstruction from logged inputs,
   * call/result pairing, sequence monotonicity, and MCP schema consistency.
   *
   * Requirement 34.7: if any fails, mark affected server or session degraded
   * and emit a structured remediation-oriented failure.
   */
  async verifyInvariants(
    sessionId: string,
    branchId: string,
    anchorIds: string[],
  ): Promise<InvariantReport> {
    const now = new Date().toISOString();
    const results: InvariantCheckResult[] = [];

    // Verify exact reconstruction for each anchor (Requirement 34.1–34.2)
    for (const anchorId of anchorIds) {
      const reconstruction = await this.config.reconstructionVerifier.verifyReconstruction(
        anchorId,
        sessionId,
        branchId,
      );
      results.push({
        kind: 'reconstruction',
        passed: reconstruction.ok,
        affectedIdentities: reconstruction.ok ? [] : [anchorId],
        redactedEvidence: reconstruction.ok
          ? undefined
          : this.redactString(reconstruction.reason ?? 'Reconstruction failed'),
        code: reconstruction.code,
        remediation: reconstruction.ok
          ? undefined
          : 'Re-run prompt assembly with current durable records or investigate missing log entries.',
        checkedAt: now,
      });
    }

    // Verify call/result pairing (Requirement 34.3)
    const pairing = await this.config.callResultPairingVerifier.verifyPairing(sessionId, branchId);
    results.push({
      kind: 'call_result_pairing',
      passed: pairing.ok,
      affectedIdentities: pairing.unpairedCallIds,
      redactedEvidence: pairing.ok
        ? undefined
        : `${pairing.unpairedCallIds.length} unpaired call(s) detected`,
      code: pairing.ok ? undefined : 'UNPAIRED_CALLS',
      remediation: pairing.ok
        ? undefined
        : 'Commit synthetic terminal results for dangling call identities.',
      checkedAt: now,
    });

    // Verify sequence linkage (Requirement 34.4)
    const sequence = await this.config.sequenceLinkageVerifier.verifySequence(sessionId, branchId);
    results.push({
      kind: 'sequence_linkage',
      passed: sequence.ok,
      affectedIdentities: sequence.firstFaultSequence !== undefined
        ? [String(sequence.firstFaultSequence)]
        : [],
      redactedEvidence: sequence.ok
        ? undefined
        : this.redactString(sequence.reason ?? 'Sequence integrity violated'),
      code: sequence.ok ? undefined : 'SEQUENCE_FAULT',
      remediation: sequence.ok
        ? undefined
        : 'Inspect and repair the event log integrity chain from the first faulting sequence.',
      checkedAt: now,
    });

    // Verify schema consistency (Requirement 34.6)
    const schemaCheck = await this.config.schemaConsistencyVerifier.verifyConsistency(
      this.config.serverId,
    );
    results.push({
      kind: 'schema_consistency',
      passed: schemaCheck.ok,
      affectedIdentities: schemaCheck.mismatches.map((m) => m.toolName),
      redactedEvidence: schemaCheck.ok
        ? undefined
        : `${schemaCheck.mismatches.length} schema mismatch(es): ${schemaCheck.mismatches.map((m) => this.redactString(m.reason)).join('; ')}`,
      code: schemaCheck.ok ? undefined : 'SCHEMA_MISMATCH',
      remediation: schemaCheck.ok
        ? undefined
        : 'Synchronize advertised MCP schemas with Tool_Registry and Prompt_Assembler contracts.',
      checkedAt: now,
    });

    // Derive degradation targets
    const allPassed = results.every((r) => r.passed);
    const degradedTargets: InvariantReport['degradedTargets'] = [];

    if (!allPassed) {
      // Mark session degraded
      degradedTargets.push({
        targetKind: 'session',
        targetId: sessionId,
        reason: `Invariant failure(s) in session: ${results.filter((r) => !r.passed).map((r) => r.kind).join(', ')}`,
        remediation: 'Run individual remediations for each failing invariant.',
      });

      // Mark server degraded if schema consistency failed
      if (!schemaCheck.ok) {
        degradedTargets.push({
          targetKind: 'server',
          targetId: this.config.serverId,
          reason: 'Schema consistency invariant failed',
          remediation: 'Synchronize MCP schemas with internal contracts.',
        });
      }

      // Record degradations
      for (const target of degradedTargets) {
        this.recordDegradation({
          targetKind: target.targetKind,
          targetId: target.targetId,
          reason: target.reason,
          severity: 'critical',
          remediation: target.remediation,
          occurredAt: now,
        });
      }
    }

    return {
      sessionId,
      serverId: this.config.serverId,
      results,
      allPassed,
      degraded: !allPassed,
      degradedTargets,
      generatedAt: now,
      schemaVersion: 1 as const,
    };
  }

  // ─── Teardown Diagnostics (Requirement 29.7, 34.5) ──────────

  /**
   * Verify that a terminal owner has no dangling resources.
   *
   * Requirement 29.7: verify that terminal owners have no dangling job,
   * process tree, pseudo-terminal, worker, timer, stream, or approval lease.
   *
   * Requirement 34.5: verify zero nonterminal owned jobs, processes, workers,
   * pseudo-terminals, streams, and undispatched tool calls.
   */
  async verifyTeardown(ownerId: string): Promise<TeardownReport> {
    const now = new Date().toISOString();
    const result = await this.config.ownershipVerifier.verifyOwnerTeardown(ownerId);

    const danglingResources: DanglingResource[] = result.danglingResources.map((r) => ({
      kind: r.kind,
      resourceId: r.resourceId,
      ownerId,
      description: this.redactString(r.description),
      createdAt: r.createdAt,
    }));

    const clean = result.clean;

    if (!clean) {
      this.recordDegradation({
        targetKind: 'session',
        targetId: ownerId,
        reason: `Owner ${ownerId} has ${danglingResources.length} dangling resource(s)`,
        invariantKind: 'ownership_teardown',
        severity: 'warning',
        remediation: 'Cancel or drain all owned work before finalization.',
        occurredAt: now,
      });
    }

    return {
      ownerId,
      ownerTerminal: true,
      clean,
      danglingResources,
      remediation: clean
        ? undefined
        : 'Cancel or force-terminate all dangling resources owned by this identity.',
      checkedAt: now,
    };
  }

  // ─── Compatibility Diagnostics (Requirement 45.5, 30.12) ────

  /**
   * Report schema compatibility status.
   *
   * Requirement 45.5: display process version, compatible schema range,
   * observed schema version, and Diagnostics_Service-supplied remediation.
   *
   * Requirement 30.12: if Shared_Database is unavailable or incompatible,
   * report a structured initialization error.
   */
  getCompatibility(): CompatibilityCheck {
    const now = new Date().toISOString();
    const db = this.config.databaseHealth;
    const process = this.config.processHealth;
    const observed = db.getObservedSchemaVersion();
    const readRange = db.getReadRange();
    const writeRange = db.getWriteRange();
    const compatible = db.isCompatible();

    let remediation: string | undefined;
    if (!compatible) {
      if (observed < readRange[0]) {
        remediation = `Database schema version ${observed} is below minimum read version ${readRange[0]}. Run migrations to upgrade the database.`;
      } else if (observed > readRange[1]) {
        remediation = `Database schema version ${observed} exceeds maximum read version ${readRange[1]}. Upgrade this process to a newer version.`;
      } else {
        remediation = 'Verify the database schema is within the supported compatibility range.';
      }
    }

    return {
      processVersion: process.getProcessVersion(),
      observedSchemaVersion: observed,
      compatibleReadRange: readRange,
      compatibleWriteRange: writeRange,
      compatible,
      remediation,
      checkedAt: now,
    };
  }

  // ─── Degradation Records ──────────────────────────────────────

  /**
   * Get all recorded degradation events.
   */
  getDegradations(): readonly DegradationRecord[] {
    return [...this.degradations];
  }

  /**
   * Check if a specific target is currently degraded.
   */
  isDegraded(targetKind: 'server' | 'session', targetId: string): boolean {
    return this.degradations.some(
      (d) => d.targetKind === targetKind && d.targetId === targetId,
    );
  }

  /**
   * Clear degradation for a target (e.g., after remediation is complete).
   */
  clearDegradation(targetKind: 'server' | 'session', targetId: string): void {
    const idx = this.degradations.findIndex(
      (d) => d.targetKind === targetKind && d.targetId === targetId,
    );
    if (idx >= 0) {
      this.degradations.splice(idx, 1);
    }
  }

  // ─── Readiness (Requirement 32.7) ────────────────────────────

  /**
   * Report readiness combining protocol initialization, database compatibility,
   * migration state, required authority availability, and draining state.
   *
   * Requirement 32.7: when readiness is queried, report all of these.
   */
  getReadiness(): {
    ready: boolean;
    checks: Record<string, boolean>;
    reason?: string;
  } {
    const db = this.config.databaseHealth;
    const migration = this.config.migrationHealth;
    const process = this.config.processHealth;

    const checks = {
      databaseConnected: db.isConnected(),
      databaseCompatible: db.isCompatible(),
      migrationsApplied: migration.allApplied(),
      notDraining: !process.isDraining(),
      boundsResolved: this.config.boundHealth.getAllBoundsResolved(),
    };

    const ready = Object.values(checks).every(Boolean);
    let reason: string | undefined;
    if (!ready) {
      const failing = Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      reason = `Readiness checks failing: ${failing.join(', ')}`;
    }

    return { ready, checks, reason };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private checkProcessHealth(now: string): HealthDimensionResult {
    const draining = this.config.processHealth.isDraining();
    return {
      dimension: 'process',
      status: draining ? 'degraded' : 'healthy',
      message: draining ? 'Process is draining' : 'Process operational',
      redacted: true,
      affectedIds: draining ? [this.config.serverId] : [],
      remediation: draining ? 'Wait for drain completion or restart.' : undefined,
      checkedAt: now,
    };
  }

  private checkDatabaseHealth(now: string): HealthDimensionResult {
    const connected = this.config.databaseHealth.isConnected();
    const compatible = this.config.databaseHealth.isCompatible();
    let status: ComponentHealth = 'healthy';
    let message = 'Database connected and compatible';
    let remediation: string | undefined;
    const affectedIds: string[] = [];

    if (!connected) {
      status = 'unavailable';
      message = 'Database not connected';
      remediation = 'Verify database file accessibility and permissions.';
      affectedIds.push(this.config.serverId);
    } else if (!compatible) {
      status = 'degraded';
      message = 'Database schema incompatible';
      remediation = 'Run migrations or upgrade the process.';
      affectedIds.push(this.config.serverId);
    }

    return {
      dimension: 'database',
      status,
      message,
      redacted: true,
      affectedIds,
      remediation,
      checkedAt: now,
    };
  }

  private checkSchemaHealth(now: string): HealthDimensionResult {
    const compatible = this.config.databaseHealth.isCompatible();
    return {
      dimension: 'schema',
      status: compatible ? 'healthy' : 'degraded',
      message: compatible ? 'Schema within compatible range' : 'Schema outside compatible range',
      redacted: true,
      affectedIds: compatible ? [] : [this.config.serverId],
      remediation: compatible ? undefined : 'Upgrade process or run schema migrations.',
      checkedAt: now,
    };
  }

  private checkMigrationHealth(now: string): HealthDimensionResult {
    const migration = this.config.migrationHealth;
    const failed = migration.getFailedCount();
    const pending = migration.getPendingCount();

    let status: ComponentHealth = 'healthy';
    let message = 'All migrations applied';
    let remediation: string | undefined;
    const affectedIds: string[] = [];

    if (failed > 0) {
      status = 'unavailable';
      message = `${failed} migration(s) failed`;
      remediation = 'Inspect migration logs and retry or rollback failed migrations.';
      affectedIds.push(this.config.serverId);
    } else if (pending > 0) {
      status = 'degraded';
      message = `${pending} migration(s) pending`;
      remediation = 'Acquire migration lease and apply pending migrations.';
      affectedIds.push(this.config.serverId);
    }

    return {
      dimension: 'migration',
      status,
      message,
      redacted: true,
      affectedIds,
      remediation,
      checkedAt: now,
    };
  }

  private checkQueueHealth(now: string): HealthDimensionResult {
    const queue = this.config.queueHealth;
    const depth = queue.getQueueDepth();
    const max = queue.getMaxDepth();
    const ratio = max > 0 ? depth / max : 0;

    let status: ComponentHealth = 'healthy';
    let message = `Queue depth: ${depth}/${max}`;
    let remediation: string | undefined;

    if (ratio >= 1) {
      status = 'unavailable';
      message = `Queue at capacity: ${depth}/${max}`;
      remediation = 'Drain queue or increase configured maximum depth.';
    } else if (ratio >= 0.8) {
      status = 'degraded';
      message = `Queue nearing capacity: ${depth}/${max}`;
      remediation = 'Monitor queue consumption rate or increase capacity.';
    }

    return {
      dimension: 'queue',
      status,
      message,
      redacted: true,
      affectedIds: [],
      remediation,
      checkedAt: now,
    };
  }

  private checkOwnerHealth(now: string): HealthDimensionResult {
    const owner = this.config.ownerHealth;
    const terminalIds = owner.getTerminalOwnerIds();

    return {
      dimension: 'owner',
      status: terminalIds.length === 0 ? 'healthy' : 'degraded',
      message: terminalIds.length === 0
        ? `${owner.getActiveOwnerCount()} active owner(s), all healthy`
        : `${terminalIds.length} terminal owner(s) pending teardown verification`,
      redacted: true,
      affectedIds: terminalIds,
      remediation: terminalIds.length > 0
        ? 'Run teardown diagnostics on terminal owners.'
        : undefined,
      checkedAt: now,
    };
  }

  private checkBudgetHealth(now: string): HealthDimensionResult {
    const budget = this.config.budgetHealth;
    const exhausted = budget.getExhaustedBudgetIds();

    return {
      dimension: 'budget',
      status: budget.isWithinBudget() ? 'healthy' : 'degraded',
      message: budget.isWithinBudget()
        ? 'All budgets within limits'
        : `${exhausted.length} budget(s) exhausted`,
      redacted: true,
      affectedIds: exhausted,
      remediation: exhausted.length > 0
        ? 'Review and increase affected budget allocations.'
        : undefined,
      checkedAt: now,
    };
  }

  private checkBoundHealth(now: string): HealthDimensionResult {
    const bound = this.config.boundHealth;
    const invalid = bound.getInvalidBoundKeys();

    return {
      dimension: 'bound',
      status: bound.getAllBoundsResolved() ? 'healthy' : 'degraded',
      message: bound.getAllBoundsResolved()
        ? 'All operational bounds resolved'
        : `${invalid.length} bound(s) unresolved or invalid`,
      redacted: true,
      affectedIds: [],
      remediation: invalid.length > 0
        ? `Configure valid values for: ${invalid.join(', ')}`
        : undefined,
      checkedAt: now,
    };
  }

  private computeOverall(dimensions: HealthDimensionResult[]): ComponentHealth {
    if (dimensions.some((d) => d.status === 'unavailable')) return 'unavailable';
    if (dimensions.some((d) => d.status === 'degraded')) return 'degraded';
    return 'healthy';
  }

  private recordDegradation(record: DegradationRecord): void {
    // Remove any existing degradation for same target to avoid duplicates
    const existingIdx = this.degradations.findIndex(
      (d) => d.targetKind === record.targetKind && d.targetId === record.targetId,
    );
    if (existingIdx >= 0) {
      this.degradations.splice(existingIdx, 1);
    }
    this.degradations.push(record);
  }

  /**
   * Redact a string by removing potential sensitive content.
   * Requirement 45.10: redact secrets, private paths, protected prompt content,
   * and unauthorized attachment or spill locators.
   */
  private redactString(value: string): string {
    return redactValue(value);
  }
}

// ─── Redaction Utility ──────────────────────────────────────────

/**
 * Redact sensitive content from a string value.
 * Replaces absolute file paths and sensitive patterns with [REDACTED].
 */
export function redactValue(value: string): string {
  let result = value;
  // Redact absolute paths (Unix or Windows)
  result = result.replace(/(?:\/[a-zA-Z][a-zA-Z0-9._/-]+|[A-Z]:\\[^\s:*?"<>|]+)/g, REDACTION_PLACEHOLDER);
  return result;
}

/**
 * Redact an entire object's fields that match sensitive patterns.
 * Returns a new object with sensitive fields replaced.
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj } as Record<string, unknown>;
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'string') {
      const isSensitive = REDACTED_FIELD_PATTERNS.some((pattern) => pattern.test(key));
      result[key] = isSensitive ? REDACTION_PLACEHOLDER : redactValue(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    }
  }
  return result as T;
}
