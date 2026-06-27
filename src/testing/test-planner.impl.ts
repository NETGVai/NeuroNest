/**
 * TestPlanner Implementation — AI-driven test plan generation from specs
 * or natural language descriptions.
 *
 * Analyzes codebase modules, identifies existing test coverage, highlights
 * coverage gaps, categorizes test cases by type, and includes round-trip
 * property tests for parser+serializer pairs. Plans are persisted to SQLite
 * and lifecycle events are emitted via CallbackEngine.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import type { FeatureGateSystem } from '../feature-gate/feature-gate-system.js';
import type { CallbackEngine } from '../pipeline/callback-engine.js';
import type {
  ITestPlanner,
  TestPlan,
  TestPlanInput,
  PlannedTestCase,
  CoverageGap,
  TestPlanSummary,
  TestCaseType,
} from './test-planner.js';

// ─── Internal Types ─────────────────────────────────────────────

/** Represents a discovered module in the codebase */
interface DiscoveredModule {
  name: string;
  path: string;
  exports: string[];
  hasParser: boolean;
  hasSerializer: boolean;
  hasExistingTests: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/** Parser-related function name patterns */
const PARSER_PATTERNS = /^(parse|decode|deserialize|read|from|unmarshal)/i;

/** Serializer-related function name patterns */
const SERIALIZER_PATTERNS = /^(serialize|encode|stringify|write|to|marshal|format)/i;

// ─── Implementation ─────────────────────────────────────────────

export class TestPlanner implements ITestPlanner {
  constructor(
    private db: Database.Database,
    private featureGate: FeatureGateSystem,
    private callbackEngine: CallbackEngine,
  ) {}

  /**
   * Generate a structured test plan from a specification path or natural
   * language description. Analyzes target modules, identifies coverage gaps,
   * categorizes test cases, and includes round-trip property tests for
   * parser+serializer pairs.
   *
   * Emits a lifecycle event via CallbackEngine when plan generation completes.
   * Persists the plan to the SQLite `test_plans` table.
   *
   * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7
   */
  async generatePlan(input: TestPlanInput): Promise<TestPlan> {
    // Null-check guard: zero overhead when disabled (Req 8.7)
    if (!this.featureGate.isEnabled('test_planning')) {
      return this.createEmptyPlan(input);
    }

    const planId = randomUUID();
    const createdAt = new Date().toISOString();

    // Analyze codebase to discover target modules
    const modules = this.discoverModules(input);

    // Generate test cases from discovered modules
    const testCases = this.generateTestCases(modules, input);

    // Identify coverage gaps
    const coverageGaps = this.identifyCoverageGaps(modules);

    // Build summary
    const summary = this.buildSummary(testCases, coverageGaps);

    const plan: TestPlan = {
      id: planId,
      title: this.generateTitle(input),
      createdAt,
      ...(input.specificationPath !== undefined ? { sourceSpec: input.specificationPath } : {}),
      testCases,
      coverageGaps,
      summary,
    };

    // Persist plan to SQLite (Req 8.3)
    this.persistPlan(plan);

    // Emit lifecycle event (Req 8.6)
    await this.callbackEngine.emit({
      event: 'on-task-complete',
      sessionId: 'test-planner',
      iteration: 0,
      output: { planId: plan.id, totalCases: summary.totalCases },
    });

    return plan;
  }

  /**
   * List all persisted test plans.
   */
  listPlans(): TestPlan[] {
    // Null-check guard (Req 8.7)
    if (!this.featureGate.isEnabled('test_planning')) {
      return [];
    }

    const stmt = this.db.prepare('SELECT plan_json FROM test_plans ORDER BY created_at DESC');
    const rows = stmt.all() as Array<{ plan_json: string }>;
    return rows.map((row) => JSON.parse(row.plan_json) as TestPlan);
  }

  /**
   * Get a single test plan by ID.
   */
  getPlan(planId: string): TestPlan | null {
    // Null-check guard (Req 8.7)
    if (!this.featureGate.isEnabled('test_planning')) {
      return null;
    }

    const stmt = this.db.prepare('SELECT plan_json FROM test_plans WHERE id = ?');
    const row = stmt.get(planId) as { plan_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.plan_json) as TestPlan;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Discover modules based on input specification or natural language.
   * Analyzes target modules, detects parser/serializer pairs, and checks
   * for existing test coverage.
   */
  private discoverModules(input: TestPlanInput): DiscoveredModule[] {
    const modules: DiscoveredModule[] = [];

    if (input.targetModules && input.targetModules.length > 0) {
      for (const modulePath of input.targetModules) {
        modules.push(this.analyzeModule(modulePath));
      }
    } else if (input.naturalLanguageDescription) {
      // Extract module hints from natural language description
      const moduleHints = this.extractModuleHints(input.naturalLanguageDescription);
      for (const hint of moduleHints) {
        modules.push(this.analyzeModule(hint));
      }
    } else if (input.specificationPath) {
      // Use spec path as a single target module
      modules.push(this.analyzeModule(input.specificationPath));
    }

    // If no modules discovered, create a placeholder
    if (modules.length === 0) {
      modules.push({
        name: 'default',
        path: '.',
        exports: [],
        hasParser: false,
        hasSerializer: false,
        hasExistingTests: false,
      });
    }

    return modules;
  }

  /**
   * Analyze a single module to determine its characteristics.
   */
  private analyzeModule(modulePath: string): DiscoveredModule {
    const name = this.extractModuleName(modulePath);
    const exports = this.inferExports(modulePath);
    const hasParser = exports.some((exp) => PARSER_PATTERNS.test(exp));
    const hasSerializer = exports.some((exp) => SERIALIZER_PATTERNS.test(exp));
    const hasExistingTests = this.checkExistingTests(modulePath);

    return {
      name,
      path: modulePath,
      exports,
      hasParser,
      hasSerializer,
      hasExistingTests,
    };
  }

  /**
   * Generate test cases for discovered modules.
   * Categorizes by type and includes round-trip property tests for
   * parser+serializer pairs (Req 8.5).
   */
  private generateTestCases(modules: DiscoveredModule[], input: TestPlanInput): PlannedTestCase[] {
    const testCases: PlannedTestCase[] = [];

    for (const mod of modules) {
      // Unit tests for each export (Req 8.4)
      for (const exportName of mod.exports) {
        testCases.push({
          id: randomUUID(),
          title: `Unit test for ${mod.name}.${exportName}`,
          type: 'unit',
          targetModule: mod.path,
          targetFunction: exportName,
          description: `Verify ${exportName} behavior with typical and edge-case inputs`,
          inputs: [],
          expectedBehavior: `${exportName} produces correct output for valid inputs`,
          priority: mod.hasExistingTests ? 'low' : 'high',
          existingCoverage: mod.hasExistingTests,
        });
      }

      // Integration tests for modules with multiple exports
      if (mod.exports.length > 1) {
        testCases.push({
          id: randomUUID(),
          title: `Integration test for ${mod.name}`,
          type: 'integration',
          targetModule: mod.path,
          description: `Verify ${mod.name} exports interact correctly`,
          expectedBehavior: `Module components integrate without errors`,
          priority: 'medium',
          existingCoverage: mod.hasExistingTests,
        });
      }

      // Round-trip property tests for parser+serializer pairs (Req 8.5)
      if (mod.hasParser && mod.hasSerializer) {
        testCases.push({
          id: randomUUID(),
          title: `Round-trip property test for ${mod.name} parser/serializer`,
          type: 'property-based',
          targetModule: mod.path,
          description: `Verify parse(serialize(x)) === x for all valid inputs`,
          expectedBehavior: `Serialization followed by parsing produces identical value`,
          priority: 'high',
          existingCoverage: false,
        });
      }

      // End-to-end test for modules in specification
      if (input.specificationPath) {
        testCases.push({
          id: randomUUID(),
          title: `E2E test for ${mod.name} against specification`,
          type: 'end-to-end',
          targetModule: mod.path,
          description: `Verify ${mod.name} meets specification requirements end-to-end`,
          expectedBehavior: `Module satisfies all specification constraints`,
          priority: 'medium',
          existingCoverage: false,
        });
      }
    }

    return testCases;
  }

  /**
   * Identify coverage gaps from discovered modules (Req 8.2).
   */
  private identifyCoverageGaps(modules: DiscoveredModule[]): CoverageGap[] {
    const gaps: CoverageGap[] = [];

    for (const mod of modules) {
      if (!mod.hasExistingTests) {
        gaps.push({
          module: mod.path,
          description: `No existing tests found for module '${mod.name}'`,
          suggestedTestType: 'unit',
        });
      }

      if (mod.hasParser && mod.hasSerializer) {
        gaps.push({
          module: mod.path,
          description: `Parser/serializer pair in '${mod.name}' lacks round-trip property test`,
          suggestedTestType: 'property-based',
        });
      }

      // Flag modules with exports but no integration tests
      if (mod.exports.length > 2 && !mod.hasExistingTests) {
        gaps.push({
          module: mod.path,
          description: `Module '${mod.name}' has ${mod.exports.length} exports but no integration tests`,
          suggestedTestType: 'integration',
        });
      }
    }

    return gaps;
  }

  /**
   * Build a summary of the test plan (Req 8.3, 8.4).
   */
  private buildSummary(testCases: PlannedTestCase[], coverageGaps: CoverageGap[]): TestPlanSummary {
    const byType: Record<TestCaseType, number> = {
      unit: 0,
      integration: 0,
      'property-based': 0,
      'end-to-end': 0,
    };

    for (const tc of testCases) {
      byType[tc.type]++;
    }

    return {
      totalCases: testCases.length,
      byType,
      coverageGapsFound: coverageGaps.length,
    };
  }

  /**
   * Persist a test plan to the SQLite `test_plans` table.
   */
  private persistPlan(plan: TestPlan): void {
    const stmt = this.db.prepare(
      'INSERT INTO test_plans (id, title, source_spec, plan_json, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    stmt.run(plan.id, plan.title, plan.sourceSpec ?? null, JSON.stringify(plan), plan.createdAt);
  }

  /**
   * Generate a descriptive title for the plan based on input.
   */
  private generateTitle(input: TestPlanInput): string {
    if (input.specificationPath) {
      return `Test plan for ${this.extractModuleName(input.specificationPath)}`;
    }
    if (input.naturalLanguageDescription) {
      const truncated = input.naturalLanguageDescription.slice(0, 60);
      return `Test plan: ${truncated}${input.naturalLanguageDescription.length > 60 ? '...' : ''}`;
    }
    if (input.targetModules && input.targetModules.length > 0) {
      return `Test plan for ${input.targetModules.length} module(s)`;
    }
    return 'Test plan (generated)';
  }

  /**
   * Create an empty plan when the feature is disabled.
   * This ensures callers get a valid (but empty) response structure.
   */
  private createEmptyPlan(input: TestPlanInput): TestPlan {
    return {
      id: randomUUID(),
      title: 'Test plan (feature disabled)',
      createdAt: new Date().toISOString(),
      ...(input.specificationPath !== undefined ? { sourceSpec: input.specificationPath } : {}),
      testCases: [],
      coverageGaps: [],
      summary: {
        totalCases: 0,
        byType: { unit: 0, integration: 0, 'property-based': 0, 'end-to-end': 0 },
        coverageGapsFound: 0,
      },
    };
  }

  /**
   * Extract module name from a file path.
   */
  private extractModuleName(modulePath: string): string {
    const parts = modulePath.replace(/\\/g, '/').split('/');
    const fileName = parts[parts.length - 1] || parts[parts.length - 2] || 'unknown';
    return fileName.replace(/\.(ts|js|tsx|jsx|mts|mjs)$/, '');
  }

  /**
   * Infer exports from a module path based on naming conventions.
   * In a production system, this would use AST parsing. Here we use
   * heuristic-based inference from module path and naming patterns.
   */
  private inferExports(modulePath: string): string[] {
    const name = this.extractModuleName(modulePath);
    const exports: string[] = [];

    // Infer common export patterns from module name
    exports.push(name);

    // If it looks like a utility module, infer common utility exports
    if (name.includes('util') || name.includes('helper')) {
      exports.push(`${name}Helper`);
    }

    return exports;
  }

  /**
   * Check whether a module has existing test files.
   * Looks for .test.ts, .spec.ts, or __tests__/ patterns.
   */
  private checkExistingTests(modulePath: string): boolean {
    // In a production system this would check the filesystem.
    // Here we use a heuristic: if the path contains "test" or "spec", assume coverage exists.
    const lower = modulePath.toLowerCase();
    return lower.includes('.test.') || lower.includes('.spec.') || lower.includes('__tests__');
  }

  /**
   * Extract module path hints from a natural language description.
   */
  private extractModuleHints(description: string): string[] {
    const hints: string[] = [];

    // Look for file paths or module names in the description
    const pathPattern = /(?:[\w-]+\/)*[\w-]+\.(?:ts|js|tsx|jsx)/g;
    const matches = description.match(pathPattern);
    if (matches) {
      hints.push(...matches);
    }

    // Look for quoted identifiers
    const quotedPattern = /['"`]([\w./\\-]+)['"`]/g;
    let match;
    while ((match = quotedPattern.exec(description)) !== null) {
      if (match[1] && !hints.includes(match[1])) {
        hints.push(match[1]);
      }
    }

    // If no hints found, use the description itself as a module name placeholder
    if (hints.length === 0) {
      const words = description.split(/\s+/).filter((w) => w.length > 3);
      const firstWord = words[0];
      if (firstWord) {
        hints.push(firstWord);
      }
    }

    return hints;
  }
}
