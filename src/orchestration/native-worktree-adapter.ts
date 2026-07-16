/**
 * NativeWorktreeAdapter — Adapter bridging the native fast-worktree module
 * with the feature gate system for use in worktree-isolation.ts.
 *
 * When the `fast_worktree` feature gate is enabled AND the native module
 * loaded successfully, delegates worktree operations to libgit2. Otherwise,
 * signals unavailability so callers fall back to shell git commands.
 *
 * Requirements: 13.2, 13.3, 13.4
 */

// ─── Types ──────────────────────────────────────────────────────

export interface NativeWorktreeResult {
  worktreePath: string;
  worktreeId: string;
  branch: string;
  native: boolean;
}

export interface NativeGcResult {
  removed: number;
  freedBytes: number;
  skipped: number;
}

export interface WorktreeCreationMetadata {
  engine: 'native' | 'shell';
  method: 'libgit2' | 'child_process';
  sourceRef: string;
  dirty: boolean;
  durationMs: number;
}

/** Interface matching the native module's exports */
interface NativeFastWorktreeModule {
  __notSupported?: boolean;
  loadError?: string;
  createWorktree(repoPath: string, worktreeId: string, baseBranch: string): NativeWorktreeResult;
  removeWorktree(repoPath: string, worktreeId: string): void;
  promoteWorktree(worktreeDir: string, targetDir: string): void;
  collectGarbage(baseDir: string, ttlSeconds: number): NativeGcResult;
}

// ─── Module Loading ─────────────────────────────────────────────

let nativeModule: NativeFastWorktreeModule | null = null;
let moduleLoadAttempted = false;
let moduleLoadError: string | undefined;

/**
 * Attempts to load the native fast-worktree module.
 * Returns the module if loaded successfully, null otherwise.
 * Caches the result after the first attempt.
 */
function loadNativeModule(): NativeFastWorktreeModule | null {
  if (moduleLoadAttempted) {
    return nativeModule;
  }

  moduleLoadAttempted = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@neuronest/native-fast-worktree') as NativeFastWorktreeModule;

    if (mod.__notSupported) {
      moduleLoadError = mod.loadError || 'Native module not supported on this platform';
      nativeModule = null;
      return null;
    }

    nativeModule = mod;
    return mod;
  } catch (err: unknown) {
    moduleLoadError = err instanceof Error ? err.message : String(err);
    nativeModule = null;
    return null;
  }
}

// ─── NativeWorktreeAdapter ──────────────────────────────────────

export class NativeWorktreeAdapter {
  private featureGateEnabled: boolean;

  /**
   * @param isFeatureGateEnabled - Function or boolean indicating whether
   * the `fast_worktree` feature gate is currently enabled.
   */
  constructor(isFeatureGateEnabled: boolean | (() => boolean) = false) {
    this.featureGateEnabled = typeof isFeatureGateEnabled === 'function'
      ? isFeatureGateEnabled()
      : isFeatureGateEnabled;
  }

  /**
   * Check whether native worktree operations are available.
   * Both the feature gate must be enabled AND the native module must load.
   */
  isAvailable(): boolean {
    if (!this.featureGateEnabled) {
      return false;
    }
    const mod = loadNativeModule();
    return mod !== null;
  }

  /**
   * Get the reason native worktree is unavailable.
   */
  getUnavailableReason(): string | undefined {
    if (!this.featureGateEnabled) {
      return 'fast_worktree feature gate is disabled';
    }
    loadNativeModule();
    return moduleLoadError;
  }

  /**
   * Create a worktree using the native libgit2 implementation.
   * Only call when isAvailable() returns true.
   */
  createWorktree(repoPath: string, worktreeId: string, baseBranch: string): NativeWorktreeResult {
    const mod = loadNativeModule();
    if (!mod) {
      throw new Error('Native fast-worktree module not available');
    }
    return mod.createWorktree(repoPath, worktreeId, baseBranch);
  }

  /**
   * Remove a worktree using the native libgit2 implementation.
   * Only call when isAvailable() returns true.
   */
  removeWorktree(repoPath: string, worktreeId: string): void {
    const mod = loadNativeModule();
    if (!mod) {
      throw new Error('Native fast-worktree module not available');
    }
    mod.removeWorktree(repoPath, worktreeId);
  }

  /**
   * Promote (atomic rename) a worktree directory into the target.
   * Only call when isAvailable() returns true.
   */
  promoteWorktree(worktreeDir: string, targetDir: string): void {
    const mod = loadNativeModule();
    if (!mod) {
      throw new Error('Native fast-worktree module not available');
    }
    mod.promoteWorktree(worktreeDir, targetDir);
  }

  /**
   * Run garbage collection on stale worktrees.
   * Only call when isAvailable() returns true.
   */
  collectGarbage(baseDir: string, ttlSeconds: number): NativeGcResult {
    const mod = loadNativeModule();
    if (!mod) {
      throw new Error('Native fast-worktree module not available');
    }
    return mod.collectGarbage(baseDir, ttlSeconds);
  }

  /**
   * Update the feature gate state (e.g., when gate is toggled at runtime).
   */
  setFeatureGateEnabled(enabled: boolean): void {
    this.featureGateEnabled = enabled;
  }
}

/**
 * Reset module-level load state. Used in tests only.
 * @internal
 */
export function _resetModuleLoadState(): void {
  nativeModule = null;
  moduleLoadAttempted = false;
  moduleLoadError = undefined;
}
