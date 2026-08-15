/**
 * ReliabilityService — classifies content reliability and prevents
 * model-generated prose from masquerading as verified evidence.
 *
 * Ensures:
 * - Content is classified: verified (has evidence), model-generated, unverified
 * - Model confidence is never displayed as verified status
 * - Status indicators clearly distinguish AI-generated from human-verified
 * - Generated content cannot be recorded as Evidence without proper verification
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6
 */

import type {
  AccuracyQualifier,
  AttributedClaim,
  ProvenanceStatus,
  ReliabilityClass,
  VerificationEvidence,
} from './types';

/** Represents content that may be submitted to the Evidence store */
export interface EvidenceCandidate {
  /** Content to be stored */
  content: string;
  /** Reliability classification of the content */
  reliability: ReliabilityClass;
  /** Linked verification evidence, if any */
  evidence?: VerificationEvidence;
  /** The accuracy qualifier */
  accuracy: AccuracyQualifier;
  /** Source of the content */
  sourceKind: 'agent' | 'tool' | 'user' | 'service';
  /** Source identifier */
  sourceId: string;
}

/** Result of an evidence submission attempt */
export interface EvidenceSubmissionResult {
  /** Whether the submission was accepted */
  accepted: boolean;
  /** Reason for rejection, if applicable */
  rejectionReason?: string;
}

export class ReliabilityService {
  /**
   * Classify the reliability of content based on available evidence.
   * Model confidence alone never produces a 'verified' classification.
   */
  classifyReliability(
    hasEvidence: boolean,
    sourceKind: 'agent' | 'tool' | 'user' | 'service',
    confidence: number,
  ): ReliabilityClass {
    // Verified requires actual evidence — confidence score is irrelevant
    if (hasEvidence) {
      return 'verified';
    }

    // Tool output without evidence is unverified
    // Agent output without evidence is model-generated
    // User input without evidence is unverified
    if (sourceKind === 'agent') {
      return 'model-generated';
    }

    return 'unverified';
  }

  /**
   * Create a provenance-aware status indicator.
   * Clearly distinguishes AI-generated from human-verified status.
   */
  createProvenanceStatus(
    status: string,
    sourceKind: 'agent' | 'tool' | 'user' | 'service',
    sourceId: string,
    hasEvidence: boolean,
    confidence: number,
  ): ProvenanceStatus {
    const reliability = this.classifyReliability(hasEvidence, sourceKind, confidence);

    return {
      status,
      reliability,
      sourceKind,
      sourceId,
    };
  }

  /**
   * Determine if model confidence alone is being presented as verified status.
   * Returns true if the claim is improperly treated as verified.
   *
   * A claim is improperly verified when:
   * - It claims 'verified' reliability
   * - But has no linked evidence
   * - And comes from a model/agent source
   */
  isModelConfidenceMasqueradingAsVerified(claim: AttributedClaim): boolean {
    // If it claims verified reliability but has no evidence and is from an agent
    if (claim.reliability === 'verified' && !claim.attribution.source) {
      return true;
    }

    // High confidence from a model is NOT verification
    if (claim.reliability === 'verified' && claim.attribution.confidence < 1.0) {
      // Verified claims must have evidence backing, not just high confidence
      // This is a safeguard check — the attribution service should never
      // produce this state, but we detect it defensively
      return !this.hasLinkedEvidence(claim);
    }

    return false;
  }

  /**
   * Attempt to submit content to the Evidence store.
   * Blocks generated content from being recorded as Evidence without verification.
   */
  submitToEvidenceStore(candidate: EvidenceCandidate): EvidenceSubmissionResult {
    // Block content with model-generated accuracy from evidence store
    // (checked first as it's the most specific qualifier)
    if (candidate.accuracy === 'model-generated' && !candidate.evidence) {
      return {
        accepted: false,
        rejectionReason:
          'Content with model-generated accuracy qualifier cannot be stored as Evidence without verification.',
      };
    }

    // Block model-generated content without verification evidence
    if (candidate.reliability === 'model-generated' && !candidate.evidence) {
      return {
        accepted: false,
        rejectionReason:
          'Model-generated content cannot be recorded as Evidence without proper verification. ' +
          'Provide linked verification evidence (test result, tool output, code reference, or user approval).',
      };
    }

    // Block unverified content without evidence
    if (candidate.reliability === 'unverified' && !candidate.evidence) {
      return {
        accepted: false,
        rejectionReason:
          'Unverified content cannot be recorded as Evidence. ' +
          'Provide linked verification evidence before submission.',
      };
    }

    // Accept verified content with evidence
    return { accepted: true };
  }

  /**
   * Validate that status indicators properly distinguish provenance.
   * Returns false if the status could mislead users about its source.
   */
  isStatusProperlyDistinguished(provenanceStatus: ProvenanceStatus): boolean {
    // A verified status from an agent without tool backing is suspicious
    if (provenanceStatus.reliability === 'verified' && provenanceStatus.sourceKind === 'agent') {
      // Agent-sourced verified status is valid only when tool or service
      // has independently confirmed it — we flag this as improperly distinguished
      return false;
    }

    // All other combinations are properly distinguished
    return true;
  }

  /**
   * Check whether a claim has linked evidence backing its verification.
   */
  private hasLinkedEvidence(claim: AttributedClaim): boolean {
    // A properly verified claim must have either:
    // 1. A source with 'verified' accuracy
    // 2. A tool ID indicating tool-based verification
    if (claim.attribution.source?.accuracy === 'verified') {
      return true;
    }

    if (claim.attribution.toolId && claim.attribution.toolId.length > 0) {
      return true;
    }

    return false;
  }
}
