/**
 * Kernel Sandbox — TypeScript wrapper over @neuronest/native-sandbox.
 *
 * Provides OS-level process confinement (Landlock/seccomp on Linux, Seatbelt
 * on macOS) with graceful degradation to standard child_process.spawn when
 * the native module is unavailable or the platform is unsupported.
 *
 * Profile registry:
 *   - off: No confinement
 *   - workspace: Project-scoped read/write, deny sensitive patterns
 *   - read-only: Read project, write only to temp directory
 *   - strict: Worktree-scoped write root, deny everything else
 *
 * Feature gate: `kernel_sandbox`
 *
 * Requirements: 9.3, 9.4, 9.7, 1.10, 1.11
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';

// ─── Types ──────────────────────────────────────────────────────

/** Command to spawn in a confined environment */
export interface SpawnCommand {
  /** Command to execute */
  command: string;
  /** Arguments to pass */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env: Record<string, string>;
}

/** Named sandbox profile with explicit path policies */
export interface SandboxProfile {
  /** Profile name */
  name: SandboxProfileName;
  /** Paths the process may read */
  readablePaths: string[];
  /** Paths the process may write */
  writablePaths: string[];
  /** Glob patterns that are always denied (override allows) */
  denyGlobs: string[];
  /** Whether child network access is permitted */
  allowChildNetwork: boolean;
}

/** Available profile identifiers */
export type SandboxProfileName = 'off' | 'workspace' | 'read-only' | 'strict';

/** Result metadata attached to execution traces */
export interface SandboxTraceMetadata {
  sandbox: 'available' | 'unavailable';
  profile: SandboxProfileName;
  reason?: string;
}

/** A child-process-like handle returned by spawnConfined */
export interface ChildProcessLike {
  /** Process ID (if available) */
  pid: number | undefined;
  /** Write to stdin */
  writeStdin(data: Buffer): void;
  /** Close stdin */
  closeStdin(): void;
  /** Read stdout (non-blocking, returns null if no data) */
  readStdout(): Buffer | null;
  /** Read stderr (non-blocking, returns null if no data) */
  readStderr(): Buffer | null;
  /** Wait for exit, returns exit code */
  wait(): Promise<number>;
  /** Kill the process */
  kill(signal?: number): void;
  /** Trace metadata about sandbox availability */
  traceMetadata: SandboxTraceMetadata;
}

/** The public KernelSandbox interface */
export interface KernelSandbox {
  /** Whether native kernel sandbox is supported on this platform */
  isSupported(): boolean;
  /** Spawn a process with the given profile confinement */
  spawnConfined(cmd: SpawnCommand, profile: SandboxProfile): ChildProcessLike;
}

// ─── Feature Gate Check ─────────────────────────────────────────

/**
 * Feature gate checker interface. Allows injection for testing.
 * In production, this is wired to the FeatureGateStore.
 */
export interface FeatureGateChecker {
  isEnabled(flag: string): boolean;
}

/** Default feature gate that always returns false (safe fallback) */
const defaultFeatureGate: FeatureGateChecker = {
  isEnabled: () => false,
};

// ─── Native Module Loading ──────────────────────────────────────

interface NativeSandboxModule {
  spawnConfined(opts: {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    profile: {
      readable_paths: string[];
      writable_paths: string[];
      deny_globs: string[];
      allow_child_network: boolean;
    };
  }): {
    pid: number;
    writeStdin(data: Buffer): number;
    closeStdin(): void;
    readStdout(): Buffer | null;
    readStderr(): Buffer | null;
    wait(): Promise<number>;
    kill(signal?: number): void;
  };
  __notSupported?: boolean;
  loadError?: string;
}

/** Result of attempting to load the native sandbox module */
export interface NativeLoadResult {
  module: NativeSandboxModule | null;
  error: string | null;
}

/** Attempt to load the native sandbox module */
export function loadNativeModule(): NativeLoadResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const native = require('@neuronest/native-sandbox') as NativeSandboxModule;
    if (native.__notSupported) {
      return { module: null, error: native.loadError || 'Platform not supported' };
    }
    return { module: native, error: null };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown native module load error';
    return { module: null, error: msg };
  }
}

// ─── Profile Registry ───────────────────────────────────────────

/** System temp directory — always allowed for writing (Req 9.7) */
const SYSTEM_TEMP_DIR = os.tmpdir();

/**
 * Build a profile from a named preset and context paths.
 *
 * Every profile except 'off' permits system temp directory writes (Req 9.7).
 */
export function buildProfile(
  name: SandboxProfileName,
  opts: {
    projectDir?: string;
    worktreeRoot?: string;
    additionalDenyGlobs?: string[];
  } = {},
): SandboxProfile {
  const { projectDir = process.cwd(), worktreeRoot, additionalDenyGlobs = [] } = opts;

  const baseDenyGlobs = [
    '**/*.pem',
    '**/*.key',
    '**/.env',
    '**/.env.*',
    '**/credentials.json',
    '**/secrets.json',
    ...additionalDenyGlobs,
  ];

  switch (name) {
    case 'off':
      return {
        name: 'off',
        readablePaths: ['/'],
        writablePaths: ['/'],
        denyGlobs: [],
        allowChildNetwork: true,
      };

    case 'workspace':
      return {
        name: 'workspace',
        readablePaths: [projectDir, '/usr', '/lib', '/bin', '/etc', SYSTEM_TEMP_DIR],
        writablePaths: [projectDir, SYSTEM_TEMP_DIR],
        denyGlobs: baseDenyGlobs,
        allowChildNetwork: true,
      };

    case 'read-only':
      return {
        name: 'read-only',
        readablePaths: [projectDir, '/usr', '/lib', '/bin', '/etc', SYSTEM_TEMP_DIR],
        writablePaths: [SYSTEM_TEMP_DIR],
        denyGlobs: baseDenyGlobs,
        allowChildNetwork: false,
      };

    case 'strict': {
      const writeRoot = worktreeRoot || projectDir;
      return {
        name: 'strict',
        readablePaths: [writeRoot, '/usr', '/lib', '/bin', '/etc', SYSTEM_TEMP_DIR],
        writablePaths: [writeRoot, SYSTEM_TEMP_DIR],
        denyGlobs: baseDenyGlobs,
        allowChildNetwork: false,
      };
    }
  }
}

// ─── Fallback: Standard child_process.spawn Wrapper ─────────────

function createFallbackHandle(cmd: SpawnCommand, profile: SandboxProfile): ChildProcessLike {
  const child: ChildProcess = spawn(cmd.command, cmd.args, {
    cwd: cmd.cwd,
    env: cmd.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Accumulate stdout/stderr for non-blocking reads
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  return {
    pid: child.pid,

    writeStdin(data: Buffer): void {
      child.stdin?.write(data);
    },

    closeStdin(): void {
      child.stdin?.end();
    },

    readStdout(): Buffer | null {
      if (stdoutChunks.length === 0) return null;
      const combined = Buffer.concat(stdoutChunks);
      stdoutChunks.length = 0;
      return combined;
    },

    readStderr(): Buffer | null {
      if (stderrChunks.length === 0) return null;
      const combined = Buffer.concat(stderrChunks);
      stderrChunks.length = 0;
      return combined;
    },

    wait(): Promise<number> {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null) {
          resolve(child.exitCode);
          return;
        }
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', reject);
      });
    },

    kill(signal?: number): void {
      child.kill(signal ? undefined : 'SIGTERM');
      if (signal) {
        try {
          process.kill(child.pid!, signal);
        } catch {
          // Process may already be dead
        }
      }
    },

    traceMetadata: {
      sandbox: 'unavailable',
      profile: profile.name,
      reason: 'Fallback: native sandbox not available',
    },
  };
}

// ─── KernelSandbox Implementation ───────────────────────────────

export class KernelSandboxImpl implements KernelSandbox {
  private nativeModule: NativeSandboxModule | null = null;
  private nativeLoadError: string | null = null;
  private featureGate: FeatureGateChecker;
  private loaded = false;
  private loader: () => NativeLoadResult;

  constructor(
    featureGate: FeatureGateChecker = defaultFeatureGate,
    loader?: () => NativeLoadResult,
  ) {
    this.featureGate = featureGate;
    this.loader = loader || loadNativeModule;
    this.loadNative();
  }

  private loadNative(): void {
    if (this.loaded) return;
    this.loaded = true;

    const result = this.loader();
    this.nativeModule = result.module;
    this.nativeLoadError = result.error;

    if (result.error) {
      // Log warning but do not prevent startup (Req 1.11)
      console.warn(`[KernelSandbox] Native module unavailable: ${result.error}`);
    }
  }

  /**
   * Whether native kernel-level confinement is supported on this platform
   * and the native module loaded successfully.
   */
  isSupported(): boolean {
    return this.nativeModule !== null && !this.nativeModule.__notSupported;
  }

  /**
   * Spawn a process with kernel-level confinement when available.
   *
   * Decision logic:
   *   1. If profile is 'off', use standard spawn (no confinement needed)
   *   2. If `kernel_sandbox` feature gate is disabled, fall back
   *   3. If native module is unsupported/unavailable, fall back
   *   4. Otherwise, use native confinement
   *
   * Fallback always records `sandbox: 'unavailable'` in trace (Req 9.3).
   */
  spawnConfined(cmd: SpawnCommand, profile: SandboxProfile): ChildProcessLike {
    // Profile 'off' means no confinement — always use standard spawn
    if (profile.name === 'off') {
      return this.spawnStandard(cmd, profile, 'Profile is off');
    }

    // Check feature gate (Req 1.10)
    if (!this.featureGate.isEnabled('kernel_sandbox')) {
      return this.spawnStandard(cmd, profile, 'Feature gate kernel_sandbox is disabled');
    }

    // Check native support (Req 1.11, 9.3)
    if (!this.isSupported()) {
      return this.spawnStandard(
        cmd,
        profile,
        this.nativeLoadError || 'Native sandbox not supported on this platform',
      );
    }

    // Use native confinement
    return this.spawnNative(cmd, profile);
  }

  /** Spawn using standard child_process.spawn (fallback path) */
  private spawnStandard(cmd: SpawnCommand, profile: SandboxProfile, reason: string): ChildProcessLike {
    const handle = createFallbackHandle(cmd, profile);
    // Override trace metadata with the specific reason
    (handle as { traceMetadata: SandboxTraceMetadata }).traceMetadata = {
      sandbox: 'unavailable',
      profile: profile.name,
      reason,
    };
    return handle;
  }

  /** Spawn using native kernel-level confinement */
  private spawnNative(cmd: SpawnCommand, profile: SandboxProfile): ChildProcessLike {
    const nativeHandle = this.nativeModule!.spawnConfined({
      command: cmd.command,
      args: cmd.args,
      cwd: cmd.cwd,
      env: cmd.env,
      profile: {
        readable_paths: profile.readablePaths,
        writable_paths: profile.writablePaths,
        deny_globs: profile.denyGlobs,
        allow_child_network: profile.allowChildNetwork,
      },
    });

    return {
      pid: nativeHandle.pid,

      writeStdin(data: Buffer): void {
        nativeHandle.writeStdin(data);
      },

      closeStdin(): void {
        nativeHandle.closeStdin();
      },

      readStdout(): Buffer | null {
        return nativeHandle.readStdout();
      },

      readStderr(): Buffer | null {
        return nativeHandle.readStderr();
      },

      wait(): Promise<number> {
        return nativeHandle.wait();
      },

      kill(signal?: number): void {
        nativeHandle.kill(signal);
      },

      traceMetadata: {
        sandbox: 'available',
        profile: profile.name,
      },
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────

let defaultInstance: KernelSandboxImpl | null = null;

/**
 * Get or create the default KernelSandbox instance.
 * Uses the provided feature gate checker or falls back to disabled.
 */
export function getKernelSandbox(featureGate?: FeatureGateChecker): KernelSandbox {
  if (!defaultInstance) {
    defaultInstance = new KernelSandboxImpl(featureGate || defaultFeatureGate);
  }
  return defaultInstance;
}

/**
 * Reset the singleton (for testing purposes only).
 */
export function resetKernelSandbox(): void {
  defaultInstance = null;
}

// ─── Profile Name Constants ─────────────────────────────────────

export const SANDBOX_PROFILES = {
  OFF: 'off' as const,
  WORKSPACE: 'workspace' as const,
  READ_ONLY: 'read-only' as const,
  STRICT: 'strict' as const,
};
