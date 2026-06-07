/**
 * Diff Manager — Tracks agent code changes and provides diff viewing.
 *
 * When agents modify files, the original content is stored so users can
 * see a proper diff and accept/reject changes per hunk.
 */

export interface FileDiff {
  id: string;
  projectId: string;
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  agentId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export class DiffManager {
  private diffs: Map<string, FileDiff> = new Map();

  /**
   * Record a file change made by an agent.
   */
  recordChange(projectId: string, filePath: string, originalContent: string, modifiedContent: string, agentId: string): FileDiff {
    const diff: FileDiff = {
      id: `diff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      projectId, filePath, originalContent, modifiedContent, agentId,
      status: 'pending', createdAt: Date.now(),
    };
    this.diffs.set(diff.id, diff);
    return diff;
  }

  /**
   * Get all pending diffs for a project.
   */
  getPendingDiffs(projectId: string): FileDiff[] {
    return Array.from(this.diffs.values()).filter(d => d.projectId === projectId && d.status === 'pending');
  }

  /**
   * Get a specific diff.
   */
  getDiff(diffId: string): FileDiff | null {
    return this.diffs.get(diffId) || null;
  }

  /**
   * Accept a diff (keep the modified content).
   */
  acceptDiff(diffId: string): boolean {
    const diff = this.diffs.get(diffId);
    if (!diff) return false;
    diff.status = 'accepted';
    return true;
  }

  /**
   * Reject a diff (revert to original content).
   */
  rejectDiff(diffId: string): { reverted: boolean; originalContent: string } | null {
    const diff = this.diffs.get(diffId);
    if (!diff) return null;
    diff.status = 'rejected';
    return { reverted: true, originalContent: diff.originalContent };
  }

  /**
   * Get all diffs (for history).
   */
  getAllDiffs(projectId: string, limit: number = 50): FileDiff[] {
    return Array.from(this.diffs.values())
      .filter(d => d.projectId === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * Clear old diffs.
   */
  clearOld(maxAge: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAge;
    for (const [id, diff] of this.diffs) {
      if (diff.createdAt < cutoff && diff.status !== 'pending') {
        this.diffs.delete(id);
      }
    }
  }
}
