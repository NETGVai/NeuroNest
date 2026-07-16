/**
 * @neuronest/native-sandbox TypeScript declarations.
 *
 * Provides the spawn_confined napi function for kernel-level process confinement.
 */

export interface SandboxProfile {
  /** Paths the child process is allowed to read */
  readable_paths: string[];
  /** Paths the child process is allowed to write */
  writable_paths: string[];
  /** Glob patterns that are always denied (overrides allows) */
  deny_globs: string[];
  /** Whether the child process is allowed to create network connections */
  allow_child_network: boolean;
}

export interface ConfinedSpawnOptions {
  /** Command to execute */
  command: string;
  /** Arguments to pass to the command */
  args: string[];
  /** Working directory for the child process */
  cwd: string;
  /** Environment variables (key=value pairs) */
  env: Record<string, string>;
  /** Sandbox profile to apply */
  profile: SandboxProfile;
}

export interface ChildHandle {
  /** Process ID of the spawned child */
  pid: number;
  /** Write to the child's stdin (returns bytes written) */
  writeStdin(data: Buffer): number;
  /** Close the child's stdin */
  closeStdin(): void;
  /** Read available stdout data (non-blocking, returns null if no data) */
  readStdout(): Buffer | null;
  /** Read available stderr data (non-blocking, returns null if no data) */
  readStderr(): Buffer | null;
  /** Wait for the child to exit, returns exit code */
  wait(): Promise<number>;
  /** Send a signal to the child process */
  kill(signal?: number): void;
}

/**
 * Spawn a process confined by OS-level sandbox primitives.
 *
 * - Linux: Landlock filesystem rules + optional seccomp network filter
 * - macOS: Generated Seatbelt profile applied via sandbox-exec
 * - Windows: Throws NotSupported error (use TS fallback)
 *
 * @throws {Error} With code 'NOT_SUPPORTED' on unsupported platforms
 */
export function spawnConfined(opts: ConfinedSpawnOptions): ChildHandle;

/** Whether the native sandbox module loaded successfully */
export const __notSupported: boolean | undefined;

/** Load error message if the module failed to load */
export const loadError: string | undefined;
