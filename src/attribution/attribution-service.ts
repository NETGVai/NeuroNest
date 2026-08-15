/**
 * AttributionService — attaches provenance to every surfaced claim.
 *
 * Ensures:
 * - Every claim carries agent ID, model ID, tool ID, and confidence score
 * - Source URIs and versions are included when quoting/proposing code
 * - Accuracy qualifiers are attached (verified, model-generated, unverified, approximate)
 * - Model-generated prose never masquerades as verified evidence
 *
 * Requirements: 27.1, 27.2, 27.3, 27.4, 27.5, 27.6
 */

import type {
  AccuracyQualifier,
  Attribution,
  AttributedClaim,
  ReliabilityClass,
  SourceProvenance,
  VerificationEvidence,
} from './types';

/** Input for creating an attributed claim */
export interface CreateClaimInput {
  /** Unique ID for the claim */
  id: string;
  /** Content of the claim */
  content: string;
  /** Agent producing the claim */
  agentId: string;
  /** Model used */
  modelId: string;
  /** Tool used, if any */
  toolId?: string;
  /** Model confidence (0-1) */
  confidence: number;
  /** Source information when referencing code */
  source?: {
    uri: string;
    version?: string;
  };
  /** Optional linked evidence that verifies this claim */
  evidence?: VerificationEvidence;
}

export class AttributionService {
  /**
   * Create a fully attributed claim with provenance metadata.
   *
   * Never allows model-generated prose to be classified as 'verified'
   * unless supporting evidence is provided.
   */
  createAttributedClaim(input: CreateClaimInput): AttributedClaim {
    this.validateInput(input);

    const accuracy = this.deriveAccuracy(input);
    const reliability = this.classifyReliability(input);

    const source: SourceProvenance | undefined = input.source
      ? {
          uri: input.source.uri,
          version: input.source.version,
          accuracy,
        }
      : undefined;

    const attribution: Attribution = {
      agentId: input.agentId,
      modelId: input.modelId,
      toolId: input.toolId,
      confidence: input.confidence,
      source,
      timestamp: new Date().toISOString(),
    };

    return {
      id: input.id,
      content: input.content,
      attribution,
      reliability,
    };
  }

  /**
   * Attach source provenance to an existing attribution when code is quoted or proposed.
   * Enforces that source URI and version are present.
   */
  attachSourceProvenance(
    attribution: Attribution,
    uri: string,
    version: string,
    accuracy: AccuracyQualifier,
  ): Attribution {
    if (!uri || uri.trim().length === 0) {
      throw new Error('Source URI is required when attaching source provenance');
    }
    if (!version || version.trim().length === 0) {
      throw new Error('Source version is required when attaching source provenance');
    }

    return {
      ...attribution,
      source: { uri, version, accuracy },
    };
  }

  /**
   * Validate that an attribution has all required fields for a surfaced claim.
   * Returns true if the attribution is complete, false otherwise.
   */
  isCompleteAttribution(attribution: Attribution): boolean {
    return (
      typeof attribution.agentId === 'string' &&
      attribution.agentId.length > 0 &&
      typeof attribution.modelId === 'string' &&
      attribution.modelId.length > 0 &&
      typeof attribution.confidence === 'number' &&
      attribution.confidence >= 0 &&
      attribution.confidence <= 1 &&
      typeof attribution.timestamp === 'string' &&
      attribution.timestamp.length > 0
    );
  }

  /**
   * Validate that a code reference has proper source attribution.
   * Source URI and version must be present for code references.
   */
  hasCodeReferenceAttribution(attribution: Attribution): boolean {
    return (
      this.isCompleteAttribution(attribution) &&
      attribution.source !== undefined &&
      typeof attribution.source.uri === 'string' &&
      attribution.source.uri.length > 0 &&
      typeof attribution.source.version === 'string' &&
      attribution.source.version.length > 0
    );
  }

  /**
   * Derive accuracy qualifier based on the input.
   * Model confidence alone is never treated as 'verified'.
   */
  private deriveAccuracy(input: CreateClaimInput): AccuracyQualifier {
    // If there's linked verification evidence, it's verified
    if (input.evidence) {
      return 'verified';
    }

    // If there's a source URI (code reference), it can be approximate
    // but NOT verified without evidence
    if (input.source) {
      return 'approximate';
    }

    // Pure model output is always model-generated regardless of confidence
    return 'model-generated';
  }

  /**
   * Classify reliability of a claim.
   * Model confidence alone NEVER produces a 'verified' classification.
   */
  private classifyReliability(input: CreateClaimInput): ReliabilityClass {
    // Only verified when actual evidence exists
    if (input.evidence) {
      return 'verified';
    }

    // Without evidence, model output is model-generated
    // regardless of how high the confidence score is
    return 'model-generated';
  }

  /**
   * Validate input constraints.
   */
  private validateInput(input: CreateClaimInput): void {
    if (!input.id || input.id.trim().length === 0) {
      throw new Error('Claim ID is required');
    }
    if (!input.agentId || input.agentId.trim().length === 0) {
      throw new Error('Agent ID is required for attribution');
    }
    if (!input.modelId || input.modelId.trim().length === 0) {
      throw new Error('Model ID is required for attribution');
    }
    if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
      throw new Error('Confidence must be a number between 0 and 1');
    }
  }
}
