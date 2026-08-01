/**
 * Agent Catalog Types
 *
 * Shared interfaces for the Agent Catalog subsystem covering agent import,
 * duplicate detection, quality scoring, and catalog versioning.
 */

import type { AgentDefinition, ToolPermission } from '../agents/agent-registry';

// ─────────────────────────────────────────────
// Agent Import
// ─────────────────────────────────────────────

/** An agent definition imported from an external markdown source. */
export interface ImportedAgent {
  definition: AgentDefinition;
  sourceFile: string;
  division: string;
  rawFrontmatter: Record<string, string>;
}

/** Result of an import operation across one or more agent files. */
export interface ImportResult {
  imported: ImportedAgent[];
  errors: { file: string; reason: string }[];
  divisions: string[];
}

// ─────────────────────────────────────────────
// Duplicate Detection
// ─────────────────────────────────────────────

/** Multi-dimensional similarity score between two agent definitions. */
export interface SimilarityScore {
  idMatch: number;          // 0 or 1
  nameSimilarity: number;   // 0-1 (normalized Levenshtein)
  specialtyOverlap: number; // 0-1 (Jaccard coefficient)
  departmentMatch: number;  // 0 or 1
  composite: number;        // weighted average
}

/** A pair of agents flagged as potential duplicates. */
export interface DuplicatePair {
  existing: AgentDefinition;
  imported: ImportedAgent;
  similarity: SimilarityScore;
}

/** The resolution decision for a detected duplicate pair. */
export interface ResolutionDecision {
  pair: DuplicatePair;
  existingScore: number;
  importedScore: number;
  action: 'replace' | 'retain';
  fieldsUpdated: string[];
}

/** A complete report of duplicate detection and resolution. */
export interface DuplicateReport {
  pairs: DuplicatePair[];
  decisions: ResolutionDecision[];
  timestamp: string;
}

// ─────────────────────────────────────────────
// Quality Scoring
// ─────────────────────────────────────────────

/** Breakdown of an agent definition's quality score across four dimensions. */
export interface QualityBreakdown {
  promptSpecificity: number;      // 0-25
  deliverableStructure: number;   // 0-25
  workflowCompleteness: number;   // 0-25
  domainDepth: number;            // 0-25
  total: number;                  // 0-100
}

// ─────────────────────────────────────────────
// Catalog Versioning
// ─────────────────────────────────────────────

/** A point-in-time snapshot of the agent catalog for rollback purposes. */
export interface CatalogSnapshot {
  version: number;
  timestamp: number;
  agentRegistry: AgentDefinition[];
  toolPermissions: Record<string, ToolPermission>;
  reason: string;
}
