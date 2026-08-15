/**
 * Types for the attribution and reliability system.
 *
 * Every surfaced claim, response, or artifact carries provenance metadata
 * so users can distinguish what came from code vs what came from the model.
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6
 */

/**
 * Accuracy qualifiers for surfaced content.
 * - verified: has supporting evidence (test pass, code reference, tool output)
 * - model-generated: produced by AI model without independent verification
 * - unverified: claim exists but no supporting data available
 * - approximate: derived from heuristic or partial data
 */
export type AccuracyQualifier = 'verified' | 'model-generated' | 'unverified' | 'approximate';

/**
 * Reliability classification for content in the system.
 * - verified: has linked evidence proving the claim
 * - model-generated: produced by AI without verification
 * - unverified: assertion without supporting data
 */
export type ReliabilityClass = 'verified' | 'model-generated' | 'unverified';

/**
 * Source provenance attached to a piece of content.
 * When quoting or proposing code, includes source URI and version.
 */
export interface SourceProvenance {
  /** Source URI (e.g., file path, URL, tool output location) */
  uri?: string;
  /** Version identifier (commit hash, document version, API version) */
  version?: string;
  /** Accuracy qualifier for this source */
  accuracy: AccuracyQualifier;
}

/**
 * Attribution metadata attached to every surfaced claim.
 * Identifies who/what produced the content and with what confidence.
 */
export interface Attribution {
  /** Identifier of the agent that produced this claim */
  agentId: string;
  /** Identifier of the model used (e.g., "gpt-4o", "claude-3.5-sonnet") */
  modelId: string;
  /** Identifier of the tool that produced or verified this claim, if any */
  toolId?: string;
  /** Confidence score from 0 to 1; reflects model's self-reported certainty */
  confidence: number;
  /** Source provenance when quoting or proposing code */
  source?: SourceProvenance;
  /** Timestamp of when attribution was created */
  timestamp: string;
}

/**
 * An attributed claim — a piece of content with full provenance.
 */
export interface AttributedClaim {
  /** Unique identifier for this claim */
  id: string;
  /** The content of the claim */
  content: string;
  /** Full attribution metadata */
  attribution: Attribution;
  /** Reliability classification */
  reliability: ReliabilityClass;
}

/**
 * Evidence record that can back a verified claim.
 */
export interface VerificationEvidence {
  /** Unique evidence identifier */
  id: string;
  /** Kind of evidence (test-result, tool-output, code-reference, user-approval) */
  kind: 'test-result' | 'tool-output' | 'code-reference' | 'user-approval';
  /** Reference to the source of evidence */
  sourceRef: string;
  /** Workspace revision at time of evidence capture */
  workspaceRevision?: string;
  /** ISO 8601 timestamp of evidence creation */
  timestamp: string;
}

/**
 * Status indicator with provenance distinction.
 * Makes it clear whether a status comes from AI or verified source.
 */
export interface ProvenanceStatus {
  /** The status value */
  status: string;
  /** Whether this is AI-generated or independently verified */
  reliability: ReliabilityClass;
  /** Source of the status (agent, tool, user) */
  sourceKind: 'agent' | 'tool' | 'user' | 'service';
  /** Identifier of the source */
  sourceId: string;
}
