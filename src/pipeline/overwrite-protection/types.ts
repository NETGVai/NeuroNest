/**
 * Type definitions for the Overwrite Protection pipeline.
 * Defines interfaces for project identity anchoring, overwrite gating,
 * scope divergence detection, cross-project registry, and configuration.
 */

// ─── Project Identity ───────────────────────────────────────────

export interface ProjectManifest {
  name: string;
  primaryLanguage: string;
  framework: string | null;
  purpose: string;
  entryPoints: string[];
  dependencies: string[];
}

export interface IdentityAnchorResult {
  /** The "## Project Identity" markdown section */
  section: string;
  /** The "## Related Projects" section */
  relatedProjectsSection: string;
  source: 'rules.md' | 'manifest' | 'heuristic';
}

// ─── Overwrite Gate ─────────────────────────────────────────────

export interface OverwriteGateConfig {
  enabled: boolean;
  /** Minimum relatedness score to allow write without confirmation (default 0.2 = 20%) */
  relatednesThreshold: number;
  /** Glob patterns that skip the gate */
  excludedPaths: string[];
}

export interface RelatednessResult {
  /** Relatedness score from 0.0 to 1.0 */
  score: number;
  sharedIdentifiers: string[];
  totalExistingIdentifiers: number;
  /** Whether score >= threshold */
  isRelated: boolean;
}

export interface OverwriteDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  relatedness: RelatednessResult;
  filePath: string;
}

// ─── Scope Detector ─────────────────────────────────────────────

export interface ScopeDetectorConfig {
  enabled: boolean;
  /** Divergence threshold (default 0.7) */
  threshold: number;
  explicitScopeChangePatterns: RegExp[];
}

export interface ScopeDivergenceResult {
  /** Divergence score from 0.0 to 1.0 */
  score: number;
  isNewProjectRequest: boolean;
  triggeredByExplicitPhrase: boolean;
  inferredProjectName: string | null;
  inferredStack: string | null;
  explanation: string;
}

// ─── Cross-Project Registry ─────────────────────────────────────

export interface RegisteredProject {
  name: string;
  directory: string;
  stack: string;
  purpose: string;
  exportedInterfaces: string[];
  dependencies: string[];
  lastUpdated: string;
}

export interface CrossProjectRegistry {
  version: number;
  projects: RegisteredProject[];
}

// ─── Configuration ──────────────────────────────────────────────

export interface OverwriteProtectionSettings {
  overwriteGate: OverwriteGateConfig;
  scopeDetector: ScopeDetectorConfig;
}

// ─── IPC Payloads ───────────────────────────────────────────────

export interface ScopeWarningPayload {
  type: 'scope-warning';
  currentProject: { name: string; stack: string; purpose: string };
  inferredNewProject: { name: string; stack: string | null };
  explanation: string;
  options: ['create_new_project', 'cancel'];
}

export interface OverwriteConfirmationPayload {
  type: 'overwrite-confirmation';
  filePath: string;
  relatednessScore: number;
  sharedIdentifiers: string[];
  summary: string;
  options: ['confirm', 'reject'];
}
