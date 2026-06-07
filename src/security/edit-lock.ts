/**
 * Directory-Scoped Edit Lock — gstack-inspired /freeze feature.
 *
 * During debugging, locks the agent to only modify files in the relevant
 * directory. Prevents drive-by edits to unrelated code.
 * The lock is advisory — it's checked before file operations and
 * returns a warning/block if the path is outside the locked scope.
 */

export interface EditLock {
  id: string;
  projectId: string;
  lockedPath: string; // The directory the agent is allowed to edit
  reason: string;
  createdAt: number;
  createdBy: string; // 'user' | 'auto' | agentId
}

export interface EditLockCheckResult {
  allowed: boolean;
  reason?: string;
  lockedPath?: string;
}

export class EditLockManager {
  private locks: Map<string, EditLock> = new Map(); // projectId -> lock

  /**
   * Freeze edits to a specific directory for a project.
   */
  freeze(projectId: string, lockedPath: string, reason: string = 'Manual freeze', createdBy: string = 'user'): EditLock {
    const lock: EditLock = {
      id: `lock_${Date.now().toString(36)}`,
      projectId,
      lockedPath: this.normalizePath(lockedPath),
      reason,
      createdAt: Date.now(),
      createdBy,
    };
    this.locks.set(projectId, lock);
    return lock;
  }

  /**
   * Remove the edit lock for a project.
   */
  unfreeze(projectId: string): boolean {
    return this.locks.delete(projectId);
  }

  /**
   * Check if a file path is allowed to be edited.
   */
  checkEdit(projectId: string, filePath: string): EditLockCheckResult {
    const lock = this.locks.get(projectId);
    if (!lock) {
      return { allowed: true };
    }

    const normalizedPath = this.normalizePath(filePath);
    const normalizedLock = lock.lockedPath;

    // Allow if the file is within the locked directory
    if (normalizedPath.startsWith(normalizedLock) || normalizedPath === normalizedLock) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Edit blocked: file "${filePath}" is outside the locked scope "${lock.lockedPath}". Reason: ${lock.reason}`,
      lockedPath: lock.lockedPath,
    };
  }

  /**
   * Get the current lock for a project.
   */
  getLock(projectId: string): EditLock | null {
    return this.locks.get(projectId) || null;
  }

  /**
   * Get all active locks.
   */
  getAllLocks(): EditLock[] {
    return Array.from(this.locks.values());
  }

  /**
   * Check if a project has an active lock.
   */
  isLocked(projectId: string): boolean {
    return this.locks.has(projectId);
  }

  private normalizePath(p: string): string {
    // Normalize path separators and remove trailing slash
    return p.replace(/\\/g, '/').replace(/\/+$/, '');
  }
}
