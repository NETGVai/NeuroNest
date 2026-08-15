/**
 * CitationService — Attaches citations to response segments.
 * Each citation includes: source URI, version, position (line/col), confidence score.
 * Citations are verifiable (can navigate to source).
 *
 * Requirements: 17.4, 17.5
 */

import type {
  Citation,
  CitationPosition,
  AttachCitationInput,
  CitedResponseSegment,
} from './types';

/**
 * Generates a unique citation ID.
 */
function generateCitationId(): string {
  return `cit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Generates a unique segment ID.
 */
function generateSegmentId(): string {
  return `seg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class CitationService {
  private readonly segments: Map<string, CitedResponseSegment> = new Map();

  /**
   * Attach a citation to a response segment.
   * Creates a new segment if segmentId is not found, or appends to an existing one.
   *
   * @param segmentId - The segment to attach the citation to (or a new one is created)
   * @param content - The text content of the segment (used when creating new segments)
   * @param input - The citation data to attach
   * @returns The updated CitedResponseSegment
   */
  attachCitation(
    segmentId: string | undefined,
    content: string,
    input: AttachCitationInput
  ): CitedResponseSegment {
    this.validateCitationInput(input);

    const citation: Citation = {
      id: generateCitationId(),
      sourceUri: input.sourceUri,
      version: input.version,
      position: input.position,
      confidence: input.confidence,
      label: input.label,
    };

    const resolvedSegmentId = segmentId ?? generateSegmentId();
    const existing = this.segments.get(resolvedSegmentId);

    if (existing) {
      const updated: CitedResponseSegment = {
        segmentId: existing.segmentId,
        content: existing.content,
        citations: [...existing.citations, citation],
      };
      this.segments.set(resolvedSegmentId, updated);
      return updated;
    }

    const newSegment: CitedResponseSegment = {
      segmentId: resolvedSegmentId,
      content,
      citations: [citation],
    };
    this.segments.set(resolvedSegmentId, newSegment);
    return newSegment;
  }

  /**
   * Create a new cited response segment.
   */
  createSegment(content: string, citations: readonly AttachCitationInput[]): CitedResponseSegment {
    const segmentId = generateSegmentId();
    const builtCitations: Citation[] = citations.map(input => {
      this.validateCitationInput(input);
      return {
        id: generateCitationId(),
        sourceUri: input.sourceUri,
        version: input.version,
        position: input.position,
        confidence: input.confidence,
        label: input.label,
      };
    });

    const segment: CitedResponseSegment = {
      segmentId,
      content,
      citations: builtCitations,
    };
    this.segments.set(segmentId, segment);
    return segment;
  }

  /**
   * Get a segment by ID.
   */
  getSegment(segmentId: string): CitedResponseSegment | undefined {
    return this.segments.get(segmentId);
  }

  /**
   * Get all segments.
   */
  getAllSegments(): readonly CitedResponseSegment[] {
    return [...this.segments.values()];
  }

  /**
   * Get all citations across all segments.
   */
  getAllCitations(): readonly Citation[] {
    const all: Citation[] = [];
    for (const segment of this.segments.values()) {
      all.push(...segment.citations);
    }
    return all;
  }

  /**
   * Get citations for a specific source URI.
   */
  getCitationsForSource(sourceUri: string): readonly Citation[] {
    const results: Citation[] = [];
    for (const segment of this.segments.values()) {
      for (const citation of segment.citations) {
        if (citation.sourceUri === sourceUri) {
          results.push(citation);
        }
      }
    }
    return results;
  }

  /**
   * Verify that a citation is navigable (has required fields for navigation).
   */
  isNavigable(citation: Citation): boolean {
    return (
      citation.sourceUri.length > 0 &&
      citation.version.length > 0 &&
      this.isValidPosition(citation.position)
    );
  }

  /**
   * Get citations within a confidence threshold.
   */
  getCitationsAboveConfidence(threshold: number): readonly Citation[] {
    const results: Citation[] = [];
    for (const segment of this.segments.values()) {
      for (const citation of segment.citations) {
        if (citation.confidence >= threshold) {
          results.push(citation);
        }
      }
    }
    return results;
  }

  /**
   * Clear all segments and citations (useful for testing).
   */
  clear(): void {
    this.segments.clear();
  }

  // ─── Private helpers ──────────────────────────────────────────

  private validateCitationInput(input: AttachCitationInput): void {
    if (!input.sourceUri || input.sourceUri.trim() === '') {
      throw new Error('Citation sourceUri is required.');
    }

    if (!input.version || input.version.trim() === '') {
      throw new Error('Citation version is required.');
    }

    if (!this.isValidPosition(input.position)) {
      throw new Error('Citation position must have valid line and column (>= 0).');
    }

    if (typeof input.confidence !== 'number' || input.confidence < 0 || input.confidence > 1) {
      throw new Error('Citation confidence must be a number between 0 and 1.');
    }
  }

  private isValidPosition(position: CitationPosition): boolean {
    return (
      typeof position.line === 'number' &&
      typeof position.column === 'number' &&
      position.line >= 0 &&
      position.column >= 0
    );
  }
}
