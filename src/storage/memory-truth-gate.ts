/**
 * Memory Truth Gate — prevents contradiction of primary truths.
 *
 * Primary truths are authoritative facts from steering files and project
 * configuration that must never be contradicted or lost during memory
 * management. This gate validates new memories against established truths
 * and tags steering-file entries as immutable primary truth.
 */

import type { ProjectMemory } from './project-memory.js';

export class MemoryTruthGate {
  constructor(private db: any) {}

  /**
   * Tag a memory entry as primary truth (from steering files).
   * Primary truth entries are immune to decay and summarization.
   */
  tagAsPrimaryTruth(memoryId: string): void {
    this.db.prepare(
      'UPDATE project_memories SET source = ?, confidence = 1.0 WHERE id = ?'
    ).run('primary_truth', memoryId);
  }

  /**
   * Load all primary truth entries for a project.
   */
  getPrimaryTruths(projectId: string): ProjectMemory[] {
    return this.db.prepare(
      'SELECT * FROM project_memories WHERE project_id = ? AND source = ?'
    ).all(projectId, 'primary_truth');
  }

  /**
   * Validate that a new memory does not contradict primary truth.
   * Uses simple keyword overlap + negation detection.
   */
  validateAgainstTruth(projectId: string, newContent: string): { valid: boolean; conflict?: string } {
    const truths = this.getPrimaryTruths(projectId);
    for (const truth of truths) {
      if (this.detectContradiction(truth.content, newContent)) {
        return { valid: false, conflict: truth.content };
      }
    }
    return { valid: true };
  }

  /**
   * Detect if a candidate statement contradicts a truth statement.
   * Simple heuristic: if candidate contains negation of key terms in truth.
   *
   * Extracts key terms (words longer than 4 characters) from the truth,
   * then checks if the candidate contains any negation pattern followed
   * by those key terms.
   */
  detectContradiction(truth: string, candidate: string): boolean {
    const truthTerms = truth.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const candidateLower = candidate.toLowerCase();
    const negationPatterns = ['not ', 'never ', "don't ", "doesn't ", "isn't ", "aren't ", "won't "];

    for (const term of truthTerms) {
      for (const neg of negationPatterns) {
        if (candidateLower.includes(neg + term)) return true;
      }
    }
    return false;
  }
}
