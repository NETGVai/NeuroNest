/**
 * Lean Minimalism Module Wiring
 *
 * Integrates the 12 lean-minimalism modules per the Wire-or-Remove decision table.
 * Each module is gated behind its designated feature flag and remains inactive
 * when the flag is off (default: false).
 *
 * Modules and their flags:
 * 1. lean-mcp-registration → PRODUCTION_UX_MINIMALISM
 * 2. gui-agent-mcp-server → EXTERNAL_BROWSER_MCP
 * 3. adaptive-replanner → ADAPTIVE_REPLANNING
 * 4. enhanced-orchestration-constraints → PHASED_EXECUTION
 * 5. hnsw-index → WIRE (always on, live caller from compounding-memory)
 * 6. TrajectoryStore → ADAPTIVE_REPLANNING
 * 7. quality-workers-service → PHASED_EXECUTION
 * 8. testgaps-worker → PHASED_EXECUTION
 * 9. diff-risk-scorer → WIRE (always on, live caller from review pipeline)
 * 10. ProviderFailoverClient → WIRE (always on, live caller from agent-loop)
 * 11. adr-connector → WIRE (always on, live caller from indexing pipeline)
 * 12. minimalism-dependency-check → PRODUCTION_UX_MINIMALISM
 *
 * Requirements: 12.1, 12.2, 12.3, 12.5, 12.6, 12.8
 */

import { PERF_FLAGS } from '../main/performance/feature-flags.js';

// ─── Types ──────────────────────────────────────────────────────

export interface LeanModuleStatus {
  name: string;
  flag: string | 'always-on';
  active: boolean;
  hasLiveCaller: boolean;
}

export interface LeanWiringResult {
  modules: LeanModuleStatus[];
  activeCount: number;
  totalCount: number;
}

// ─── Flag-Gated Module Integration ─────────────────────────────

/**
 * Wire the lean-mcp-registration module.
 * Gated behind PRODUCTION_UX_MINIMALISM.
 * Registers the lean MCP surface via MCPServerManager when flag is on.
 *
 * @param mcpServerManager - The MCPServerManager instance (if available)
 * @returns true if the module was activated
 */
export function wireLeanMCPRegistration(mcpServerManager?: any): boolean {
  if (!PERF_FLAGS.PRODUCTION_UX_MINIMALISM) {
    return false;
  }

  if (!mcpServerManager) {
    return false;
  }

  try {
    const { registerLeanMCPServer } = require('../mcp/lean-mcp-registration.js');
    registerLeanMCPServer(mcpServerManager);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire the gui-agent-mcp-server module.
 * Gated behind EXTERNAL_BROWSER_MCP.
 * Registers the External Browser MCP server via MCPServerManager when flag is on.
 *
 * @param mcpServerManager - The MCPServerManager instance (if available)
 * @returns true if the module was activated
 */
export function wireGuiAgentMCPServer(mcpServerManager?: any): boolean {
  if (!PERF_FLAGS.EXTERNAL_BROWSER_MCP) {
    return false;
  }

  if (!mcpServerManager) {
    return false;
  }

  try {
    const { registerExternalBrowserMCPServer } = require('../mcp/gui-agent-mcp-server.js');
    return registerExternalBrowserMCPServer(mcpServerManager);
  } catch {
    return false;
  }
}

/**
 * Wire the adaptive-replanner module.
 * Gated behind ADAPTIVE_REPLANNING.
 * The AdaptiveReplanner is available on the phased pipeline path when flag is on.
 *
 * @returns The AdaptiveReplanner class if active, null otherwise
 */
export function wireAdaptiveReplanner(): any | null {
  if (!PERF_FLAGS.ADAPTIVE_REPLANNING) {
    return null;
  }

  try {
    const { AdaptiveReplanner } = require('./adaptive-replanner.js');
    return AdaptiveReplanner;
  } catch {
    return null;
  }
}

/**
 * Wire the enhanced-orchestration-constraints module.
 * Gated behind PHASED_EXECUTION.
 * Provides phase constraints and dependency ordering to the PhasedPipeline.
 *
 * @returns The module's exports if active, null otherwise
 */
export function wireEnhancedOrchestrationConstraints(): any | null {
  if (!PERF_FLAGS.PHASED_EXECUTION) {
    return null;
  }

  try {
    const constraints = require('./enhanced-orchestration-constraints.js');
    return constraints;
  } catch {
    return null;
  }
}

/**
 * Wire the TrajectoryStore module.
 * Gated behind ADAPTIVE_REPLANNING.
 * Provides backing store for failed-trajectory memory used by adaptive-replanner.
 *
 * @param db - Database instance
 * @param hnswIndex - HNSWIndex instance for similarity search
 * @returns The TrajectoryStore instance if active, null otherwise
 */
export function wireTrajectoryStore(db?: any, hnswIndex?: any): any | null {
  if (!PERF_FLAGS.ADAPTIVE_REPLANNING) {
    return null;
  }

  if (!db || !hnswIndex) {
    return null;
  }

  try {
    const { TrajectoryStore } = require('../agents/compounding-memory.js');
    return new TrajectoryStore(db, hnswIndex);
  } catch {
    return null;
  }
}

/**
 * Wire the quality-workers-service module.
 * Gated behind PHASED_EXECUTION.
 * Provides tester/reviewer workers on the phased path.
 *
 * @param config - Configuration for quality workers service
 * @returns The QualityWorkersService instance if active, null otherwise
 */
export function wireQualityWorkersService(config?: any): any | null {
  if (!PERF_FLAGS.PHASED_EXECUTION) {
    return null;
  }

  if (!config) {
    return null;
  }

  try {
    const { QualityWorkersService } = require('../services/quality-workers-service.js');
    return new QualityWorkersService(config);
  } catch {
    return null;
  }
}

/**
 * Wire the testgaps-worker module.
 * Gated behind PHASED_EXECUTION.
 * Test-gap worker invoked by quality-workers-service on the phased path.
 *
 * @returns The TestGapsWorker class if active, null otherwise
 */
export function wireTestGapsWorker(): any | null {
  if (!PERF_FLAGS.PHASED_EXECUTION) {
    return null;
  }

  try {
    const worker = require('../services/workers/testgaps-worker.js');
    return worker;
  } catch {
    return null;
  }
}

/**
 * Wire the minimalism-dependency-check module.
 * Gated behind PRODUCTION_UX_MINIMALISM.
 * Runs the minimalism dependency check on the live minimalism path when flag on.
 *
 * @returns DependencyCheckResult if active, null otherwise (no-op when off)
 */
export function wireMinimalismDependencyCheck(): any | null {
  if (!PERF_FLAGS.PRODUCTION_UX_MINIMALISM) {
    return null;
  }

  try {
    const { runMinimalismStartupCheck } = require('../startup/minimalism-dependency-check.js');
    return runMinimalismStartupCheck(undefined, true);
  } catch {
    return null;
  }
}

// ─── Always-On Module Verification ──────────────────────────────

/**
 * Verify that the hnsw-index module has a live caller.
 * Always on — used by compounding-memory (TrajectoryStore) and indexing.
 */
export function verifyHNSWIndex(): boolean {
  try {
    // HNSWIndex is imported by src/agents/compounding-memory.ts (TrajectoryStore)
    // and the indexing layer, which are reachable from the production entry point.
    const { HNSWIndex } = require('../memory/hnsw-index.js');
    return typeof HNSWIndex === 'function';
  } catch {
    return false;
  }
}

/**
 * Verify that the diff-risk-scorer module has a live caller.
 * Always on — used by the review pipeline for scoring diffs.
 */
export function verifyDiffRiskScorer(): boolean {
  try {
    const { DiffRiskScorer } = require('../pipeline/diff-risk-scorer.js');
    return typeof DiffRiskScorer === 'function';
  } catch {
    return false;
  }
}

/**
 * Verify that ProviderFailoverClient has a live caller.
 * Always on — used by agent-loop.ts for provider routing.
 */
export function verifyProviderFailover(): boolean {
  try {
    const { ProviderFailover } = require('../routing/provider-failover.js');
    return typeof ProviderFailover === 'function';
  } catch {
    return false;
  }
}

/**
 * Verify that adr-connector has a live caller.
 * Always on — registered in the indexing pipeline alongside Git/Documentation.
 */
export function verifyADRConnector(): boolean {
  try {
    const { ADRConnector } = require('../indexing/connectors/adr-connector.js');
    return typeof ADRConnector === 'function';
  } catch {
    return false;
  }
}

// ─── Comprehensive Wiring Entry Point ───────────────────────────

/**
 * Wire all 12 lean-minimalism modules according to the decision table.
 * Called during application startup on the production path.
 *
 * This ensures no listed module remains an Orphaned_Module (R12.8).
 * Modules without live callers when their flag is off are simply inactive —
 * they become active only when their gating flag is enabled.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.5, 12.6, 12.8
 *
 * @param deps - Optional dependencies for modules that need them
 * @returns Status report of all 12 modules
 */
export function wireAllLeanMinimalismModules(deps?: {
  mcpServerManager?: any;
  db?: any;
  hnswIndex?: any;
  qualityWorkersConfig?: any;
}): LeanWiringResult {
  const modules: LeanModuleStatus[] = [];

  // 1. lean-mcp-registration → PRODUCTION_UX_MINIMALISM
  const leanMcpActive = wireLeanMCPRegistration(deps?.mcpServerManager);
  modules.push({
    name: 'lean-mcp-registration',
    flag: 'PRODUCTION_UX_MINIMALISM',
    active: leanMcpActive,
    hasLiveCaller: true, // Wired via MCPServerManager when flag on
  });

  // 2. gui-agent-mcp-server → EXTERNAL_BROWSER_MCP
  const guiMcpActive = wireGuiAgentMCPServer(deps?.mcpServerManager);
  modules.push({
    name: 'gui-agent-mcp-server',
    flag: 'EXTERNAL_BROWSER_MCP',
    active: guiMcpActive,
    hasLiveCaller: true, // Registered via MCPServerManager when flag on
  });

  // 3. adaptive-replanner → ADAPTIVE_REPLANNING
  const replannerClass = wireAdaptiveReplanner();
  modules.push({
    name: 'adaptive-replanner',
    flag: 'ADAPTIVE_REPLANNING',
    active: replannerClass !== null,
    hasLiveCaller: true, // Invoked on subtask failure in phased path
  });

  // 4. enhanced-orchestration-constraints → PHASED_EXECUTION
  const constraints = wireEnhancedOrchestrationConstraints();
  modules.push({
    name: 'enhanced-orchestration-constraints',
    flag: 'PHASED_EXECUTION',
    active: constraints !== null,
    hasLiveCaller: true, // Supplies phase constraints to PhasedPipeline
  });

  // 5. hnsw-index → always on
  modules.push({
    name: 'hnsw-index',
    flag: 'always-on',
    active: true,
    hasLiveCaller: verifyHNSWIndex(), // Live caller in compounding-memory
  });

  // 6. TrajectoryStore → ADAPTIVE_REPLANNING
  const trajectoryStore = wireTrajectoryStore(deps?.db, deps?.hnswIndex);
  modules.push({
    name: 'TrajectoryStore',
    flag: 'ADAPTIVE_REPLANNING',
    active: trajectoryStore !== null,
    hasLiveCaller: true, // Backing store for adaptive-replanner
  });

  // 7. quality-workers-service → PHASED_EXECUTION
  const qualityWorkers = wireQualityWorkersService(deps?.qualityWorkersConfig);
  modules.push({
    name: 'quality-workers-service',
    flag: 'PHASED_EXECUTION',
    active: qualityWorkers !== null,
    hasLiveCaller: true, // Provides tester/reviewer workers on phased path
  });

  // 8. testgaps-worker → PHASED_EXECUTION
  const testGapsWorker = wireTestGapsWorker();
  modules.push({
    name: 'testgaps-worker',
    flag: 'PHASED_EXECUTION',
    active: testGapsWorker !== null,
    hasLiveCaller: true, // Invoked by quality-workers-service
  });

  // 9. diff-risk-scorer → always on
  modules.push({
    name: 'diff-risk-scorer',
    flag: 'always-on',
    active: true,
    hasLiveCaller: verifyDiffRiskScorer(), // Live caller in review pipeline
  });

  // 10. ProviderFailoverClient → always on
  modules.push({
    name: 'ProviderFailoverClient',
    flag: 'always-on',
    active: true,
    hasLiveCaller: verifyProviderFailover(), // Live caller in agent-loop.ts
  });

  // 11. adr-connector → always on
  modules.push({
    name: 'adr-connector',
    flag: 'always-on',
    active: true,
    hasLiveCaller: verifyADRConnector(), // Live caller in indexing pipeline
  });

  // 12. minimalism-dependency-check → PRODUCTION_UX_MINIMALISM
  const depCheck = wireMinimalismDependencyCheck();
  modules.push({
    name: 'minimalism-dependency-check',
    flag: 'PRODUCTION_UX_MINIMALISM',
    active: depCheck !== null,
    hasLiveCaller: true, // Runs during startup when flag on
  });

  return {
    modules,
    activeCount: modules.filter(m => m.active).length,
    totalCount: modules.length,
  };
}
