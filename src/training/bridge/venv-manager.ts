/**
 * VenvManager — Python virtual environment management for Training Bridge.
 *
 * Manages the lifecycle of a Python virtual environment used by the Unsloth Bridge
 * for model training operations. All subprocess operations use SafeExec
 * (no shell interpretation, argument arrays only).
 *
 * Responsibilities:
 *   - Create venv at `~/.neuronest/training/venv` (default)
 *   - Install training dependencies (Unsloth Core, torch, etc.)
 *   - Auto-detect existing venv and check for installed packages
 *   - Provide path to venv Python interpreter
 *
 * Requirements: 6.3, 6.4, 6.5
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import type { SafeExecResult } from '../../security/safe-exec.js';

// ─── Types ──────────────────────────────────────────────────────

/** Type signature for the SafeExec async function we depend on */
export type SafeExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string> },
) => Promise<SafeExecResult>;

export interface VenvManagerConfig {
  /** Path to the venv directory. Defaults to `~/.neuronest/training/venv` */
  venvPath?: string;
  /** Timeout in ms for venv creation (default: 120000) */
  createTimeoutMs?: number;
  /** Timeout in ms for pip install operations (default: 600000 — 10 min) */
  installTimeoutMs?: number;
  /** Timeout in ms for pip show/check operations (default: 30000) */
  checkTimeoutMs?: number;
  /** Additional pip packages to install alongside core dependencies */
  extraPackages?: string[];
}

export interface VenvStatus {
  /** Whether a valid venv exists at the configured path */
  exists: boolean;
  /** Whether Unsloth Core is installed in the venv */
  unslothInstalled: boolean;
  /** Path to the venv Python interpreter (if exists) */
  pythonPath: string | null;
  /** Path to pip in the venv (if exists) */
  pipPath: string | null;
}

// ─── Errors ─────────────────────────────────────────────────────

export class VenvCreationError extends Error {
  constructor(message: string, public readonly stderr: string) {
    super(message);
    this.name = 'VenvCreationError';
  }
}

export class DependencyInstallError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = 'DependencyInstallError';
  }
}

export class PythonNotFoundError extends Error {
  constructor() {
    super(
      'Python 3 not found on the system. Please install Python 3.10+ to use training features.',
    );
    this.name = 'PythonNotFoundError';
  }
}

// ─── Constants ──────────────────────────────────────────────────

/** Default venv location */
const DEFAULT_VENV_PATH = path.join(os.homedir(), '.neuronest', 'training', 'venv');

/** Default timeouts */
const DEFAULT_CREATE_TIMEOUT_MS = 120_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 600_000;
const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/** Core training dependencies to install */
const CORE_DEPENDENCIES = [
  'unsloth',
  'torch',
  'transformers',
  'datasets',
  'peft',
  'trl',
  'accelerate',
  'bitsandbytes',
];

// ─── VenvManager ────────────────────────────────────────────────

export class VenvManager {
  private readonly venvPath: string;
  private readonly createTimeoutMs: number;
  private readonly installTimeoutMs: number;
  private readonly checkTimeoutMs: number;
  private readonly extraPackages: string[];

  constructor(
    private readonly safeExec: SafeExecFn,
    config?: VenvManagerConfig,
  ) {
    this.venvPath = config?.venvPath ?? DEFAULT_VENV_PATH;
    this.createTimeoutMs = config?.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
    this.installTimeoutMs = config?.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    this.checkTimeoutMs = config?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    this.extraPackages = config?.extraPackages ?? [];
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Returns the path to the Python interpreter inside the venv.
   * On Windows uses `Scripts/python.exe`, on Unix uses `bin/python`.
   */
  getVenvPythonPath(): string {
    if (process.platform === 'win32') {
      return path.join(this.venvPath, 'Scripts', 'python.exe');
    }
    return path.join(this.venvPath, 'bin', 'python');
  }

  /**
   * Returns the path to pip inside the venv.
   * On Windows uses `Scripts/pip.exe`, on Unix uses `bin/pip`.
   */
  getVenvPipPath(): string {
    if (process.platform === 'win32') {
      return path.join(this.venvPath, 'Scripts', 'pip.exe');
    }
    return path.join(this.venvPath, 'bin', 'pip');
  }

  /**
   * Returns the configured venv directory path.
   */
  getVenvPath(): string {
    return this.venvPath;
  }

  /**
   * Checks whether a valid venv exists at the configured path.
   * Validates by checking that the Python interpreter file exists.
   */
  venvExists(): boolean {
    const pythonPath = this.getVenvPythonPath();
    try {
      return fs.existsSync(pythonPath);
    } catch {
      return false;
    }
  }

  /**
   * Check whether Unsloth Core is installed in the venv.
   * Uses `pip show unsloth` to verify installation.
   */
  async isUnslothInstalled(): Promise<boolean> {
    if (!this.venvExists()) {
      return false;
    }

    const pipPath = this.getVenvPipPath();
    try {
      const result = await this.safeExec(
        pipPath,
        ['show', 'unsloth'],
        { timeout: this.checkTimeoutMs },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns a comprehensive status of the venv.
   */
  async getStatus(): Promise<VenvStatus> {
    const exists = this.venvExists();
    const pythonPath = exists ? this.getVenvPythonPath() : null;
    const pipPath = exists ? this.getVenvPipPath() : null;
    const unslothInstalled = exists ? await this.isUnslothInstalled() : false;

    return {
      exists,
      unslothInstalled,
      pythonPath,
      pipPath,
    };
  }

  /**
   * Ensures a valid venv exists and has core dependencies installed.
   *
   * Steps:
   * 1. If venv doesn't exist, create it
   * 2. If Unsloth Core isn't installed, install all dependencies
   *
   * @returns The path to the venv Python interpreter
   * @throws {PythonNotFoundError} if Python 3 is not available on the system
   * @throws {VenvCreationError} if venv creation fails
   * @throws {DependencyInstallError} if dependency installation fails
   */
  async ensureVenv(): Promise<string> {
    if (!this.venvExists()) {
      await this.createVenv();
    }

    const unslothInstalled = await this.isUnslothInstalled();
    if (!unslothInstalled) {
      await this.installDependencies();
    }

    return this.getVenvPythonPath();
  }

  /**
   * Creates a new Python virtual environment at the configured path.
   *
   * Uses `python3 -m venv <path>` (or `python` on Windows) via SafeExec.
   * Creates parent directories if they don't exist.
   *
   * @throws {PythonNotFoundError} if Python 3 is not found
   * @throws {VenvCreationError} if venv creation fails
   */
  async createVenv(): Promise<void> {
    // Ensure parent directory exists
    const parentDir = path.dirname(this.venvPath);
    fs.mkdirSync(parentDir, { recursive: true });

    // Find a working Python interpreter on the system
    const systemPython = await this.findSystemPython();

    // Create the venv
    const result = await this.safeExec(
      systemPython,
      ['-m', 'venv', this.venvPath],
      { timeout: this.createTimeoutMs },
    );

    if (result.exitCode !== 0) {
      throw new VenvCreationError(
        `Failed to create virtual environment at ${this.venvPath}`,
        result.stderr,
      );
    }

    // Verify the venv was actually created
    if (!this.venvExists()) {
      throw new VenvCreationError(
        `Venv creation reported success but Python interpreter not found at expected path`,
        result.stderr,
      );
    }
  }

  /**
   * Installs core training dependencies into the venv via pip.
   *
   * Uses the venv's pip to install: unsloth, torch, transformers, datasets,
   * peft, trl, accelerate, bitsandbytes, and any configured extra packages.
   *
   * @throws {DependencyInstallError} if pip install fails
   */
  async installDependencies(): Promise<void> {
    if (!this.venvExists()) {
      throw new DependencyInstallError(
        'Cannot install dependencies: venv does not exist. Call createVenv() first.',
        '',
        1,
      );
    }

    const pipPath = this.getVenvPipPath();

    // Upgrade pip first to avoid issues with older pip versions
    const upgradeResult = await this.safeExec(
      pipPath,
      ['install', '--upgrade', 'pip'],
      { timeout: this.installTimeoutMs },
    );

    if (upgradeResult.exitCode !== 0) {
      // Non-fatal: continue with existing pip version
    }

    // Install core dependencies + extras
    const packages = [...CORE_DEPENDENCIES, ...this.extraPackages];
    const result = await this.safeExec(
      pipPath,
      ['install', ...packages],
      { timeout: this.installTimeoutMs },
    );

    if (result.exitCode !== 0) {
      throw new DependencyInstallError(
        `Failed to install training dependencies: ${result.stderr.slice(0, 500)}`,
        result.stderr,
        result.exitCode,
      );
    }
  }

  /**
   * Installs a specific package into the venv.
   *
   * @param packageName - The pip package name (with optional version specifier)
   * @throws {DependencyInstallError} if installation fails
   */
  async installPackage(packageName: string): Promise<void> {
    if (!this.venvExists()) {
      throw new DependencyInstallError(
        'Cannot install package: venv does not exist.',
        '',
        1,
      );
    }

    const pipPath = this.getVenvPipPath();
    const result = await this.safeExec(
      pipPath,
      ['install', packageName],
      { timeout: this.installTimeoutMs },
    );

    if (result.exitCode !== 0) {
      throw new DependencyInstallError(
        `Failed to install package "${packageName}": ${result.stderr.slice(0, 500)}`,
        result.stderr,
        result.exitCode,
      );
    }
  }

  /**
   * Checks whether a specific package is installed in the venv.
   *
   * @param packageName - The pip package name to check
   * @returns true if the package is installed, false otherwise
   */
  async isPackageInstalled(packageName: string): Promise<boolean> {
    if (!this.venvExists()) {
      return false;
    }

    const pipPath = this.getVenvPipPath();
    try {
      const result = await this.safeExec(
        pipPath,
        ['show', packageName],
        { timeout: this.checkTimeoutMs },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Finds a suitable Python 3 interpreter on the system.
   * Tries `python3` first, then `python`, validating the version is 3.x.
   *
   * @throws {PythonNotFoundError} if no suitable Python is found
   */
  private async findSystemPython(): Promise<string> {
    // Try python3 first (preferred on Unix)
    const python3 = await this.tryPythonCommand('python3');
    if (python3) {
      return 'python3';
    }

    // Try python (common on Windows, also works when python3 alias isn't set)
    const python = await this.tryPythonCommand('python');
    if (python) {
      return 'python';
    }

    throw new PythonNotFoundError();
  }

  /**
   * Tests whether a Python command is available and is version 3.x.
   *
   * @param command - The Python command to test (e.g., 'python3', 'python')
   * @returns true if the command exists and reports Python 3.x
   */
  private async tryPythonCommand(command: string): Promise<boolean> {
    try {
      const result = await this.safeExec(
        command,
        ['--version'],
        { timeout: this.checkTimeoutMs },
      );

      if (result.exitCode !== 0) {
        return false;
      }

      // Output is usually "Python 3.x.y"
      const versionOutput = (result.stdout + result.stderr).trim();
      return /Python\s+3\.\d+/.test(versionOutput);
    } catch {
      return false;
    }
  }
}
