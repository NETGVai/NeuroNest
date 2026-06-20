/**
 * BenchmarkFramework — Runs comparative evaluations of model configurations
 * against a shared prompt and collects performance metrics.
 *
 * Implements createProfile, runBenchmark, getResults, listProfiles, getHistoricalTrends.
 * Executes the same prompt against multiple model configurations via AgentLoopController.
 * Measures tokens consumed, wall-clock duration, and tool-call iterations per run.
 * Persists results in SQLite benchmark_runs and benchmark_results tables.
 * Stores profiles in `.neuronest/benchmarks/*.json`.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5
 */

import Database from 'better-sqlite3';
import { uuidv7 } from 'uuidv7';
import * as fs from 'fs';
import * as path from 'path';
import type {
  BenchmarkProfile,
  BenchmarkRun,
  BenchmarkResult,
  ModelConfiguration,
} from '../shared/feature-integration-types.js';
import { FeatureError } from '../shared/feature-integration-errors.js';
import type { AgentLoopController, AgentLoopConfig, AgentLLMClient } from '../pipeline/agent-loop.js';
import type { ToolSystem } from '../tools/tool-system.js';

// ─── Types ──────────────────────────────────────────────────────

/** Options for creating the BenchmarkFramework. */
export interface BenchmarkFrameworkOptions {
  /** Root project directory for resolving `.neuronest/benchmarks/` paths. */
  projectDir: string;
  /** SQLite database instance for persisting benchmark runs and results. */
  db: Database.Database;
  /** ToolSystem for agent loop integration. */
  toolSystem: ToolSystem;
  /**
   * Factory function that creates an AgentLLMClient for a given model configuration.
   * This enables the benchmark framework to run the same prompt against different models.
   */
  createLLMClient: (config: ModelConfiguration) => AgentLLMClient;
  /**
   * Factory that creates an AgentLoopController for a given config.
   * Allows the benchmark to control how the agent loop is instantiated.
   */
  createAgentLoop: (config: AgentLoopConfig) => AgentLoopController;
}

/** Internal row shape for benchmark_runs from SQLite. */
interface BenchmarkRunRow {
  id: string;
  profile_id: string;
  started_at: string;
  completed_at: string | null;
}

/** Internal row shape for benchmark_results from SQLite. */
interface BenchmarkResultRow {
  id: string;
  run_id: string;
  configuration_id: string;
  tokens_consumed: number;
  duration_ms: number;
  tool_call_iterations: number;
  quality_score: number | null;
  output: string | null;
}

// ─── BenchmarkFramework ─────────────────────────────────────────

export class BenchmarkFramework {
  private readonly projectDir: string;
  private readonly db: Database.Database;
  private readonly toolSystem: ToolSystem;
  private readonly createLLMClient: (config: ModelConfiguration) => AgentLLMClient;
  private readonly createAgentLoop: (config: AgentLoopConfig) => AgentLoopController;

  // Prepared statements
  private stmtInsertRun: Database.Statement;
  private stmtCompleteRun: Database.Statement;
  private stmtGetRun: Database.Statement;
  private stmtGetRunsByProfile: Database.Statement;
  private stmtInsertResult: Database.Statement;
  private stmtGetResultsByRun: Database.Statement;

  constructor(options: BenchmarkFrameworkOptions) {
    this.projectDir = options.projectDir;
    this.db = options.db;
    this.toolSystem = options.toolSystem;
    this.createLLMClient = options.createLLMClient;
    this.createAgentLoop = options.createAgentLoop;

    // Prepare SQL statements
    this.stmtInsertRun = this.db.prepare(
      `INSERT INTO benchmark_runs (id, profile_id, started_at, completed_at)
       VALUES (?, ?, ?, ?)`,
    );

    this.stmtCompleteRun = this.db.prepare(
      `UPDATE benchmark_runs SET completed_at = ? WHERE id = ?`,
    );

    this.stmtGetRun = this.db.prepare(
      `SELECT id, profile_id, started_at, completed_at
       FROM benchmark_runs WHERE id = ?`,
    );

    this.stmtGetRunsByProfile = this.db.prepare(
      `SELECT id, profile_id, started_at, completed_at
       FROM benchmark_runs WHERE profile_id = ? ORDER BY started_at DESC`,
    );

    this.stmtInsertResult = this.db.prepare(
      `INSERT INTO benchmark_results (id, run_id, configuration_id, tokens_consumed, duration_ms, tool_call_iterations, quality_score, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.stmtGetResultsByRun = this.db.prepare(
      `SELECT id, run_id, configuration_id, tokens_consumed, duration_ms, tool_call_iterations, quality_score, output
       FROM benchmark_results WHERE run_id = ?`,
    );
  }

  // ─── Profile Management ─────────────────────────────────────

  /**
   * Create a new benchmark profile and persist it to `.neuronest/benchmarks/<id>.json`.
   */
  async createProfile(profile: Omit<BenchmarkProfile, 'id'>): Promise<BenchmarkProfile> {
    if (!profile.name || profile.name.trim() === '') {
      throw new FeatureError({
        message: 'Benchmark profile name is required',
        category: 'benchmark',
        code: 'PROFILE_NAME_REQUIRED',
      });
    }

    if (!profile.prompt || profile.prompt.trim() === '') {
      throw new FeatureError({
        message: 'Benchmark profile prompt is required',
        category: 'benchmark',
        code: 'PROFILE_PROMPT_REQUIRED',
      });
    }

    if (!profile.configurations || profile.configurations.length < 2) {
      throw new FeatureError({
        message: 'Benchmark profile must have at least 2 model configurations for comparison',
        category: 'benchmark',
        code: 'INSUFFICIENT_CONFIGURATIONS',
      });
    }

    const id = uuidv7();
    const benchmarkProfile: BenchmarkProfile = {
      id,
      name: profile.name,
      prompt: profile.prompt,
      configurations: profile.configurations,
      evaluationCriteria: profile.evaluationCriteria ?? [],
    };

    this.persistProfile(benchmarkProfile);
    return benchmarkProfile;
  }

  /**
   * List all benchmark profiles stored in `.neuronest/benchmarks/`.
   */
  async listProfiles(): Promise<BenchmarkProfile[]> {
    const dir = this.getBenchmarksDir();
    if (!fs.existsSync(dir)) {
      return [];
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const profiles: BenchmarkProfile[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const profile = JSON.parse(content) as BenchmarkProfile;
        profiles.push(profile);
      } catch {
        // Skip malformed profile files
      }
    }

    return profiles;
  }

  // ─── Benchmark Execution ────────────────────────────────────

  /**
   * Run a benchmark: execute the profile's prompt against each model configuration,
   * measure metrics, and persist results.
   */
  async runBenchmark(profileId: string): Promise<BenchmarkRun> {
    const profile = await this.loadProfile(profileId);
    if (!profile) {
      throw new FeatureError({
        message: `Benchmark profile not found: ${profileId}`,
        category: 'benchmark',
        code: 'PROFILE_NOT_FOUND',
        details: { profileId },
      });
    }

    const runId = uuidv7();
    const startedAt = new Date().toISOString();

    // Insert the run record
    this.stmtInsertRun.run(runId, profileId, startedAt, null);

    const results: BenchmarkResult[] = [];

    // Execute prompt against each configuration
    for (const config of profile.configurations) {
      const result = await this.executeConfiguration(profile, config, runId);
      results.push(result);
    }

    // Mark run as completed
    const completedAt = new Date().toISOString();
    this.stmtCompleteRun.run(completedAt, runId);

    return {
      id: runId,
      profileId,
      results,
      startedAt,
      completedAt,
    };
  }

  // ─── Results Retrieval ──────────────────────────────────────

  /**
   * Get a benchmark run with all its results by run ID.
   */
  async getResults(runId: string): Promise<BenchmarkRun> {
    const runRow = this.stmtGetRun.get(runId) as BenchmarkRunRow | undefined;
    if (!runRow) {
      throw new FeatureError({
        message: `Benchmark run not found: ${runId}`,
        category: 'benchmark',
        code: 'RUN_NOT_FOUND',
        details: { runId },
      });
    }

    const resultRows = this.stmtGetResultsByRun.all(runId) as BenchmarkResultRow[];
    const results = resultRows.map(rowToResult);

    const run: BenchmarkRun = {
      id: runRow.id,
      profileId: runRow.profile_id,
      results,
      startedAt: runRow.started_at,
    };
    if (runRow.completed_at) {
      run.completedAt = runRow.completed_at;
    }
    return run;
  }

  /**
   * Get historical benchmark runs for a given profile, ordered by most recent first.
   */
  async getHistoricalTrends(profileId: string): Promise<BenchmarkRun[]> {
    const runRows = this.stmtGetRunsByProfile.all(profileId) as BenchmarkRunRow[];
    const runs: BenchmarkRun[] = [];

    for (const runRow of runRows) {
      const resultRows = this.stmtGetResultsByRun.all(runRow.id) as BenchmarkResultRow[];
      const run: BenchmarkRun = {
        id: runRow.id,
        profileId: runRow.profile_id,
        results: resultRows.map(rowToResult),
        startedAt: runRow.started_at,
      };
      if (runRow.completed_at) {
        run.completedAt = runRow.completed_at;
      }
      runs.push(run);
    }

    return runs;
  }

  // ─── Private Helpers ────────────────────────────────────────

  /**
   * Execute a single model configuration benchmark, measuring metrics.
   */
  private async executeConfiguration(
    profile: BenchmarkProfile,
    config: ModelConfiguration,
    runId: string,
  ): Promise<BenchmarkResult> {
    const resultId = uuidv7();
    const startTime = Date.now();

    let tokensConsumed = 0;
    let toolCallIterations = 0;
    let output = '';

    try {
      // Create an LLM client for this specific model configuration
      const llmClient = this.createLLMClient(config);

      // Build agent loop config for this configuration
      const agentLoopConfig: AgentLoopConfig = {
        llmClient,
        toolSystem: this.toolSystem,
        projectDir: this.projectDir,
        sessionId: `benchmark-${runId}-${config.id}`,
        maxIterations: config.maxTokens > 0 ? 25 : 25, // Standard iteration limit
        planMode: false,
        turboEditsEnabled: false,
        smartContextEnabled: false,
      };

      // Create and run the agent loop
      const agentLoop = this.createAgentLoop(agentLoopConfig);
      const result = await agentLoop.run(profile.prompt);

      // Extract metrics from the result
      tokensConsumed = result.tokenUsage?.totalTokens ?? 0;
      toolCallIterations = result.toolCallsExecuted ?? 0;
      output = result.response ?? '';
    } catch (error) {
      // Record failure in output
      output = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }

    const durationMs = Date.now() - startTime;

    // Persist the result
    this.stmtInsertResult.run(
      resultId,
      runId,
      config.id,
      tokensConsumed,
      durationMs,
      toolCallIterations,
      null, // quality_score is user-assigned later
      output,
    );

    return {
      configurationId: config.id,
      tokensConsumed,
      durationMs,
      toolCallIterations,
      output,
    };
  }

  /**
   * Load a benchmark profile from disk by ID.
   */
  private async loadProfile(profileId: string): Promise<BenchmarkProfile | null> {
    const filePath = path.join(this.getBenchmarksDir(), `${profileId}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as BenchmarkProfile;
    } catch {
      return null;
    }
  }

  /**
   * Persist a benchmark profile to `.neuronest/benchmarks/<id>.json`.
   */
  private persistProfile(profile: BenchmarkProfile): void {
    const dir = this.getBenchmarksDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${profile.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8');
  }

  /**
   * Get the benchmarks directory path.
   */
  private getBenchmarksDir(): string {
    return path.join(this.projectDir, '.neuronest', 'benchmarks');
  }
}

// ─── Validation Helpers ─────────────────────────────────────────

/**
 * Validates that a BenchmarkResult has valid metrics:
 * - tokensConsumed >= 0
 * - durationMs >= 0
 * - toolCallIterations >= 0
 * - qualityScore (when present) is in [1, 10]
 *
 * Returns a ValidationResult indicating whether the result is valid.
 */
export function validateBenchmarkResult(result: BenchmarkResult): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (result.tokensConsumed < 0) {
    errors.push(`tokensConsumed must be >= 0, got ${result.tokensConsumed}`);
  }

  if (result.durationMs < 0) {
    errors.push(`durationMs must be >= 0, got ${result.durationMs}`);
  }

  if (result.toolCallIterations < 0) {
    errors.push(`toolCallIterations must be >= 0, got ${result.toolCallIterations}`);
  }

  if (result.qualityScore != null) {
    if (result.qualityScore < 1 || result.qualityScore > 10) {
      errors.push(`qualityScore must be in [1, 10], got ${result.qualityScore}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── Row Conversion Helpers ───────────────────────────────────

function rowToResult(row: BenchmarkResultRow): BenchmarkResult {
  const result: BenchmarkResult = {
    configurationId: row.configuration_id,
    tokensConsumed: row.tokens_consumed,
    durationMs: row.duration_ms,
    toolCallIterations: row.tool_call_iterations,
    output: row.output ?? '',
  };
  if (row.quality_score != null) {
    result.qualityScore = row.quality_score;
  }
  return result;
}
