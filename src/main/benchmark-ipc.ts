/**
 * IPC handler registration for the Benchmark Framework.
 *
 * Uses the lazy-singleton + ipcMain.handle() pattern matching existing NeuroNest
 * IPC modules (artifact-ipc.ts, diagnostics-ipc.ts, skill-packs-ipc.ts).
 *
 * Channels:
 *   bench:create-profile — create a new benchmark profile
 *   bench:run            — execute a benchmark run against a profile
 *   bench:results        — retrieve results for a specific benchmark run
 *   bench:trends         — get historical trend data for a profile
 *
 * Requirements: 15.3
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { BenchmarkFramework, type BenchmarkFrameworkOptions } from '../benchmark/benchmark-framework.js';
import type { BenchmarkProfile, BenchmarkRun, ModelConfiguration } from '../shared/feature-integration-types.js';

// ─── IPCErrorResponse ───────────────────────────────────────────

export interface BenchmarkIPCErrorResponse {
  error: true;
  code: string;
  message: string;
}

// ─── Lazy singleton ─────────────────────────────────────────────

let benchmarkFramework: BenchmarkFramework | null = null;

function getBenchmarkFramework(options: BenchmarkFrameworkOptions): BenchmarkFramework {
  if (!benchmarkFramework) benchmarkFramework = new BenchmarkFramework(options);
  return benchmarkFramework;
}

// ─── Error helper ───────────────────────────────────────────────

function makeError(code: string, err: unknown): BenchmarkIPCErrorResponse {
  return {
    error: true,
    code,
    message: err instanceof Error ? err.message : String(err),
  };
}

// ─── Types for IPC arguments ────────────────────────────────────

interface CreateProfileArgs {
  name: string;
  prompt: string;
  configurations: ModelConfiguration[];
  evaluationCriteria?: Array<{ name: string; weight: number; description?: string }>;
}

interface RunBenchmarkArgs {
  profileId: string;
}

interface GetResultsArgs {
  runId: string;
}

interface GetTrendsArgs {
  profileId: string;
}

interface ListProfilesArgs {
  /* no args needed */
}

// ─── Registration ───────────────────────────────────────────────

export function registerBenchmarkIPC(
  _mainWindow: BrowserWindow,
  options: BenchmarkFrameworkOptions,
): void {
  // ── bench:list-profiles ──
  // List all available benchmark profiles
  ipcMain.handle(
    'bench:list-profiles',
    async () => {
      try {
        const framework = getBenchmarkFramework(options);
        const profiles = await framework.listProfiles();
        return { profiles };
      } catch (err) {
        return makeError('PROFILES_LIST_FAILED', err);
      }
    },
  );

  // ── bench:create-profile ──
  // Requirement 15.5: Support benchmark profiles as JSON files
  ipcMain.handle(
    'bench:create-profile',
    async (_event, args: CreateProfileArgs) => {
      try {
        const framework = getBenchmarkFramework(options);
        const profile = await framework.createProfile({
          name: args.name,
          prompt: args.prompt,
          configurations: args.configurations,
          evaluationCriteria: args.evaluationCriteria ?? [],
        });
        return { profile };
      } catch (err) {
        return makeError('PROFILE_CREATE_FAILED', err);
      }
    },
  );

  // ── bench:run ──
  // Requirement 15.1: Execute benchmark against model configurations
  ipcMain.handle(
    'bench:run',
    async (_event, args: RunBenchmarkArgs) => {
      try {
        const framework = getBenchmarkFramework(options);
        const run = await framework.runBenchmark(args.profileId);
        return { run };
      } catch (err) {
        return makeError('BENCHMARK_RUN_FAILED', err);
      }
    },
  );

  // ── bench:results ──
  // Requirement 15.3: Retrieve benchmark results for comparison table display
  ipcMain.handle(
    'bench:results',
    async (_event, args: GetResultsArgs) => {
      try {
        const framework = getBenchmarkFramework(options);
        const run = await framework.getResults(args.runId);
        return { run };
      } catch (err) {
        return makeError('RESULTS_FETCH_FAILED', err);
      }
    },
  );

  // ── bench:trends ──
  // Requirement 15.4: Historical trend analysis from persisted results
  ipcMain.handle(
    'bench:trends',
    async (_event, args: GetTrendsArgs) => {
      try {
        const framework = getBenchmarkFramework(options);
        const runs = await framework.getHistoricalTrends(args.profileId);
        return { runs };
      } catch (err) {
        return makeError('TRENDS_FETCH_FAILED', err);
      }
    },
  );
}
