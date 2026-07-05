// ─── Loop Storage Data Access ───────────────────────────────────
// SQLite-backed CRUD for loop specs, runs, and passes.
// Implements LoopStorageLike from src/loop-engine/index.ts.
// Requirements: 2.1, 2.2, 2.3, 9.3

import type Database from 'better-sqlite3';
import type {
  LoopSpec,
  LoopSpecRow,
  LoopRunRow,
  LoopPassRow,
  LoopStorageLike,
} from '../index.js';

export class LoopStorage implements LoopStorageLike {
  // ── Spec statements ──
  private readonly insertSpecStmt: Database.Statement;
  private readonly getSpecStmt: Database.Statement;
  private readonly listSpecsStmt: Database.Statement;
  private readonly deleteSpecStmt: Database.Statement;

  // ── Run statements ──
  private readonly insertRunStmt: Database.Statement;
  private readonly updateRunStmt: Database.Statement;
  private readonly getRunStmt: Database.Statement;
  private readonly getRunningRunsStmt: Database.Statement;

  // ── Pass statements ──
  private readonly insertPassStmt: Database.Statement;
  private readonly updatePassStmt: Database.Statement;
  private readonly getPassesForRunStmt: Database.Statement;
  private readonly deleteIncompletePassStmt: Database.Statement;

  // ── Receipt statements ──
  private readonly getReceiptStmt: Database.Statement;
  private readonly writeReceiptStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    // ── Spec CRUD ──
    this.insertSpecStmt = this.db.prepare(
      `INSERT OR REPLACE INTO loop_specs (id, version, json, source, catalog_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    this.getSpecStmt = this.db.prepare(
      'SELECT * FROM loop_specs WHERE id = ?',
    );

    this.listSpecsStmt = this.db.prepare(
      'SELECT * FROM loop_specs ORDER BY created_at DESC',
    );

    this.deleteSpecStmt = this.db.prepare(
      'DELETE FROM loop_specs WHERE id = ?',
    );

    // ── Run lifecycle ──
    this.insertRunStmt = this.db.prepare(
      `INSERT INTO loop_runs (id, spec_id, spec_version, session_id, status, stop_reason, passes_completed, cost_usd, started_at, ended_at, receipt_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.updateRunStmt = this.db.prepare(
      `UPDATE loop_runs SET
        status = COALESCE(?, status),
        stop_reason = COALESCE(?, stop_reason),
        passes_completed = COALESCE(?, passes_completed),
        cost_usd = COALESCE(?, cost_usd),
        ended_at = COALESCE(?, ended_at)
       WHERE id = ?`,
    );

    this.getRunStmt = this.db.prepare(
      'SELECT * FROM loop_runs WHERE id = ?',
    );

    this.getRunningRunsStmt = this.db.prepare(
      "SELECT * FROM loop_runs WHERE status = 'running'",
    );

    // ── Pass records ──
    this.insertPassStmt = this.db.prepare(
      `INSERT INTO loop_passes (id, run_id, pass_number, action_summary, verify_results_json, evidence_json, cost_usd, security_scan_id, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.updatePassStmt = this.db.prepare(
      `UPDATE loop_passes SET
        action_summary = COALESCE(?, action_summary),
        verify_results_json = COALESCE(?, verify_results_json),
        evidence_json = COALESCE(?, evidence_json),
        cost_usd = COALESCE(?, cost_usd),
        security_scan_id = COALESCE(?, security_scan_id),
        ended_at = COALESCE(?, ended_at)
       WHERE id = ?`,
    );

    this.getPassesForRunStmt = this.db.prepare(
      'SELECT * FROM loop_passes WHERE run_id = ? ORDER BY pass_number ASC',
    );

    this.deleteIncompletePassStmt = this.db.prepare(
      'DELETE FROM loop_passes WHERE run_id = ? AND pass_number = ? AND ended_at IS NULL',
    );

    // ── Receipt ──
    this.getReceiptStmt = this.db.prepare(
      'SELECT receipt_json FROM loop_runs WHERE id = ?',
    );

    this.writeReceiptStmt = this.db.prepare(
      'UPDATE loop_runs SET receipt_json = ? WHERE id = ?',
    );
  }

  // ─── Spec CRUD ──────────────────────────────────────────────────

  async saveSpec(spec: LoopSpec): Promise<void> {
    this.insertSpecStmt.run(
      spec.id,
      spec.version,
      JSON.stringify(spec),
      spec.source,
      spec.catalogRef ?? null,
      new Date().toISOString(),
    );
  }

  async getSpec(id: string): Promise<LoopSpecRow | null> {
    const row = this.getSpecStmt.get(id) as LoopSpecRow | undefined;
    return row ?? null;
  }

  async listSpecs(): Promise<LoopSpecRow[]> {
    return this.listSpecsStmt.all() as LoopSpecRow[];
  }

  async deleteSpec(id: string): Promise<boolean> {
    const result = this.deleteSpecStmt.run(id);
    return result.changes > 0;
  }

  // ─── Run Lifecycle ──────────────────────────────────────────────

  async createRun(run: Omit<LoopRunRow, 'ended_at' | 'receipt_json'>): Promise<void> {
    this.insertRunStmt.run(
      run.id,
      run.spec_id,
      run.spec_version,
      run.session_id,
      run.status,
      run.stop_reason ?? null,
      run.passes_completed,
      run.cost_usd,
      run.started_at,
      null, // ended_at
      null, // receipt_json
    );
  }

  async updateRun(id: string, updates: Partial<LoopRunRow>): Promise<void> {
    this.updateRunStmt.run(
      updates.status ?? null,
      updates.stop_reason ?? null,
      updates.passes_completed ?? null,
      updates.cost_usd ?? null,
      updates.ended_at ?? null,
      id,
    );
  }

  async getRun(id: string): Promise<LoopRunRow | null> {
    const row = this.getRunStmt.get(id) as LoopRunRow | undefined;
    return row ?? null;
  }

  async getRunningRuns(): Promise<LoopRunRow[]> {
    return this.getRunningRunsStmt.all() as LoopRunRow[];
  }

  // ─── Pass Records ──────────────────────────────────────────────

  async createPass(pass: LoopPassRow): Promise<void> {
    this.insertPassStmt.run(
      pass.id,
      pass.run_id,
      pass.pass_number,
      pass.action_summary ?? null,
      pass.verify_results_json ?? null,
      pass.evidence_json ?? null,
      pass.cost_usd,
      pass.security_scan_id ?? null,
      pass.started_at,
      pass.ended_at ?? null,
    );
  }

  async updatePass(id: string, updates: Partial<LoopPassRow>): Promise<void> {
    this.updatePassStmt.run(
      updates.action_summary ?? null,
      updates.verify_results_json ?? null,
      updates.evidence_json ?? null,
      updates.cost_usd ?? null,
      updates.security_scan_id ?? null,
      updates.ended_at ?? null,
      id,
    );
  }

  async getPassesForRun(runId: string): Promise<LoopPassRow[]> {
    return this.getPassesForRunStmt.all(runId) as LoopPassRow[];
  }

  async deleteIncompletePass(runId: string, passNumber: number): Promise<void> {
    this.deleteIncompletePassStmt.run(runId, passNumber);
  }

  // ─── Receipt Immutability (Req 9.3) ────────────────────────────

  async writeReceipt(runId: string, receiptJson: string): Promise<void> {
    const row = this.getReceiptStmt.get(runId) as { receipt_json: string | null } | undefined;
    if (!row) {
      throw new Error(`Loop run '${runId}' not found`);
    }
    if (row.receipt_json !== null) {
      throw new Error(
        `Receipt for run '${runId}' is immutable and has already been written`,
      );
    }
    this.writeReceiptStmt.run(receiptJson, runId);
  }

  async getReceipt(runId: string): Promise<string | null> {
    const row = this.getReceiptStmt.get(runId) as { receipt_json: string | null } | undefined;
    return row?.receipt_json ?? null;
  }
}
