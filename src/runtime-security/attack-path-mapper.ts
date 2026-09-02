/**
 * Attack Path Mapper — correlates individual vulnerability findings
 * across files and modules to identify chained exploitation paths
 * with blast radius estimation.
 *
 * Maintains an internal graph of vulnerability nodes and edges.
 * Incrementally updates the graph as new findings arrive (O(n) per addition).
 * Computes composite risk scores and emits high-priority events for
 * critical paths via CallbackEngine.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import type { ThreatSeverity } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface VulnerabilityNode {
  id: string;
  file: string;
  line: number;
  category: string;
  severity: ThreatSeverity;
  source: 'hackability' | 'scanner' | 'realtime' | 'ai-rules';
}

export interface AttackPathEdge {
  from: string; // node ID
  to: string;   // node ID
  relationship: 'data-flow' | 'control-flow' | 'import-chain' | 'api-call';
}

export interface AttackPath {
  id: string;
  nodes: VulnerabilityNode[];
  edges: AttackPathEdge[];
  compositeRiskScore: number;      // 0–100
  blastRadius: BlastRadius;
  exploitabilityLikelihood: number; // 0–1
  requiredAttackerCapability: 'none' | 'low' | 'medium' | 'high';
  remediationSequence: string[];
}

export interface BlastRadius {
  affectedFiles: number;
  affectedModules: number;
  dataSensitivity: Array<'pii' | 'credentials' | 'financial' | 'internal'>;
  estimatedImpactScore: number; // 0–100
}

// ─── Callback Engine Interface ──────────────────────────────────

/** Minimal interface for the CallbackEngine dependency (attack path mapper) */
interface AttackPathCallbackEngine {
  emit: (event: string, context: unknown) => void;
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_CRITICAL_THRESHOLD = 80;

/** Severity weights for exploitability likelihood calculation */
const SEVERITY_WEIGHTS: Record<ThreatSeverity, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

/** Categories that imply credential/secrets sensitivity */
const CREDENTIAL_CATEGORIES = new Set([
  'secrets-in-prompts',
  'secretsExposure',
  'secrets',
  'hardcoded-credentials',
  'authentication',
]);

/** Categories that imply PII sensitivity */
const PII_CATEGORIES = new Set([
  'pii-leakage',
  'pii',
  'personal-data',
  'data-exposure',
]);

/** Categories that imply financial sensitivity */
const FINANCIAL_CATEGORIES = new Set([
  'financial',
  'payment',
  'transaction',
  'billing',
]);

/** Category chains: a finding in one category can chain to another */
const CATEGORY_CHAINS: Record<string, string[]> = {
  'prompt-injection': ['unvalidated-output', 'injection', 'injectionRisk'],
  'injectionRisk': ['dataValidation', 'unvalidated-output'],
  'secrets-in-prompts': ['pii-leakage', 'secretsExposure'],
  'secretsExposure': ['authenticationWeakness', 'secrets-in-prompts'],
  'pii-leakage': ['data-exposure', 'dataValidation'],
  'dataValidation': ['injectionRisk', 'unvalidated-output'],
  'unvalidated-output': ['injectionRisk', 'prompt-injection'],
  'authenticationWeakness': ['secretsExposure', 'injection'],
  'missing-rate-limit': ['prompt-injection', 'injectionRisk'],
};

// ─── AttackPathMapper Class ─────────────────────────────────────

export class AttackPathMapper {
  private readonly callbackEngine: AttackPathCallbackEngine;
  private readonly criticalThreshold: number;
  private nodes: Map<string, VulnerabilityNode> = new Map();
  private edges: AttackPathEdge[] = [];

  /** Index: file path → set of node IDs in that file */
  private fileIndex: Map<string, Set<string>> = new Map();

  /** Index: module name → set of node IDs in that module */
  private moduleIndex: Map<string, Set<string>> = new Map();

  /** Index: category → set of node IDs with that category */
  private categoryIndex: Map<string, Set<string>> = new Map();

  /** Adjacency list for graph traversal: node ID → set of connected node IDs */
  private adjacency: Map<string, Set<string>> = new Map();

  constructor(
    callbackEngine: AttackPathCallbackEngine,
    criticalThreshold: number = DEFAULT_CRITICAL_THRESHOLD,
  ) {
    this.callbackEngine = callbackEngine;
    this.criticalThreshold = criticalThreshold;
  }

  /**
   * Add a new finding to the correlation graph.
   * Incrementally updates paths without full recomputation.
   * O(n) where n is the number of existing nodes in the same module/category chain.
   */
  addFinding(node: VulnerabilityNode): void {
    // Avoid duplicate nodes
    if (this.nodes.has(node.id)) {
      return;
    }

    this.nodes.set(node.id, node);
    this.adjacency.set(node.id, new Set());

    // Update file index
    if (!this.fileIndex.has(node.file)) {
      this.fileIndex.set(node.file, new Set());
    }
    this.fileIndex.get(node.file)!.add(node.id);

    // Update module index
    const module = this.inferModule(node.file);
    if (!this.moduleIndex.has(module)) {
      this.moduleIndex.set(module, new Set());
    }
    this.moduleIndex.get(module)!.add(node.id);

    // Update category index
    if (!this.categoryIndex.has(node.category)) {
      this.categoryIndex.set(node.category, new Set());
    }
    this.categoryIndex.get(node.category)!.add(node.id);

    // Build edges based on relationships
    this.buildEdgesForNode(node, module);
  }

  /**
   * Get all identified attack paths, ranked by composite risk score descending.
   * An attack path requires at least 2 connected nodes.
   */
  getAttackPaths(): AttackPath[] {
    const components = this.findConnectedComponents();
    const paths: AttackPath[] = [];

    for (const component of components) {
      // Only paths with at least 2 nodes
      if (component.length < 2) {
        continue;
      }

      const pathNodes = component.map((id) => this.nodes.get(id)!);
      const pathEdges = this.edges.filter(
        (e) => component.includes(e.from) && component.includes(e.to),
      );

      const blastRadius = this.computeBlastRadius(pathNodes);
      const exploitabilityLikelihood = this.computeExploitability(pathNodes);
      const requiredAttackerCapability = this.computeAttackerCapability(pathNodes);
      const compositeRiskScore = this.computeCompositeRiskScore(
        exploitabilityLikelihood,
        blastRadius,
        requiredAttackerCapability,
      );

      paths.push({
        id: `path-${paths.length + 1}`,
        nodes: pathNodes,
        edges: pathEdges,
        compositeRiskScore,
        blastRadius,
        exploitabilityLikelihood,
        requiredAttackerCapability,
        remediationSequence: this.computeRemediationSequence(pathNodes),
      });
    }

    // Sort descending by compositeRiskScore
    paths.sort((a, b) => b.compositeRiskScore - a.compositeRiskScore);

    // Re-assign IDs after sorting
    for (let i = 0; i < paths.length; i++) {
      paths[i]!.id = `path-${i + 1}`;
    }

    return paths;
  }

  /**
   * Get attack paths exceeding the critical threshold.
   * Emits high-priority 'security-attack-path-found' events via CallbackEngine.
   */
  getCriticalPaths(): AttackPath[] {
    const allPaths = this.getAttackPaths();
    const criticalPaths = allPaths.filter(
      (p) => p.compositeRiskScore > this.criticalThreshold,
    );

    for (const path of criticalPaths) {
      this.callbackEngine.emit('security-attack-path-found', {
        securityEvent: {
          subsystem: 'attack_path_mapper',
          severity: 'critical' as ThreatSeverity,
          score: path.compositeRiskScore,
          findings: path.nodes,
          decision: 'warned',
          filePath: path.nodes[0]?.file,
        },
        attackPath: path,
        remediationSequence: path.remediationSequence,
      });
    }

    return criticalPaths;
  }

  /**
   * Reset the correlation graph (e.g., on new session).
   * Clears all nodes, edges, and indexes.
   */
  reset(): void {
    this.nodes.clear();
    this.edges = [];
    this.fileIndex.clear();
    this.moduleIndex.clear();
    this.categoryIndex.clear();
    this.adjacency.clear();
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Infer the module name from a file path.
   * E.g., "src/auth/login.ts" → "auth", "src/utils/helpers.ts" → "utils"
   */
  private inferModule(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const parts = normalized.split('/');

    // Look for a meaningful directory after 'src/'
    const srcIdx = parts.indexOf('src');
    if (srcIdx >= 0 && srcIdx < parts.length - 1) {
      const moduleName = parts[srcIdx + 1];
      if (moduleName) return moduleName;
    }

    // Fallback: use the parent directory name
    if (parts.length >= 2) {
      const parentDir = parts[parts.length - 2];
      if (parentDir) return parentDir;
    }

    return 'root';
  }

  /**
   * Build edges connecting the new node to existing nodes.
   * Connections are made based on:
   * 1. Same file (control-flow)
   * 2. Same module (import-chain)
   * 3. Category chain relationships (data-flow)
   */
  private buildEdgesForNode(node: VulnerabilityNode, module: string): void {
    // 1. Connect to other nodes in the same file (control-flow)
    const fileNodes = this.fileIndex.get(node.file);
    if (fileNodes) {
      for (const existingId of fileNodes) {
        if (existingId === node.id) continue;
        this.addEdge(existingId, node.id, 'control-flow');
      }
    }

    // 2. Connect to other nodes in the same module but different file (import-chain)
    const moduleNodes = this.moduleIndex.get(module);
    if (moduleNodes) {
      for (const existingId of moduleNodes) {
        if (existingId === node.id) continue;
        const existingNode = this.nodes.get(existingId)!;
        // Only connect cross-file relationships via import-chain
        if (existingNode.file !== node.file) {
          this.addEdge(existingId, node.id, 'import-chain');
        }
      }
    }

    // 3. Connect based on category chains (data-flow)
    const chainableCategories = CATEGORY_CHAINS[node.category] ?? [];
    for (const targetCategory of chainableCategories) {
      const categoryNodes = this.categoryIndex.get(targetCategory);
      if (categoryNodes) {
        for (const existingId of categoryNodes) {
          if (existingId === node.id) continue;
          // Only create data-flow edge if not already connected
          if (!this.hasEdgeBetween(existingId, node.id)) {
            this.addEdge(existingId, node.id, 'data-flow');
          }
        }
      }
    }
  }

  /** Add an edge and update the adjacency list */
  private addEdge(from: string, to: string, relationship: AttackPathEdge['relationship']): void {
    this.edges.push({ from, to, relationship });

    if (!this.adjacency.has(from)) {
      this.adjacency.set(from, new Set());
    }
    if (!this.adjacency.has(to)) {
      this.adjacency.set(to, new Set());
    }
    this.adjacency.get(from)!.add(to);
    this.adjacency.get(to)!.add(from);
  }

  /** Check if an edge already exists between two nodes (in either direction) */
  private hasEdgeBetween(a: string, b: string): boolean {
    return this.adjacency.get(a)?.has(b) ?? false;
  }

  /**
   * Find connected components using BFS.
   * Each component represents a potential attack path.
   */
  private findConnectedComponents(): string[][] {
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const nodeId of this.nodes.keys()) {
      if (visited.has(nodeId)) continue;

      const component: string[] = [];
      const queue: string[] = [nodeId];
      visited.add(nodeId);

      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);

        const neighbors = this.adjacency.get(current) || new Set();
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      components.push(component);
    }

    return components;
  }

  /**
   * Compute blast radius for a set of nodes.
   */
  private computeBlastRadius(nodes: VulnerabilityNode[]): BlastRadius {
    const files = new Set(nodes.map((n) => n.file));
    const modules = new Set(nodes.map((n) => this.inferModule(n.file)));
    const sensitivity = this.inferDataSensitivity(nodes);

    const affectedFiles = files.size;
    const affectedModules = modules.size;

    // Impact score: combine file spread, module spread, and sensitivity
    const fileFactor = Math.min(affectedFiles * 10, 40);
    const moduleFactor = Math.min(affectedModules * 15, 30);
    const sensitivityFactor = Math.min(sensitivity.length * 10, 30);
    const estimatedImpactScore = Math.min(
      fileFactor + moduleFactor + sensitivityFactor,
      100,
    );

    return {
      affectedFiles,
      affectedModules,
      dataSensitivity: sensitivity,
      estimatedImpactScore,
    };
  }

  /**
   * Infer data sensitivity from node categories.
   */
  private inferDataSensitivity(
    nodes: VulnerabilityNode[],
  ): Array<'pii' | 'credentials' | 'financial' | 'internal'> {
    const sensitivity = new Set<'pii' | 'credentials' | 'financial' | 'internal'>();

    for (const node of nodes) {
      if (CREDENTIAL_CATEGORIES.has(node.category)) {
        sensitivity.add('credentials');
      }
      if (PII_CATEGORIES.has(node.category)) {
        sensitivity.add('pii');
      }
      if (FINANCIAL_CATEGORIES.has(node.category)) {
        sensitivity.add('financial');
      }
    }

    // If no specific sensitivity detected, mark as internal
    if (sensitivity.size === 0) {
      sensitivity.add('internal');
    }

    return Array.from(sensitivity);
  }

  /**
   * Compute exploitability likelihood from node severities (0–1).
   */
  private computeExploitability(nodes: VulnerabilityNode[]): number {
    if (nodes.length === 0) return 0;

    // Average severity weight, boosted by chain length
    const avgSeverity =
      nodes.reduce((sum, n) => sum + SEVERITY_WEIGHTS[n.severity], 0) / nodes.length;
    const chainBoost = Math.min(nodes.length * 0.1, 0.3);

    return Math.min(avgSeverity + chainBoost, 1.0);
  }

  /**
   * Determine required attacker capability based on node characteristics.
   */
  private computeAttackerCapability(
    nodes: VulnerabilityNode[],
  ): 'none' | 'low' | 'medium' | 'high' {
    const hasCritical = nodes.some((n) => n.severity === 'critical');
    const hasHigh = nodes.some((n) => n.severity === 'high');
    const hasAuthWeakness = nodes.some(
      (n) =>
        n.category === 'authenticationWeakness' ||
        n.category === 'authentication',
    );

    // If critical vulnerabilities with auth weakness, no capability needed
    if (hasCritical && hasAuthWeakness) {
      return 'none';
    }
    // Critical severity implies low capability needed
    if (hasCritical) {
      return 'low';
    }
    // High severity implies medium capability
    if (hasHigh) {
      return 'medium';
    }
    // Otherwise high capability required
    return 'high';
  }

  /**
   * Compute composite risk score (0–100) from exploitability, blast radius, and capability.
   */
  private computeCompositeRiskScore(
    exploitability: number,
    blastRadius: BlastRadius,
    capability: 'none' | 'low' | 'medium' | 'high',
  ): number {
    const capabilityWeights: Record<'none' | 'low' | 'medium' | 'high', number> = {
      none: 1.0,
      low: 0.85,
      medium: 0.65,
      high: 0.45,
    };

    // Weighted combination: exploitability (40%), blast radius (40%), capability modifier (20%)
    const exploitabilityComponent = exploitability * 40;
    const blastRadiusComponent = (blastRadius.estimatedImpactScore / 100) * 40;
    const capabilityComponent = capabilityWeights[capability] * 20;

    const rawScore = exploitabilityComponent + blastRadiusComponent + capabilityComponent;
    return Math.round(Math.min(Math.max(rawScore, 0), 100));
  }

  /**
   * Compute remediation sequence: prioritize critical/high severity nodes first,
   * then order by categories that break the most attack chains.
   */
  private computeRemediationSequence(nodes: VulnerabilityNode[]): string[] {
    // Sort by severity priority then by number of edges (most connected first)
    const sorted = [...nodes].sort((a, b) => {
      const severityOrder: Record<ThreatSeverity, number> = {
        critical: 0,
        high: 1,
        medium: 2,
        low: 3,
      };
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;

      // Tie-break by connectivity
      const aConnections = this.adjacency.get(a.id)?.size || 0;
      const bConnections = this.adjacency.get(b.id)?.size || 0;
      return bConnections - aConnections;
    });

    return sorted.map(
      (n) => `Fix ${n.severity} ${n.category} in ${n.file}:${n.line}`,
    );
  }
}
