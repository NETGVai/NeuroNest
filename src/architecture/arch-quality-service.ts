/**
 * Architectural Quality Service — real-time structural health analysis.
 *
 * Computes a continuous quality signal (0–10,000) from 5 root-cause metrics:
 * modularity, acyclicity, depth, equality, redundancy.
 * Includes quality gate, rules engine, evolution tracking, DSM, test gaps,
 * and bloat scoring dimension (Requirement 7).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OverEngineeringReview } from '../pipeline/over-engineering-review';
import type { BloatFinding } from '../pipeline/over-engineering-review';

// ── Types ──────────────────────────────────────────────────────

export interface ArchQualityScore {
  id: string; projectId: string; overallScore: number;
  modularity: number; acyclicity: number; depthScore: number;
  equality: number; redundancy: number;
  fileCount: number; dependencyCount: number; cycleCount: number;
  godFiles: string[]; couplingGrade: string;
  details: Record<string, unknown>; scannedAt: string;
}

export interface QualityGate {
  id: string; projectId: string; sessionId?: string;
  baselineScore: number; baselineSnapshot: Record<string, unknown>;
  finalScore?: number; finalSnapshot?: Record<string, unknown>;
  passed?: boolean; degradationSummary?: string;
  startedAt: string; completedAt?: string;
}

export interface ArchRule {
  id: string; projectId: string; ruleType: string;
  config: Record<string, unknown>; enabled: boolean;
}

export interface TestGap {
  filePath: string; hasTests: boolean; testFile?: string; gapReason?: string;
}

export interface DSMEntry {
  from: string; to: string; weight: number;
}

/**
 * Bloat scoring dimension result.
 *
 * Additive quality dimension that evaluates the repository for over-engineering
 * patterns without modifying existing scoring logic.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */
export interface BloatScore {
  /** All bloat findings detected, ranked by netLineReduction descending */
  findings: BloatFinding[];
  /** Total estimated lines removable (sum of all netLineReduction values) */
  totalLinesRemovable: number;
  /** Counts of findings by category */
  categories: {
    reinventedStdlib: number;
    redundantDeps: number;
    singleImplAbstractions: number;
  };
}

/**
 * Accessibility friction entry logged when the GUI_Agent fails to interact
 * with a DOM element due to poor labeling, missing ARIA roles, or non-semantic markup.
 * General failures (network errors, timing issues) do NOT produce these entries.
 *
 * Requirements: 15.4, 15.5
 */
export interface AccessibilityFrictionEntry {
  /** CSS selector identifying the problematic element */
  elementSelector: string;
  /** The specific accessibility issue detected */
  issue: 'missing-label' | 'no-aria-role' | 'non-semantic-markup';
  /** Operability friction score (0–1, where 1 = completely inoperable) */
  operabilityScore: number;
  /** ISO 8601 timestamp when the friction was logged */
  timestamp: string;
}

// ── Service ────────────────────────────────────────────────────

export class ArchQualityService {
  constructor(private db: Database.Database) {}

  // ── Scan & Score ──

  scan(projectId: string, projectPath: string): ArchQualityScore {
    const files = this.discoverFiles(projectPath);
    const deps = this.extractDependencies(projectPath, files);
    const cycles = this.detectCycles(deps);
    const godFiles = this.detectGodFiles(files, deps);

    // Compute 5 root-cause metrics (each 0–2000, total 0–10000)
    const modularity = this.computeModularity(files, deps);
    const acyclicity = cycles.length === 0 ? 2000 : Math.max(0, 2000 - cycles.length * 200);
    const depthScore = this.computeDepth(deps);
    const equality = this.computeEquality(files, deps);
    const redundancy = this.computeRedundancy(files);
    const overallScore = modularity + acyclicity + depthScore + equality + redundancy;

    const couplingGrade = overallScore >= 8000 ? 'A' : overallScore >= 6000 ? 'B' : overallScore >= 4000 ? 'C' : overallScore >= 2000 ? 'D' : 'F';

    const id = randomUUID();
    const now = new Date().toISOString();
    const details = { files: files.length, deps: deps.length, cycles: cycles.length, godFiles };

    this.db.prepare(
      'INSERT INTO arch_quality_scores (id, project_id, overall_score, modularity, acyclicity, depth_score, equality, redundancy, file_count, dependency_count, cycle_count, god_files, coupling_grade, details, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, projectId, overallScore, modularity, acyclicity, depthScore, equality, redundancy, files.length, deps.length, cycles.length, JSON.stringify(godFiles), couplingGrade, JSON.stringify(details), now);

    // Record evolution point
    this.db.prepare('INSERT INTO arch_evolution (id, project_id, score, modularity, acyclicity, file_count, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), projectId, overallScore, modularity, acyclicity, files.length, now);

    return { id, projectId, overallScore, modularity, acyclicity, depthScore, equality, redundancy, fileCount: files.length, dependencyCount: deps.length, cycleCount: cycles.length, godFiles, couplingGrade, details, scannedAt: now };
  }

  getLatest(projectId: string): ArchQualityScore | null {
    const r = this.db.prepare('SELECT * FROM arch_quality_scores WHERE project_id = ? ORDER BY scanned_at DESC LIMIT 1').get(projectId) as any;
    return r ? this.mapScore(r) : null;
  }

  // ── Quality Gate ──

  gateStart(projectId: string, sessionId?: string): QualityGate {
    const latest = this.getLatest(projectId);
    const baselineScore = latest?.overallScore || 0;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO quality_gates (id, project_id, session_id, baseline_score, baseline_snapshot, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, sessionId || null, baselineScore, JSON.stringify(latest || {}), now);
    return { id, projectId, sessionId, baselineScore, baselineSnapshot: (latest || {}) as any, startedAt: now };
  }

  gateEnd(gateId: string, projectId: string, projectPath: string): QualityGate {
    const after = this.scan(projectId, projectPath);
    const gate = this.db.prepare('SELECT * FROM quality_gates WHERE id = ?').get(gateId) as any;
    if (!gate) throw new Error('Gate not found');

    const passed = after.overallScore >= gate.baseline_score;
    const diff = after.overallScore - gate.baseline_score;
    const summary = passed
      ? 'Quality maintained or improved (' + (diff >= 0 ? '+' : '') + diff + ')'
      : 'Quality degraded by ' + Math.abs(diff) + ' points. Bottleneck: ' + this.identifyBottleneck(after);

    this.db.prepare('UPDATE quality_gates SET final_score = ?, final_snapshot = ?, passed = ?, degradation_summary = ?, completed_at = ? WHERE id = ?')
      .run(after.overallScore, JSON.stringify(after), passed ? 1 : 0, summary, new Date().toISOString(), gateId);

    return { id: gateId, projectId, baselineScore: gate.baseline_score, baselineSnapshot: JSON.parse(gate.baseline_snapshot), finalScore: after.overallScore, finalSnapshot: after as any, passed, degradationSummary: summary, startedAt: gate.started_at, completedAt: new Date().toISOString() };
  }

  getGateHistory(projectId: string): QualityGate[] {
    return (this.db.prepare('SELECT * FROM quality_gates WHERE project_id = ? ORDER BY started_at DESC LIMIT 20').all(projectId) as any[])
      .map(r => ({ id: r.id, projectId: r.project_id, sessionId: r.session_id || undefined, baselineScore: r.baseline_score, baselineSnapshot: JSON.parse(r.baseline_snapshot), finalScore: r.final_score, finalSnapshot: r.final_snapshot ? JSON.parse(r.final_snapshot) : undefined, passed: r.passed === 1, degradationSummary: r.degradation_summary || undefined, startedAt: r.started_at, completedAt: r.completed_at || undefined }));
  }

  // ── Rules Engine ──

  addRule(projectId: string, ruleType: string, config: Record<string, unknown>): ArchRule {
    const id = randomUUID();
    this.db.prepare('INSERT INTO arch_rules (id, project_id, rule_type, config, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)')
      .run(id, projectId, ruleType, JSON.stringify(config), new Date().toISOString());
    return { id, projectId, ruleType, config, enabled: true };
  }

  getRules(projectId: string): ArchRule[] {
    return (this.db.prepare('SELECT * FROM arch_rules WHERE project_id = ? ORDER BY created_at ASC').all(projectId) as any[])
      .map(r => ({ id: r.id, projectId: r.project_id, ruleType: r.rule_type, config: JSON.parse(r.config), enabled: r.enabled === 1 }));
  }

  toggleRule(ruleId: string, enabled: boolean): boolean {
    return this.db.prepare('UPDATE arch_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, ruleId).changes > 0;
  }

  deleteRule(ruleId: string): boolean {
    return this.db.prepare('DELETE FROM arch_rules WHERE id = ?').run(ruleId).changes > 0;
  }

  checkRules(projectId: string): { passed: boolean; results: { rule: string; passed: boolean; message: string }[] } {
    const rules = this.getRules(projectId).filter(r => r.enabled);
    const latest = this.getLatest(projectId);
    if (!latest) return { passed: true, results: [] };

    const results: { rule: string; passed: boolean; message: string }[] = [];
    for (const rule of rules) {
      const result = this.evaluateRule(rule, latest);
      results.push(result);
    }
    return { passed: results.every(r => r.passed), results };
  }

  // ── Evolution ──

  getEvolution(projectId: string, limit?: number): { score: number; modularity: number; acyclicity: number; fileCount: number; recordedAt: string }[] {
    return (this.db.prepare('SELECT * FROM arch_evolution WHERE project_id = ? ORDER BY recorded_at DESC LIMIT ?').all(projectId, limit || 50) as any[])
      .map(r => ({ score: r.score, modularity: r.modularity, acyclicity: r.acyclicity, fileCount: r.file_count, recordedAt: r.recorded_at })).reverse();
  }

  // ── DSM ──

  getDSM(projectId: string, projectPath: string): DSMEntry[] {
    const files = this.discoverFiles(projectPath);
    const deps = this.extractDependencies(projectPath, files);
    return deps;
  }

  // ── Test Gaps ──

  scanTestGaps(projectId: string, projectPath: string): TestGap[] {
    const files = this.discoverFiles(projectPath);
    const gaps: TestGap[] = [];

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (['.test.ts', '.test.js', '.spec.ts', '.spec.js', '.test.py', '_test.go'].some(t => file.includes(t))) continue;
      if (!['.ts', '.js', '.py', '.go', '.rs', '.java'].includes(ext)) continue;

      const baseName = path.basename(file, ext);
      const dir = path.dirname(file);
      const testPatterns = [
        path.join(dir, baseName + '.test' + ext),
        path.join(dir, '__tests__', baseName + '.test' + ext),
        path.join(projectPath, 'tests', path.relative(projectPath, file).replace(ext, '.test' + ext)),
      ];

      const hasTest = testPatterns.some(p => fs.existsSync(p));
      const testFile = testPatterns.find(p => fs.existsSync(p));

      gaps.push({ filePath: path.relative(projectPath, file), hasTests: hasTest, testFile: testFile ? path.relative(projectPath, testFile) : undefined, gapReason: hasTest ? undefined : 'No test file found' });

      this.db.prepare('INSERT OR REPLACE INTO test_gaps (id, project_id, file_path, has_tests, test_file, gap_reason, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), projectId, path.relative(projectPath, file), hasTest ? 1 : 0, testFile ? path.relative(projectPath, testFile) : null, hasTest ? null : 'No test file found', new Date().toISOString());
    }

    return gaps;
  }

  getTestGaps(projectId: string): TestGap[] {
    return (this.db.prepare('SELECT * FROM test_gaps WHERE project_id = ? AND has_tests = 0 ORDER BY file_path ASC').all(projectId) as any[])
      .map(r => ({ filePath: r.file_path, hasTests: r.has_tests === 1, testFile: r.test_file || undefined, gapReason: r.gap_reason || undefined }));
  }

  // ── Accessibility Friction (Requirements 15.4, 15.5) ──

  /**
   * Log an accessibility friction entry when the GUI_Agent fails due to
   * poor labeling, missing ARIA roles, or non-semantic markup.
   *
   * General failures (network errors, timing issues) should NOT be logged here.
   * Only accessibility-specific issues produce entries.
   */
  logAccessibilityFriction(projectId: string, entry: AccessibilityFrictionEntry): void {
    this.db.prepare(
      'INSERT INTO accessibility_friction (id, project_id, element_selector, issue, operability_score, logged_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(randomUUID(), projectId, entry.elementSelector, entry.issue, entry.operabilityScore, entry.timestamp);
  }

  /**
   * Retrieve all accessibility friction entries for a project.
   * Entries are ordered by timestamp descending (most recent first).
   */
  getAccessibilityFriction(projectId: string): AccessibilityFrictionEntry[] {
    return (this.db.prepare(
      'SELECT * FROM accessibility_friction WHERE project_id = ? ORDER BY logged_at DESC'
    ).all(projectId) as any[]).map(r => ({
      elementSelector: r.element_selector,
      issue: r.issue as AccessibilityFrictionEntry['issue'],
      operabilityScore: r.operability_score,
      timestamp: r.logged_at,
    }));
  }

  /**
   * Compute the overall accessibility score from friction entries.
   * Returns a value 0–100 where 100 = no accessibility issues found.
   * Uses a decaying penalty: more entries and higher operability scores reduce the total.
   */
  computeAccessibilityScore(projectId: string): number {
    const entries = this.getAccessibilityFriction(projectId);
    if (entries.length === 0) return 100;

    // Sum up friction: each entry penalizes based on operabilityScore
    const totalFriction = entries.reduce((sum, e) => sum + e.operabilityScore, 0);
    // Cap penalty: each entry with full friction removes 5 points, min score is 0
    const penalty = Math.min(100, totalFriction * 5);
    return Math.max(0, Math.round(100 - penalty));
  }

  // ── Private Helpers ──

  private discoverFiles(projectPath: string): string[] {
    const files: string[] = [];
    const codeExts = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.kt']);
    const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', 'vendor', 'target']);

    const walk = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !skipDirs.has(entry.name)) walk(path.join(dir, entry.name));
          else if (entry.isFile() && codeExts.has(path.extname(entry.name).toLowerCase())) files.push(path.join(dir, entry.name));
        }
      } catch { /* skip unreadable directories */ }
    };
    walk(projectPath);
    return files;
  }

  private extractDependencies(projectPath: string, files: string[]): DSMEntry[] {
    const deps: DSMEntry[] = [];
    const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+(\S+)\s+import)/g;

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8').slice(0, 20000);
        const relFile = path.relative(projectPath, file);
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const imp = match[1] || match[2] || match[3];
          if (imp && !imp.startsWith('.') === false) {
            // Resolve relative imports
            const resolved = path.relative(projectPath, path.resolve(path.dirname(file), imp));
            if (files.some(f => path.relative(projectPath, f).startsWith(resolved))) {
              deps.push({ from: relFile, to: resolved, weight: 1 });
            }
          }
        }
      } catch { /* skip unreadable files */ }
    }
    return deps;
  }

  private detectCycles(deps: DSMEntry[]): string[][] {
    const graph = new Map<string, Set<string>>();
    for (const d of deps) {
      if (!graph.has(d.from)) graph.set(d.from, new Set());
      graph.get(d.from)!.add(d.to);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (node: string, pathArr: string[]) => {
      if (stack.has(node)) { cycles.push([...pathArr, node]); return; }
      if (visited.has(node)) return;
      visited.add(node);
      stack.add(node);
      for (const neighbor of graph.get(node) || []) dfs(neighbor, [...pathArr, node]);
      stack.delete(node);
    };

    for (const node of graph.keys()) dfs(node, []);
    return cycles.slice(0, 20); // Cap at 20
  }

  private detectGodFiles(files: string[], deps: DSMEntry[]): string[] {
    const inDegree = new Map<string, number>();
    for (const d of deps) inDegree.set(d.to, (inDegree.get(d.to) || 0) + 1);

    const threshold = Math.max(5, files.length * 0.1);
    return Array.from(inDegree.entries())
      .filter(([_, count]) => count >= threshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file]) => file);
  }

  private computeModularity(files: string[], deps: DSMEntry[]): number {
    if (files.length === 0) return 2000;
    const avgDeps = deps.length / Math.max(files.length, 1);
    if (avgDeps <= 2) return 2000;
    if (avgDeps <= 5) return 1500;
    if (avgDeps <= 10) return 1000;
    return Math.max(0, 2000 - Math.floor(avgDeps * 100));
  }

  private computeDepth(deps: DSMEntry[]): number {
    if (deps.length === 0) return 2000;
    // Approximate max depth via longest chain
    const graph = new Map<string, string[]>();
    for (const d of deps) {
      if (!graph.has(d.from)) graph.set(d.from, []);
      graph.get(d.from)!.push(d.to);
    }
    let maxDepth = 0;
    const memo = new Map<string, number>();
    const getDepth = (node: string, visited: Set<string>): number => {
      if (visited.has(node)) return 0;
      if (memo.has(node)) return memo.get(node)!;
      visited.add(node);
      let max = 0;
      for (const n of graph.get(node) || []) max = Math.max(max, 1 + getDepth(n, visited));
      visited.delete(node);
      memo.set(node, max);
      return max;
    };
    for (const node of graph.keys()) maxDepth = Math.max(maxDepth, getDepth(node, new Set()));
    if (maxDepth <= 5) return 2000;
    if (maxDepth <= 10) return 1500;
    if (maxDepth <= 20) return 1000;
    return Math.max(0, 2000 - maxDepth * 50);
  }

  private computeEquality(files: string[], deps: DSMEntry[]): number {
    if (files.length <= 1) return 2000;
    const sizes = new Map<string, number>();
    for (const f of files) {
      try { sizes.set(f, fs.statSync(f).size); } catch { sizes.set(f, 0); }
    }
    const values = Array.from(sizes.values());
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / values.length;
    const cv = avg > 0 ? Math.sqrt(variance) / avg : 0; // Coefficient of variation
    if (cv <= 0.5) return 2000;
    if (cv <= 1.0) return 1500;
    if (cv <= 2.0) return 1000;
    return Math.max(0, 2000 - Math.floor(cv * 400));
  }

  private computeRedundancy(files: string[]): number {
    // Check for duplicate file names (different dirs, same name = potential redundancy)
    const names = new Map<string, number>();
    for (const f of files) {
      const name = path.basename(f);
      names.set(name, (names.get(name) || 0) + 1);
    }
    const duplicates = Array.from(names.values()).filter(c => c > 1).length;
    const ratio = duplicates / Math.max(files.length, 1);
    if (ratio <= 0.05) return 2000;
    if (ratio <= 0.1) return 1500;
    if (ratio <= 0.2) return 1000;
    return Math.max(0, 2000 - Math.floor(ratio * 5000));
  }

  private evaluateRule(rule: ArchRule, score: ArchQualityScore): { rule: string; passed: boolean; message: string } {
    const cfg = rule.config as any;
    switch (rule.ruleType) {
      case 'max_cycles': return { rule: rule.ruleType, passed: score.cycleCount <= (cfg.max || 0), message: score.cycleCount + ' cycles (max: ' + (cfg.max || 0) + ')' };
      case 'max_coupling': {
        const grades = ['A', 'B', 'C', 'D', 'F'];
        return { rule: rule.ruleType, passed: grades.indexOf(score.couplingGrade) <= grades.indexOf(cfg.max || 'B'), message: 'Coupling: ' + score.couplingGrade + ' (max: ' + (cfg.max || 'B') + ')' };
      }
      case 'no_god_files': return { rule: rule.ruleType, passed: score.godFiles.length === 0, message: score.godFiles.length + ' god files detected' };
      case 'min_modularity': return { rule: rule.ruleType, passed: score.modularity >= (cfg.min || 1000), message: 'Modularity: ' + score.modularity + ' (min: ' + (cfg.min || 1000) + ')' };
      case 'max_depth': return { rule: rule.ruleType, passed: score.depthScore >= (cfg.minScore || 1000), message: 'Depth score: ' + score.depthScore };
      default: return { rule: rule.ruleType, passed: true, message: 'Unknown rule type' };
    }
  }

  private identifyBottleneck(score: ArchQualityScore): string {
    const metrics = [
      { name: 'modularity', value: score.modularity },
      { name: 'acyclicity', value: score.acyclicity },
      { name: 'depth', value: score.depthScore },
      { name: 'equality', value: score.equality },
      { name: 'redundancy', value: score.redundancy },
    ];
    metrics.sort((a, b) => a.value - b.value);
    return metrics[0]!.name;
  }

  private mapScore(r: any): ArchQualityScore {
    return { id: r.id, projectId: r.project_id, overallScore: r.overall_score, modularity: r.modularity, acyclicity: r.acyclicity, depthScore: r.depth_score, equality: r.equality, redundancy: r.redundancy, fileCount: r.file_count, dependencyCount: r.dependency_count, cycleCount: r.cycle_count, godFiles: JSON.parse(r.god_files || '[]'), couplingGrade: r.coupling_grade, details: JSON.parse(r.details || '{}'), scannedAt: r.scanned_at };
  }
}

// ── Bloat Scoring Dimension (Requirement 7) ─────────────────────

/**
 * Tag-to-category mapping for classifying BloatFindings into scored categories.
 *
 * - 'stdlib' tag → reinventedStdlib (reinvented standard library functionality)
 * - 'delete' tag → redundantDeps (redundant dependencies that duplicate stdlib)
 * - 'yagni' tag → singleImplAbstractions (single-implementation abstractions)
 * - 'native', 'shrink' → distributed across the closest matching category
 */
function categorizeFinding(finding: BloatFinding): keyof BloatScore['categories'] {
  switch (finding.tag) {
    case 'stdlib':
      return 'reinventedStdlib';
    case 'delete':
      return 'redundantDeps';
    case 'yagni':
      return 'singleImplAbstractions';
    case 'native':
      // Unnecessary wrappers that should use native features → reinventedStdlib
      return 'reinventedStdlib';
    case 'shrink':
      // Premature generalization (factories/builders with single use) → singleImplAbstractions
      return 'singleImplAbstractions';
  }
}

/**
 * Compute the bloat scoring dimension for a project directory.
 *
 * This is an additive dimension that does not modify existing scoring logic.
 * It uses the OverEngineeringReview to scan all source files in the project
 * and aggregates findings into a BloatScore with categorized counts and
 * total removable lines.
 *
 * The function scans all TypeScript/JavaScript source files in the project,
 * constructs synthetic AgentEdit payloads for the OverEngineeringReview analyzer,
 * and aggregates the resulting findings.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 *
 * @param projectDir - The root directory of the project to analyze
 * @returns A BloatScore with ranked findings, category counts, and totalLinesRemovable
 */
export function computeBloatScore(projectDir: string): BloatScore {
  const review = new OverEngineeringReview('advisory');

  // Discover all source files in the project
  const files = discoverSourceFiles(projectDir);

  // Read file contents and construct a synthetic AgentEdit for analysis
  const changes: Array<{ filePath: string; content: string }> = [];
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      changes.push({ filePath: path.relative(projectDir, filePath), content });
    } catch {
      // Skip unreadable files
    }
  }

  // Analyze all files through the over-engineering review
  const result = review.analyze(
    { id: 'bloat-scan', taskId: 'bloat-score', changes },
    { rootDir: projectDir, tsconfigPath: path.join(projectDir, 'tsconfig.json') },
  );

  // Categorize findings
  const categories: BloatScore['categories'] = {
    reinventedStdlib: 0,
    redundantDeps: 0,
    singleImplAbstractions: 0,
  };

  for (const finding of result.findings) {
    const category = categorizeFinding(finding);
    categories[category]++;
  }

  // Rank findings by netLineReduction descending (most impactful first)
  const rankedFindings = [...result.findings].sort(
    (a, b) => b.netLineReduction - a.netLineReduction,
  );

  // Compute total lines removable as sum of individual netLineReduction values
  const totalLinesRemovable = result.findings.reduce(
    (sum, f) => sum + f.netLineReduction,
    0,
  );

  return {
    findings: rankedFindings,
    totalLinesRemovable,
    categories,
  };
}

/**
 * Discover source files in a project directory for bloat analysis.
 * Skips common non-source directories (node_modules, dist, .git, etc.).
 */
function discoverSourceFiles(projectDir: string): string[] {
  const files: string[] = [];
  const codeExts = new Set(['.ts', '.js', '.tsx', '.jsx']);
  const skipDirs = new Set([
    'node_modules', '.git', 'dist', 'build', '.next', 'vendor',
    'coverage', '.nyc_output', '__pycache__',
  ]);

  const walk = (dir: string): void => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !skipDirs.has(entry.name)) {
          walk(path.join(dir, entry.name));
        } else if (entry.isFile() && codeExts.has(path.extname(entry.name).toLowerCase())) {
          // Skip test files and declaration files
          if (!entry.name.includes('.test.') && !entry.name.includes('.spec.') && !entry.name.endsWith('.d.ts')) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  };

  walk(projectDir);
  return files;
}

/**
 * Convert a BloatScore into a normalized 0–100 readiness-compatible score.
 *
 * Higher score = less bloat = better readiness. A project with zero findings
 * scores 100. The score decays based on the number of findings and total lines
 * removable. This function enables including bloat as a factor in any readiness
 * assessment (e.g. ProductionReadinessService, RepoReadinessScanner).
 *
 * Requirement 7.4: THE repo readiness scanner SHALL include the bloat score
 * as a factor in overall readiness assessment.
 */
export function computeBloatReadinessScore(bloatScore: BloatScore): number {
  if (bloatScore.findings.length === 0) return 100;

  // Penalize based on total removable lines — each 50 lines of bloat costs ~10 points
  const linesPenalty = Math.min(60, Math.floor(bloatScore.totalLinesRemovable / 5));

  // Additional penalty for number of findings — each finding costs 2 points, max 40
  const findingsPenalty = Math.min(40, bloatScore.findings.length * 2);

  return Math.max(0, 100 - linesPenalty - findingsPenalty);
}
