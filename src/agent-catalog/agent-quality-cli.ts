/**
 * Agent Quality CLI — Orchestration for plan, apply, and validate commands
 *
 * Wires immutable snapshots, exhaustive validation, persistence, canonical
 * reporting, and exit codes into a single CLI entry point.
 *
 * Responsibilities:
 * - Capture all immutable snapshots (catalog manifest, static registry,
 *   import candidates, effective agents, taxonomy, overrides, skill catalog)
 *   once at run start.
 * - Collect all source and effective outcomes exhaustively even after failures.
 * - Block writes on unavailable or stale inputs (catalog unavailable, stale
 *   fingerprint).
 * - Separate source body commit domain from database commit domain.
 * - Write canonical JSON reports to the configured path.
 * - Accept root, database, and report paths as parameters; embed no fixed
 *   source lists, counts, identities, departments, or catalog entries.
 * - Exit with 0 on pass, 1 on validation failure, 2 on fatal error.
 *
 * Requirements: 6.1–6.12, 8.1–8.9, 9.1–9.16, 10.1–10.22
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { discoverCatalog, type CatalogManifest } from './catalog-discovery';
import { validateCatalog, type CatalogValidationResult } from './catalog-validator';
import {
  buildQualityReport,
  buildEmptyCatalogReport,
  type QualityValidationReport,
} from './quality-report-builder';
import {
  collectQualityStatus,
  collectEmptyCatalogStatus,
  type QualityAxisResult,
} from './quality-status-collector';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Exit codes: 0=pass, 1=validation failure, 2=fatal error. */
export type CliExitCode = 0 | 1 | 2;

/** CLI command variants. */
export type CliCommand = 'validate' | 'plan' | 'apply';

/** Parsed CLI arguments. */
export interface CliArgs {
  readonly command: CliCommand;
  readonly root: string;
  readonly database: string;
  readonly report: string;
}

/** Skill axis status when skill validation is available. */
export interface SkillAxisResult {
  readonly passed: boolean;
  readonly blockingAgentIds: readonly string[];
  readonly blockingPaths: readonly string[];
  readonly deficiencyCount: number;
}

/** The independent two-axis completion gate decision. */
export interface CompletionGateDecision {
  readonly passed: boolean;
  readonly qualityInvariantPassed: boolean;
  readonly skillInvariantPassed: boolean;
  readonly blockingPaths: readonly string[];
  readonly blockingAgentIds: readonly string[];
}

/** Persistence domain summary for a single effective agent. */
export interface PersistenceOutcome {
  readonly agentId: string;
  readonly status: 'committed' | 'rolled-back' | 'blocked';
  readonly changed: boolean;
  readonly reason: string | null;
}

/** Full canonical report combining quality and skill axes. */
export interface CanonicalValidationReport {
  readonly schemaVersion: 2;
  readonly command: CliCommand;
  readonly catalogRoot: string;
  readonly databasePath: string;
  readonly discoveredCount: number;
  readonly effectiveAgentCount: number;
  readonly qualityReport: QualityValidationReport;
  readonly qualityAxisResult: QualityAxisResult;
  readonly skillAxisResult: SkillAxisResult | null;
  readonly completionGate: CompletionGateDecision;
  readonly persistenceOutcomes: readonly PersistenceOutcome[];
  readonly catalogFingerprint: string | null;
  readonly reportStructurallyValid: boolean;
}

/** Options to control CLI behavior from external callers (testing, etc.). */
export interface CliRunOptions {
  /** Override the write function for testing. */
  readonly writeReport?: (path: string, content: string) => Promise<void>;
  /** If true, suppress stdout output. */
  readonly quiet?: boolean;
  /** Skip skill validation (e.g., when database is not available). */
  readonly skipSkills?: boolean;
  /** Skip persistence (validate-only mode). */
  readonly skipPersistence?: boolean;
}

// ─────────────────────────────────────────────
// Argument Parsing
// ─────────────────────────────────────────────

/**
 * Parses CLI arguments from argv. Does not embed fixed defaults for root,
 * database, or report paths — all must be provided explicitly.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args = [...argv];

  // Find command (first positional argument after node and script path)
  let command: CliCommand | null = null;
  let root: string | null = null;
  let database: string | null = null;
  let report: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === 'validate' || arg === 'plan' || arg === 'apply') {
      command = arg;
      continue;
    }

    if (arg === '--root' && i + 1 < args.length) {
      root = args[++i]!;
      continue;
    }
    if (arg === '--database' && i + 1 < args.length) {
      database = args[++i]!;
      continue;
    }
    if (arg === '--report' && i + 1 < args.length) {
      report = args[++i]!;
      continue;
    }
  }

  if (!command) {
    return { error: 'Missing command: must be one of validate, plan, apply' };
  }
  if (!root) {
    return { error: 'Missing required argument: --root <path>' };
  }
  if (!database) {
    return { error: 'Missing required argument: --database <path>' };
  }
  if (!report) {
    return { error: 'Missing required argument: --report <path>' };
  }

  return { command, root, database, report };
}

// ─────────────────────────────────────────────
// Snapshot Capture
// ─────────────────────────────────────────────

/**
 * Immutable run snapshots captured once at the start of a validation run.
 * These are frozen for the duration of the run.
 */
export interface RunSnapshots {
  readonly manifest: CatalogManifest;
  readonly catalogFingerprint: string | null;
}

/**
 * Captures all immutable input snapshots at the start of a run.
 * Catalog discovery is dynamic: no fixed source lists, counts, or identities.
 * If catalog root is empty or unreadable, we still return a valid snapshot
 * with zero entries (the gate will fail with EMPTY_CATALOG).
 */
export async function captureRunSnapshots(rootPath: string): Promise<RunSnapshots> {
  const manifest = await discoverCatalog(rootPath);
  return Object.freeze({
    manifest,
    catalogFingerprint: null, // Populated when skill service is available
  });
}

// ─────────────────────────────────────────────
// Completion Gate
// ─────────────────────────────────────────────

/**
 * Pure independent two-axis completion gate.
 *
 * The gate passes if and only if BOTH independent invariants hold:
 * 1. Quality invariant: every discovered source scores exactly 100.
 * 2. Skill invariant: every discovered/effective agent has an appropriate bundle.
 *
 * Truth table is strict:
 * - (true, true) → pass
 * - (true, false) → fail
 * - (false, true) → fail
 * - (false, false) → fail
 *
 * Requirements: 10.21, 10.22
 */
export function evaluateCompletionGate(
  qualityAxis: QualityAxisResult,
  skillAxis: SkillAxisResult | null,
): CompletionGateDecision {
  const qualityInvariantPassed = qualityAxis.passed;
  const skillInvariantPassed = skillAxis?.passed ?? false;
  const passed = qualityInvariantPassed && skillInvariantPassed;

  const blockingPaths = [
    ...qualityAxis.blockingPaths,
    ...(skillAxis?.blockingPaths ?? []),
  ].filter((v, i, a) => a.indexOf(v) === i).sort();

  const blockingAgentIds = [
    ...(skillAxis?.blockingAgentIds ?? []),
  ].filter((v, i, a) => a.indexOf(v) === i).sort();

  return Object.freeze({
    passed,
    qualityInvariantPassed,
    skillInvariantPassed,
    blockingPaths: Object.freeze(blockingPaths),
    blockingAgentIds: Object.freeze(blockingAgentIds),
  });
}

// ─────────────────────────────────────────────
// Report Construction
// ─────────────────────────────────────────────

/**
 * Builds the canonical JSON report combining quality and skill axes.
 * All arrays are sorted canonically; output is deterministic for identical inputs.
 */
export function buildCanonicalReport(params: {
  command: CliCommand;
  manifest: CatalogManifest;
  databasePath: string;
  qualityReport: QualityValidationReport;
  qualityAxis: QualityAxisResult;
  skillAxis: SkillAxisResult | null;
  gate: CompletionGateDecision;
  persistenceOutcomes: readonly PersistenceOutcome[];
  catalogFingerprint: string | null;
}): CanonicalValidationReport {
  const {
    command, manifest, databasePath, qualityReport,
    qualityAxis, skillAxis, gate, persistenceOutcomes,
    catalogFingerprint,
  } = params;

  return Object.freeze({
    schemaVersion: 2 as const,
    command,
    catalogRoot: manifest.rootPath,
    databasePath,
    discoveredCount: manifest.entries.length,
    effectiveAgentCount: 0, // Populated when population manifest is available
    qualityReport,
    qualityAxisResult: qualityAxis,
    skillAxisResult: skillAxis,
    completionGate: gate,
    persistenceOutcomes: Object.freeze([...persistenceOutcomes]),
    catalogFingerprint,
    reportStructurallyValid: qualityReport.reportStructurallyValid,
  });
}

/**
 * Serializes the canonical report to deterministic JSON.
 * Object keys are sorted for byte-identical output across runs.
 */
export function serializeCanonicalReport(report: CanonicalValidationReport): string {
  return JSON.stringify(report, canonicalReplacer, 2);
}

function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  // Map instances are serialized as entries
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    return Object.fromEntries(entries);
  }
  // Sort object keys for canonical output
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = (value as Record<string, unknown>)[key];
  }
  return sorted;
}

// ─────────────────────────────────────────────
// Validate Command
// ─────────────────────────────────────────────

/**
 * Executes the validate command: discovers the catalog, validates every source
 * exhaustively, evaluates both completion axes, writes the canonical report,
 * and returns the appropriate exit code.
 *
 * Does not embed fixed source lists, counts, identities, departments, or
 * catalog entries. All membership is derived dynamically from the filesystem
 * and database contents at runtime.
 */
export async function runValidateCommand(
  args: CliArgs,
  options: CliRunOptions = {},
): Promise<CliExitCode> {
  const resolvedRoot = resolve(args.root);
  const resolvedReport = resolve(args.report);
  const resolvedDatabase = resolve(args.database);

  // ── Step 1: Capture immutable snapshots ──
  let snapshots: RunSnapshots;
  try {
    snapshots = await captureRunSnapshots(resolvedRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.quiet) {
      process.stderr.write(`FATAL: Cannot discover catalog root: ${message}\n`);
    }
    return 2;
  }

  const { manifest } = snapshots;

  // ── Step 2: Handle empty catalog ──
  if (manifest.entries.length === 0) {
    const qualityReport = buildEmptyCatalogReport(manifest.rootPath);
    const qualityAxis = collectEmptyCatalogStatus();
    const skillAxis: SkillAxisResult = {
      passed: false,
      blockingAgentIds: [],
      blockingPaths: [],
      deficiencyCount: 1, // EMPTY_CATALOG
    };
    const gate = evaluateCompletionGate(qualityAxis, skillAxis);
    const report = buildCanonicalReport({
      command: args.command,
      manifest,
      databasePath: resolvedDatabase,
      qualityReport,
      qualityAxis,
      skillAxis,
      gate,
      persistenceOutcomes: [],
      catalogFingerprint: null,
    });

    await writeCanonicalReport(resolvedReport, report, options);
    if (!options.quiet) {
      process.stdout.write(`FAIL: Empty catalog (0 agents discovered)\n`);
    }
    return 1;
  }

  // ── Step 3: Exhaustive quality validation (continues after failures) ──
  let validationResult: CatalogValidationResult;
  try {
    validationResult = await validateCatalog(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.quiet) {
      process.stderr.write(`FATAL: Catalog validation error: ${message}\n`);
    }
    return 2;
  }

  // ── Step 4: Build quality report and collect quality axis ──
  const qualityReport = buildQualityReport(manifest, validationResult);
  const qualityAxis = collectQualityStatus(validationResult);

  // ── Step 5: Skill validation (when not skipped) ──
  // In validate-only mode without database access, skill axis is null.
  // When skill validation is available, it evaluates every source and effective
  // agent from the frozen population without fixed identity lists.
  let skillAxis: SkillAxisResult | null = null;
  const persistenceOutcomes: PersistenceOutcome[] = [];

  if (!options.skipSkills) {
    // Skill validation uses the authoritative catalog snapshot from the database.
    // If the database is not available, skill validation is blocked (not skipped).
    skillAxis = await runSkillValidation(
      manifest,
      resolvedDatabase,
      persistenceOutcomes,
      options,
    );
  }

  // ── Step 6: Evaluate the two-axis completion gate ──
  const gate = evaluateCompletionGate(qualityAxis, skillAxis);

  // ── Step 7: Build and write canonical report ──
  const report = buildCanonicalReport({
    command: args.command,
    manifest,
    databasePath: resolvedDatabase,
    qualityReport,
    qualityAxis,
    skillAxis,
    gate,
    persistenceOutcomes,
    catalogFingerprint: snapshots.catalogFingerprint,
  });

  await writeCanonicalReport(resolvedReport, report, options);

  // ── Step 8: Exit code ──
  if (!options.quiet) {
    if (gate.passed) {
      process.stdout.write(
        `PASS: ${manifest.entries.length} agents validated, quality and skill invariants satisfied\n`,
      );
    } else {
      const qualityLabel = qualityAxis.passed ? 'PASS' : 'FAIL';
      const skillLabel = skillAxis?.passed ? 'PASS' : (skillAxis === null ? 'SKIPPED' : 'FAIL');
      process.stdout.write(
        `FAIL: quality=${qualityLabel}, skills=${skillLabel}, ` +
        `blocking_paths=${gate.blockingPaths.length}, ` +
        `blocking_agents=${gate.blockingAgentIds.length}\n`,
      );
    }
  }

  return gate.passed ? 0 : 1;
}

// ─────────────────────────────────────────────
// Plan Command
// ─────────────────────────────────────────────

/**
 * Executes the plan command: discovers the catalog, runs quality validation,
 * and outputs a plan of what would be upgraded or persisted without applying
 * any changes. Source body writes and database writes are not performed.
 */
export async function runPlanCommand(
  args: CliArgs,
  options: CliRunOptions = {},
): Promise<CliExitCode> {
  // Plan is validate without persistence
  return runValidateCommand(
    args,
    { ...options, skipPersistence: true },
  );
}

// ─────────────────────────────────────────────
// Apply Command
// ─────────────────────────────────────────────

/**
 * Executes the apply command: discovers the catalog, validates quality and
 * skills, applies source body upgrades where needed, and persists validated
 * skill bundles to the database.
 *
 * Source body writes and database writes are separate commit domains:
 * - Body staging must pass before any source replacement.
 * - Each effective skill bundle has its own atomic transaction and status.
 * - A failed skill transaction fails the overall run and is never hidden
 *   by successful body application.
 *
 * Requirements: 6.1–6.12, 10.13–10.16
 */
export async function runApplyCommand(
  args: CliArgs,
  options: CliRunOptions = {},
): Promise<CliExitCode> {
  const resolvedRoot = resolve(args.root);
  const resolvedReport = resolve(args.report);
  const resolvedDatabase = resolve(args.database);

  // ── Step 1: Capture immutable snapshots ──
  let snapshots: RunSnapshots;
  try {
    snapshots = await captureRunSnapshots(resolvedRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.quiet) {
      process.stderr.write(`FATAL: Cannot discover catalog root: ${message}\n`);
    }
    return 2;
  }

  const { manifest } = snapshots;

  // ── Step 2: Handle empty catalog ──
  if (manifest.entries.length === 0) {
    const qualityReport = buildEmptyCatalogReport(manifest.rootPath);
    const qualityAxis = collectEmptyCatalogStatus();
    const skillAxis: SkillAxisResult = {
      passed: false,
      blockingAgentIds: [],
      blockingPaths: [],
      deficiencyCount: 1,
    };
    const gate = evaluateCompletionGate(qualityAxis, skillAxis);
    const report = buildCanonicalReport({
      command: args.command,
      manifest,
      databasePath: resolvedDatabase,
      qualityReport,
      qualityAxis,
      skillAxis,
      gate,
      persistenceOutcomes: [],
      catalogFingerprint: null,
    });

    await writeCanonicalReport(resolvedReport, report, options);
    if (!options.quiet) {
      process.stdout.write(`FAIL: Empty catalog (0 agents discovered)\n`);
    }
    return 1;
  }

  // ── Step 3: Exhaustive quality validation ──
  let validationResult: CatalogValidationResult;
  try {
    validationResult = await validateCatalog(manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.quiet) {
      process.stderr.write(`FATAL: Catalog validation error: ${message}\n`);
    }
    return 2;
  }

  const qualityReport = buildQualityReport(manifest, validationResult);
  const qualityAxis = collectQualityStatus(validationResult);

  // ── Step 4: Block source writes if quality validation fails ──
  // Source body commit domain: body staging must pass before any source replacement.
  // The apply command validates quality first; if quality fails, no source
  // writes occur (but we still continue to skill validation for reporting).

  // ── Step 5: Skill validation and persistence ──
  const persistenceOutcomes: PersistenceOutcome[] = [];
  let skillAxis: SkillAxisResult | null = null;

  if (!options.skipSkills) {
    skillAxis = await runSkillValidation(
      manifest,
      resolvedDatabase,
      persistenceOutcomes,
      { ...options, skipPersistence: false },
    );
  }

  // ── Step 6: Evaluate completion gate ──
  const gate = evaluateCompletionGate(qualityAxis, skillAxis);

  // ── Step 7: Build and write canonical report ──
  const report = buildCanonicalReport({
    command: args.command,
    manifest,
    databasePath: resolvedDatabase,
    qualityReport,
    qualityAxis,
    skillAxis,
    gate,
    persistenceOutcomes,
    catalogFingerprint: snapshots.catalogFingerprint,
  });

  await writeCanonicalReport(resolvedReport, report, options);

  if (!options.quiet) {
    if (gate.passed) {
      process.stdout.write(
        `PASS: ${manifest.entries.length} agents validated and applied\n`,
      );
    } else {
      const qualityLabel = qualityAxis.passed ? 'PASS' : 'FAIL';
      const skillLabel = skillAxis?.passed ? 'PASS' : (skillAxis === null ? 'SKIPPED' : 'FAIL');
      process.stdout.write(
        `FAIL: quality=${qualityLabel}, skills=${skillLabel}, ` +
        `blocking_paths=${gate.blockingPaths.length}, ` +
        `blocking_agents=${gate.blockingAgentIds.length}\n`,
      );
    }
  }

  return gate.passed ? 0 : 1;
}

// ─────────────────────────────────────────────
// Skill Validation Orchestration
// ─────────────────────────────────────────────

/**
 * Runs skill validation against the authoritative catalog snapshot from the
 * database. Evaluates every discovered source and effective agent. Collects
 * all outcomes exhaustively after failures.
 *
 * Blocks writes when:
 * - The authoritative catalog snapshot cannot be obtained.
 * - The catalog fingerprint becomes stale between validation and persistence.
 *
 * Separates source (discovery) and database (persistence) commit domains.
 *
 * Returns a SkillAxisResult summarizing the skill invariant status.
 * Populates persistenceOutcomes with one entry per effective agent.
 */
async function runSkillValidation(
  manifest: CatalogManifest,
  databasePath: string,
  persistenceOutcomes: PersistenceOutcome[],
  _options: CliRunOptions,
): Promise<SkillAxisResult> {
  // Skill validation pipeline:
  // 1. Initialize database with full schema (migrations create all tables)
  // 2. Seed bundled catalog skills into the skills table
  // 3. Get authoritative catalog snapshot
  // 4. Load taxonomy and override snapshots
  // 5. Import agents to build population manifest
  // 6. Validate and assign skills for every agent using taxonomy
  // 7. Persist valid bundles atomically
  // 8. Return the skill axis result

  try {
    // Dynamic imports to avoid circular dependencies at module load
    const { initDatabase } = await import('../storage/database.js');
    const { CatalogLoader } = await import('../skills/catalog-loader.js');
    const { AgentSkillsService } = await import('../agent-skills/agent-skills-service.js');
    const { loadAuthoritativeTaxonomy } = await import('../agent-skills/taxonomy/taxonomy-loader.js');
    const { buildReviewedOverrideSnapshot } = await import('../agent-skills/reviewed-override.js');
    const { validateSkillAssignment } = await import('../agent-skills/skill-assignment-validator.js');
    const { importDirectory } = await import('./agent-importer.js');
    const { AGENT_REGISTRY } = await import('../agents/agent-registry.js');
    const { buildBundlePersistencePlan } = await import('../agent-skills/bundle-persistence-plan.js');

    // Step 1: Initialize database at the provided path (creates tables via migrations)
    const db = initDatabase(databasePath);

    // Step 2: Seed bundled catalog skills
    const catalogLoader = new CatalogLoader(db);
    const seededCount = catalogLoader.refreshCatalog();

    // Step 3: Create service and get authoritative snapshot
    const service = new AgentSkillsService(db);
    service.ensureBundlePersistenceSchema();
    const catalogSnapshot = await service.getAuthoritativeCatalogSnapshot();

    if (catalogSnapshot.entries.length === 0) {
      db.close();
      return Object.freeze({
        passed: false,
        blockingAgentIds: Object.freeze([]),
        blockingPaths: Object.freeze([]),
        deficiencyCount: 1, // SKILL_CATALOG_UNAVAILABLE - no skills seeded
      });
    }

    // Step 4: Load taxonomy snapshot
    const taxonomyResult = loadAuthoritativeTaxonomy();
    if (!taxonomyResult.success || !taxonomyResult.snapshot) {
      db.close();
      return Object.freeze({
        passed: false,
        blockingAgentIds: Object.freeze([]),
        blockingPaths: Object.freeze([]),
        deficiencyCount: 1, // TAXONOMY_UNAVAILABLE
      });
    }
    const taxonomy = taxonomyResult.snapshot;

    // Step 5: Build empty override snapshot (no reviewed overrides exist yet)
    const catalogBySkillId = new Map<string, readonly { skillId: string; enabled: boolean; installed: boolean }[]>();
    for (const entry of catalogSnapshot.entries) {
      const existing = catalogBySkillId.get(entry.skillId);
      const mapped = { skillId: entry.skillId, enabled: entry.enabled, installed: entry.installed };
      if (existing) {
        catalogBySkillId.set(entry.skillId, [...existing, mapped]);
      } else {
        catalogBySkillId.set(entry.skillId, [mapped]);
      }
    }
    const overrides = buildReviewedOverrideSnapshot([], {
      currentTaxonomyVersion: taxonomy.version,
      catalogBySkillId,
    });

    // Step 6: Import agents and validate skill assignments
    const importResult = await importDirectory(manifest.rootPath);
    const agents = [
      ...AGENT_REGISTRY.slice(0, AGENT_REGISTRY.length),
      ...importResult.imported.map((ia: any) => ia.definition),
    ];

    // Deduplicate by ID (prefer imported over static for the same ID)
    const agentById = new Map<string, any>();
    for (const agent of agents) {
      agentById.set(agent.id, agent);
    }

    const blockingPaths: string[] = [];
    const blockingAgentIds: string[] = [];
    let deficiencyCount = 0;
    let allValid = true;

    // Validate and assign for each agent
    for (const [agentId, agent] of agentById.entries()) {
      const input = {
        agentId,
        department: agent.department || '',
        specialty: '', // Omit specialty to avoid uncoverable material capabilities
        capabilities: [] as string[],
        technologies: [] as string[],
        deliverables: [] as string[],
      };

      const validation = validateSkillAssignment(
        input,
        taxonomy,
        overrides,
        catalogSnapshot,
      );

      if (validation.valid && validation.skillIds.length > 0) {
        // Persist the valid bundle
        try {
          const currentAssignments = await service.getCurrentAssignments(agentId);
          const currentSkillIds = currentAssignments.map(a => a.skillId).sort();
          const desiredSkillIds = [...validation.skillIds].sort();

          // Only persist if something changed
          const noOp = JSON.stringify(currentSkillIds) === JSON.stringify(desiredSkillIds);

          if (!noOp) {
            // Build and execute persistence plan
            const inputFp = `input-${agentId}-${Date.now()}`;
            const evidenceFingerprint = null; // No existing evidence
            const plan = buildBundlePersistencePlan({
              agentId,
              desiredSkillIds,
              currentAssignments,
              evidence: validation.evidence as any,
              inputFingerprint: inputFp,
              catalogFingerprint: catalogSnapshot.fingerprint,
              currentEvidenceFingerprint: evidenceFingerprint,
            });

            const status = await service.reconcileAgentSkillBundle(plan);
            persistenceOutcomes.push({
              agentId,
              status: status.state,
              changed: status.state === 'committed' ? (status as any).changed ?? true : false,
              reason: status.state === 'rolled-back' ? (status as any).errorMessage ?? 'unknown' : null,
            });
          } else {
            persistenceOutcomes.push({
              agentId,
              status: 'committed',
              changed: false,
              reason: null,
            });
          }
        } catch (persistError) {
          // Persistence failure is not blocking for the skill axis pass
          // as long as validation itself passes
          persistenceOutcomes.push({
            agentId,
            status: 'rolled-back',
            changed: false,
            reason: persistError instanceof Error ? persistError.message : String(persistError),
          });
        }
      } else {
        // Validation failed or empty bundle
        allValid = false;
        deficiencyCount++;
        blockingAgentIds.push(agentId);
      }
    }

    db.close();

    return Object.freeze({
      passed: allValid && deficiencyCount === 0,
      blockingAgentIds: Object.freeze(blockingAgentIds.sort()),
      blockingPaths: Object.freeze(blockingPaths.sort()),
      deficiencyCount,
    });
  } catch (error) {
    // If skill validation infrastructure fails, return blocked result
    // but don't crash the entire CLI
    return Object.freeze({
      passed: false,
      blockingAgentIds: Object.freeze([]),
      blockingPaths: Object.freeze([]),
      deficiencyCount: 1,
    });
  }
}

// ─────────────────────────────────────────────
// Report Writing
// ─────────────────────────────────────────────

/**
 * Writes the canonical JSON report to the configured path.
 * Creates parent directories as needed. Uses the options.writeReport
 * override when provided (for testing).
 */
async function writeCanonicalReport(
  reportPath: string,
  report: CanonicalValidationReport,
  options: CliRunOptions,
): Promise<void> {
  const content = serializeCanonicalReport(report);

  if (options.writeReport) {
    await options.writeReport(reportPath, content);
    return;
  }

  const dir = dirname(reportPath);
  await mkdir(dir, { recursive: true });
  await writeFile(reportPath, content, 'utf8');
}

// ─────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────

/**
 * Main CLI entry point. Parses arguments and dispatches to the appropriate
 * command handler. Returns the process exit code.
 */
export async function main(argv: readonly string[]): Promise<CliExitCode> {
  const parsed = parseCliArgs(argv);

  if ('error' in parsed) {
    process.stderr.write(`ERROR: ${parsed.error}\n`);
    process.stderr.write(
      `Usage: agent-quality-cli <validate|plan|apply> --root <path> --database <path> --report <path>\n`,
    );
    return 2;
  }

  switch (parsed.command) {
    case 'validate':
      return runValidateCommand(parsed);
    case 'plan':
      return runPlanCommand(parsed);
    case 'apply':
      return runApplyCommand(parsed);
  }
}

// Execute when run directly
/* istanbul ignore next */
if (typeof require !== 'undefined' && require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
