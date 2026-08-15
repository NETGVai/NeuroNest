/**
 * DispatchReadinessEvaluator — Evaluates repository freshness for dispatch.
 *
 * Before applying incomplete-or-stale Repository_Map warning or blocking policy
 * to a requested Task dispatch, generates an impact summary (Requirement 29.7).
 *
 * Supports three Quality_Profile modes:
 * - 'warning': permits dispatch with scope/impact warnings
 * - 'block': blocks dispatch when critical dependencies/test files are missing
 * - fail-safe: blocks all dispatch when completeness evaluation fails
 *
 * Requirements: 29.6, 29.7
 */

import type { RepositoryMapService } from './repository-map-service.js';
import type { ImpactAnalyzer } from './impact-analyzer.js';
import type { ImpactAnalysisResult, FreshnessInfo, QueryMethod } from './types.js';
import type { ContextItem } from './impact-analyzer.js';

// ─── Quality Profile Policy ──────────────────────────────────────

export type StaleMapPolicy = 'warning' | 'block';

export interface QualityProfileConfig {
  /** Policy when Repository_Map is incomplete or stale */
  staleMapPolicy: StaleMapPolicy;
  /** Required scope URIs that must be fresh for dispatch */
  requiredScopePatterns: string[];
  /** Critical dependencies that block dispatch if missing */
  criticalDependencyPatterns: string[];
  /** Test file patterns that should be indexed */
  testFilePatterns: string[];
}

// ─── Dispatch Readiness Result ───────────────────────────────────

export type DispatchReadiness = 'ready' | 'warning' | 'blocked' | 'error';

export interface DispatchReadinessResult {
  status: DispatchReadiness;
  impactSummary: ImpactSummary | null;
  diagnostics: DispatchDiagnostic[];
  freshness: FreshnessInfo;
  workspaceRevision: string;
}

export interface ImpactSummary {
  likelyFiles: string[];
  dependents: string[];
  tests: string[];
  contracts: string[];
  migrations: string[];
  configuration: string[];
  operationalRisks: string[];
  methods: QueryMethod[];
  timestamp: number;
}

export interface DispatchDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  affectedUris?: string[];
}

// ─── Evaluator ───────────────────────────────────────────────────

export class DispatchReadinessEvaluator {
  private repoMap: RepositoryMapService;
  private impactAnalyzer: ImpactAnalyzer;
  private config: QualityProfileConfig;

  constructor(
    repoMap: RepositoryMapService,
    impactAnalyzer: ImpactAnalyzer,
    config: QualityProfileConfig,
  ) {
    this.repoMap = repoMap;
    this.impactAnalyzer = impactAnalyzer;
    this.config = config;
  }

  /**
   * Evaluates whether a Task dispatch should proceed given repository freshness.
   *
   * Always generates an impact summary BEFORE applying stale-map policy (Req 29.7).
   */
  evaluate(
    taskFileUris: string[],
    contextItems?: ContextItem[],
  ): DispatchReadinessResult {
    const freshness = this.repoMap.getFreshness();
    const workspaceRevision = this.repoMap.getWorkspaceRevision();
    const diagnostics: DispatchDiagnostic[] = [];

    // Generate impact summary first (Requirement 29.6 & 29.7)
    let impactSummary: ImpactSummary | null = null;
    let impactResult: ImpactAnalysisResult;

    try {
      impactResult = this.impactAnalyzer.analyzeImpact(taskFileUris, { contextItems });
      impactSummary = this.buildImpactSummary(impactResult);
    } catch (err: unknown) {
      // Fail-safe: block all dispatch when completeness evaluation fails
      const message = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        code: 'REPO_MAP_EVALUATION_FAILURE',
        severity: 'error',
        message: `Completeness evaluation failed: ${message}. All dispatch blocked until evaluation succeeds.`,
      });
      return {
        status: 'error',
        impactSummary: null,
        diagnostics,
        freshness,
        workspaceRevision,
      };
    }

    // Check required scope freshness
    const staleInScope = this.findStaleInScope(freshness.staleUris);
    if (staleInScope.length > 0) {
      diagnostics.push({
        code: 'REPO_MAP_STALE_SCOPE',
        severity: this.config.staleMapPolicy === 'block' ? 'error' : 'warning',
        message: `Repository map is stale for ${staleInScope.length} file(s) in required scope.`,
        affectedUris: staleInScope,
      });
    }

    // Check critical dependencies are indexed
    const missingCritical = this.findMissingCriticalDependencies(impactSummary);
    if (missingCritical.length > 0) {
      diagnostics.push({
        code: 'REPO_MAP_MISSING_CRITICAL',
        severity: this.config.staleMapPolicy === 'block' ? 'error' : 'warning',
        message: `Critical dependencies or test files missing from map: ${missingCritical.join(', ')}`,
        affectedUris: missingCritical,
      });
    }

    // Check test file coverage
    const missingTests = this.findMissingTestFiles(impactSummary);
    if (missingTests.length > 0) {
      diagnostics.push({
        code: 'REPO_MAP_MISSING_TESTS',
        severity: this.config.staleMapPolicy === 'block' ? 'error' : 'warning',
        message: `Test files not indexed: ${missingTests.length} pattern(s) uncovered.`,
        affectedUris: missingTests,
      });
    }

    // Determine status based on policy
    const hasErrors = diagnostics.some((d) => d.severity === 'error');
    const hasWarnings = diagnostics.some((d) => d.severity === 'warning');

    let status: DispatchReadiness;
    if (hasErrors) {
      status = 'blocked';
    } else if (hasWarnings) {
      status = 'warning';
    } else {
      status = 'ready';
    }

    return {
      status,
      impactSummary,
      diagnostics,
      freshness,
      workspaceRevision,
    };
  }

  // ── Private Methods ─────────────────────────────────────────────

  private buildImpactSummary(result: ImpactAnalysisResult): ImpactSummary {
    const snapshot = this.repoMap.getSnapshot();
    const affectedUris = result.affectedEntities.map((e) => e.uri);

    const likelyFiles = affectedUris;
    const dependents = result.affectedEntities
      .filter((e) => e.method === 'dependency-traversal')
      .map((e) => e.uri);
    const tests = affectedUris.filter(
      (uri) => uri.includes('.test.') || uri.includes('.spec.') || uri.includes('__tests__'),
    );
    const contracts = snapshot.apiContracts
      .filter((c) => affectedUris.includes(c.uri))
      .map((c) => c.uri);
    const migrations = snapshot.migrations
      .filter((m) => affectedUris.includes(m.uri))
      .map((m) => m.uri);
    const configuration = [
      ...snapshot.buildConfigs.filter((c) => affectedUris.includes(c.uri)).map((c) => c.uri),
      ...snapshot.testConfigs.filter((c) => affectedUris.includes(c.uri)).map((c) => c.uri),
    ];
    const operationalRisks = this.assessOperationalRisks(affectedUris, snapshot);

    return {
      likelyFiles,
      dependents,
      tests,
      contracts,
      migrations,
      configuration,
      operationalRisks,
      methods: result.methods,
      timestamp: result.timestamp,
    };
  }

  private assessOperationalRisks(
    affectedUris: string[],
    snapshot: ReturnType<RepositoryMapService['getSnapshot']>,
  ): string[] {
    const risks: string[] = [];

    // Check if migrations are affected
    const affectedMigrations = snapshot.migrations.filter((m) => affectedUris.includes(m.uri));
    if (affectedMigrations.length > 0) {
      risks.push(`${affectedMigrations.length} migration(s) affected — database changes may be required`);
    }

    // Check if API contracts are affected
    const affectedContracts = snapshot.apiContracts.filter((c) => affectedUris.includes(c.uri));
    if (affectedContracts.length > 0) {
      risks.push(`${affectedContracts.length} API contract(s) affected — breaking changes possible`);
    }

    // Check if build configs are affected
    const affectedBuilds = snapshot.buildConfigs.filter((c) => affectedUris.includes(c.uri));
    if (affectedBuilds.length > 0) {
      risks.push(`${affectedBuilds.length} build configuration(s) affected`);
    }

    return risks;
  }

  private findStaleInScope(staleUris: string[]): string[] {
    if (this.config.requiredScopePatterns.length === 0) return [];

    return staleUris.filter((uri) =>
      this.config.requiredScopePatterns.some((pattern) => this.matchesPattern(uri, pattern)),
    );
  }

  private findMissingCriticalDependencies(summary: ImpactSummary): string[] {
    if (this.config.criticalDependencyPatterns.length === 0) return [];

    const snapshot = this.repoMap.getSnapshot();
    const indexedUris = new Set(snapshot.files.keys());
    const missing: string[] = [];

    for (const pattern of this.config.criticalDependencyPatterns) {
      // Check if any indexed file matches this pattern
      const hasMatch = [...indexedUris].some((uri) => this.matchesPattern(uri, pattern));
      if (!hasMatch) {
        missing.push(pattern);
      }
    }

    return missing;
  }

  private findMissingTestFiles(summary: ImpactSummary): string[] {
    if (this.config.testFilePatterns.length === 0) return [];

    const snapshot = this.repoMap.getSnapshot();
    const indexedUris = new Set(snapshot.files.keys());
    const missing: string[] = [];

    for (const pattern of this.config.testFilePatterns) {
      const hasMatch = [...indexedUris].some((uri) => this.matchesPattern(uri, pattern));
      if (!hasMatch) {
        missing.push(pattern);
      }
    }

    return missing;
  }

  /**
   * Simple glob-like pattern matching.
   * Supports: '*' (any chars), '**' (any path segment)
   */
  private matchesPattern(uri: string, pattern: string): boolean {
    if (pattern === '*' || pattern === '**') return true;

    // Convert simple glob to regex
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<GLOBSTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<GLOBSTAR>>/g, '.*');

    const regex = new RegExp(`^${escaped}$`);
    return regex.test(uri);
  }
}
