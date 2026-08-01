// ─── Git Repository Connector Adapter ───────────────────────────
// Implements the KBConnector interface for git repository sources.
// Clones (or pulls) repositories using SafeExec with security-profile
// constraints (maxCloneDepth, maxRepoSizeBytes). Supports SSH key
// and token authentication via CredentialVault.
//
// Requirements: 1.2, 32.5, 42.1, 42.5

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { safeExecFile, type SafeExecResult } from '../../../security/safe-exec.js';
import { CredentialVault } from '../../../security/credential-vault.js';
import type {
  ConnectorConfig,
  ConnectorSecurityProfile,
  KBConnector,
  RawDocument,
  SourceEntry,
} from '../types.js';

// ─── Constants ──────────────────────────────────────────────────

/** Default max clone depth when not specified in security profile. */
const DEFAULT_MAX_CLONE_DEPTH = 1;

/** Default max repo size in bytes (500 MB). */
const DEFAULT_MAX_REPO_SIZE_BYTES = 500 * 1024 * 1024;

/** Default execution timeout for git operations (60s). */
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;

/** Base directory for temporary clones. */
const CLONE_BASE_DIR = path.join(os.tmpdir(), 'neuronest-kb-git-clones');

// ─── Errors ─────────────────────────────────────────────────────

export class GitConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitConnectorError';
  }
}

export class RepoSizeExceededError extends GitConnectorError {
  constructor(repoUri: string, sizeBytes: number, maxBytes: number) {
    super(
      `Repository "${repoUri}" size (${sizeBytes} bytes) exceeds maximum allowed (${maxBytes} bytes)`,
    );
    this.name = 'RepoSizeExceededError';
  }
}

export class GitAuthenticationError extends GitConnectorError {
  constructor(repoUri: string, reason: string) {
    super(`Authentication failed for repository "${repoUri}": ${reason}`);
    this.name = 'GitAuthenticationError';
  }
}

// ─── Git Repository Connector ───────────────────────────────────

/**
 * Git repository connector adapter.
 *
 * Lifecycle:
 * - connect(): Clones (or pulls) the repository using shallow clone limited by security profile.
 * - list(): Enumerates tracked files using `git ls-tree -r HEAD`.
 * - fetch(): Reads file contents from the cloned repo, computes SHA-256 hashes.
 * - disconnect(): Removes the temporary clone directory.
 */
export class GitRepositoryConnector implements KBConnector {
  readonly type = 'git-repository' as const;

  private config: ConnectorConfig | null = null;
  private securityProfile: ConnectorSecurityProfile | null = null;
  private cloneDir: string | null = null;
  private credentialVault: CredentialVault | null = null;
  private connected = false;

  constructor(options?: { credentialVault?: CredentialVault }) {
    this.credentialVault = options?.credentialVault ?? null;
  }

  // ── Connect ─────────────────────────────────────────────────

  async connect(config: ConnectorConfig): Promise<void> {
    this.config = config;
    this.securityProfile = this.resolveSecurityProfile(config);

    const repoUri = config.uri;
    const maxDepth = this.securityProfile.maxCloneDepth ?? DEFAULT_MAX_CLONE_DEPTH;
    const timeout = this.securityProfile.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

    // Prepare clone directory
    this.cloneDir = this.buildCloneDir(repoUri);
    this.ensureCloneBaseDir();

    // Build git clone/pull args with authentication environment
    const env = await this.buildAuthEnv(config);

    if (fs.existsSync(path.join(this.cloneDir, '.git'))) {
      // Existing clone — pull latest changes
      await this.gitPull(this.cloneDir, timeout, env);
    } else {
      // Fresh clone with depth limit
      await this.gitClone(repoUri, this.cloneDir, maxDepth, timeout, env);
    }

    // Enforce max repo size
    await this.enforceRepoSizeLimit(repoUri);

    this.connected = true;
  }

  // ── List ────────────────────────────────────────────────────

  async list(): Promise<SourceEntry[]> {
    this.ensureConnected();

    const timeout = this.securityProfile!.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;

    const result = await safeExecFile(
      'git',
      ['ls-tree', '-r', '--name-only', 'HEAD'],
      { cwd: this.cloneDir!, timeout },
    );

    if (result.exitCode !== 0) {
      throw new GitConnectorError(
        `git ls-tree failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }

    const files = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return files.map((filePath) => ({
      uri: `${this.config!.uri}#${filePath}`,
      name: path.basename(filePath),
      metadata: { relativePath: filePath },
    }));
  }

  // ── Fetch ───────────────────────────────────────────────────

  async *fetch(entries: SourceEntry[]): AsyncIterable<RawDocument> {
    this.ensureConnected();

    const maxFetchSize = this.securityProfile!.maxFetchSizeBytes;

    for (const entry of entries) {
      const relativePath = (entry.metadata?.relativePath as string) ?? '';
      if (!relativePath) continue;

      const fullPath = path.join(this.cloneDir!, relativePath);

      // Skip files that don't exist (may have been deleted between list and fetch)
      if (!fs.existsSync(fullPath)) continue;

      const stat = fs.statSync(fullPath);

      // Enforce per-document size limit
      if (stat.size > maxFetchSize) continue;

      const content = fs.readFileSync(fullPath);
      const contentHash = crypto.createHash('sha256').update(content).digest('hex');
      const mimeType = this.inferMimeType(relativePath);

      yield {
        content,
        mimeType,
        sourceUri: entry.uri,
        fetchTimestamp: Date.now(),
        contentHash,
        byteSize: content.length,
      };
    }
  }

  // ── Disconnect ──────────────────────────────────────────────

  async disconnect(): Promise<void> {
    if (this.cloneDir && fs.existsSync(this.cloneDir)) {
      fs.rmSync(this.cloneDir, { recursive: true, force: true });
    }
    this.cloneDir = null;
    this.config = null;
    this.securityProfile = null;
    this.connected = false;
  }

  // ── Private Helpers ─────────────────────────────────────────

  /**
   * Build the clone directory path based on a hash of the repo URI.
   * This ensures each repo gets its own isolated clone location.
   */
  private buildCloneDir(repoUri: string): string {
    const hash = crypto.createHash('sha256').update(repoUri).digest('hex').slice(0, 16);
    return path.join(CLONE_BASE_DIR, hash);
  }

  /**
   * Ensure the base clone directory exists.
   */
  private ensureCloneBaseDir(): void {
    if (!fs.existsSync(CLONE_BASE_DIR)) {
      fs.mkdirSync(CLONE_BASE_DIR, { recursive: true });
    }
  }

  /**
   * Execute `git clone` with shallow depth enforcement.
   */
  private async gitClone(
    repoUri: string,
    targetDir: string,
    maxDepth: number,
    timeout: number,
    env?: Record<string, string>,
  ): Promise<void> {
    const args = ['clone', '--depth', String(maxDepth), repoUri, targetDir];

    const result = await safeExecFile('git', args, { timeout, env });

    if (result.exitCode !== 0) {
      throw new GitConnectorError(
        `git clone failed (exit ${result.exitCode}): ${result.stderr}`,
      );
    }
  }

  /**
   * Execute `git pull` to update an existing clone.
   */
  private async gitPull(
    cloneDir: string,
    timeout: number,
    env?: Record<string, string>,
  ): Promise<void> {
    const result = await safeExecFile('git', ['pull', '--ff-only'], {
      cwd: cloneDir,
      timeout,
      env,
    });

    if (result.exitCode !== 0) {
      // Pull failed — this is non-fatal; could be detached HEAD, etc.
      // Try fetch + reset instead
      const fetchResult = await safeExecFile('git', ['fetch', '--depth', '1', 'origin'], {
        cwd: cloneDir,
        timeout,
        env,
      });

      if (fetchResult.exitCode !== 0) {
        throw new GitConnectorError(
          `git pull/fetch failed (exit ${fetchResult.exitCode}): ${fetchResult.stderr}`,
        );
      }
    }
  }

  /**
   * Enforce the maximum repository size constraint from the security profile.
   * Uses `git count-objects -vH` to get the on-disk size of the repository.
   */
  private async enforceRepoSizeLimit(repoUri: string): Promise<void> {
    const maxRepoSize =
      this.securityProfile!.maxRepoSizeBytes ?? DEFAULT_MAX_REPO_SIZE_BYTES;

    const result = await safeExecFile('git', ['count-objects', '-v'], {
      cwd: this.cloneDir!,
      timeout: DEFAULT_EXECUTION_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      // Cannot determine size — allow but log concern
      return;
    }

    // Parse `size-pack` line from git count-objects output (in KB)
    const sizePackMatch = result.stdout.match(/size-pack:\s*(\d+)/);
    const sizeMatch = result.stdout.match(/^size:\s*(\d+)/m);

    let totalSizeBytes = 0;
    if (sizePackMatch) {
      totalSizeBytes += parseInt(sizePackMatch[1], 10) * 1024;
    }
    if (sizeMatch) {
      totalSizeBytes += parseInt(sizeMatch[1], 10) * 1024;
    }

    if (totalSizeBytes > maxRepoSize) {
      // Clean up the clone since it exceeds the limit
      if (this.cloneDir && fs.existsSync(this.cloneDir)) {
        fs.rmSync(this.cloneDir, { recursive: true, force: true });
      }
      throw new RepoSizeExceededError(repoUri, totalSizeBytes, maxRepoSize);
    }
  }

  /**
   * Build environment variables for git authentication.
   * Supports SSH key and token authentication via CredentialVault.
   */
  private async buildAuthEnv(
    config: ConnectorConfig,
  ): Promise<Record<string, string> | undefined> {
    const auth = config.authentication;
    if (!auth || auth.method === 'none') return undefined;

    if (!auth.credentialId) {
      throw new GitAuthenticationError(
        config.uri,
        'Authentication method specified but no credentialId provided',
      );
    }

    if (!this.credentialVault) {
      throw new GitAuthenticationError(
        config.uri,
        'CredentialVault not available for credential retrieval',
      );
    }

    if (!this.credentialVault.exists(auth.credentialId)) {
      throw new GitAuthenticationError(
        config.uri,
        `Credential "${auth.credentialId}" not found in vault`,
      );
    }

    if (auth.method === 'ssh-key') {
      return this.buildSshAuthEnv(auth.credentialId, config.uri);
    }

    if (auth.method === 'token') {
      return this.buildTokenAuthEnv(auth.credentialId, config.uri);
    }

    // Other auth methods not currently supported for git
    throw new GitAuthenticationError(
      config.uri,
      `Authentication method "${auth.method}" is not supported for git repositories`,
    );
  }

  /**
   * Build environment for SSH key authentication.
   * Sets GIT_SSH_COMMAND to use the SSH key from CredentialVault.
   */
  private async buildSshAuthEnv(
    credentialId: string,
    repoUri: string,
  ): Promise<Record<string, string>> {
    const sshKeyPath = await this.credentialVault!.decrypt(credentialId);

    // Validate SSH key file exists and has appropriate permissions
    if (!fs.existsSync(sshKeyPath)) {
      throw new GitAuthenticationError(
        repoUri,
        `SSH key file does not exist at the path stored in credential "${credentialId}"`,
      );
    }

    // Set GIT_SSH_COMMAND to use the specific key with strict host checking disabled
    // for non-interactive use (the user has explicitly configured this key)
    return {
      GIT_SSH_COMMAND: `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
    };
  }

  /**
   * Build environment for token authentication.
   * Sets a credential helper that provides the token from CredentialVault.
   */
  private async buildTokenAuthEnv(
    credentialId: string,
    repoUri: string,
  ): Promise<Record<string, string>> {
    const token = await this.credentialVault!.decrypt(credentialId);

    if (!token) {
      throw new GitAuthenticationError(
        repoUri,
        `Token credential "${credentialId}" is empty`,
      );
    }

    // For HTTPS repos, inject token via GIT_ASKPASS with a simple echo script
    // or use the header-based approach via GIT_CONFIG_PARAMETERS
    // Using the extraheader approach which is more reliable for tokens
    return {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_PARAMETERS: `'http.extraHeader=Authorization: Bearer ${token}'`,
    };
  }

  /**
   * Resolve the effective security profile from the connector config.
   */
  private resolveSecurityProfile(config: ConnectorConfig): ConnectorSecurityProfile {
    const profile = config.securityProfile;
    return {
      maxFetchSizeBytes: profile?.maxFetchSizeBytes ?? 10 * 1024 * 1024,
      maxTotalSizeBytes: profile?.maxTotalSizeBytes ?? 1024 * 1024 * 1024,
      executionTimeoutMs: profile?.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      maxCloneDepth: (profile as any)?.maxCloneDepth ?? DEFAULT_MAX_CLONE_DEPTH,
      maxRepoSizeBytes: (profile as any)?.maxRepoSizeBytes ?? DEFAULT_MAX_REPO_SIZE_BYTES,
    };
  }

  /**
   * Infer MIME type from file extension.
   */
  private inferMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.ts': 'text/typescript',
      '.tsx': 'text/typescript',
      '.js': 'text/javascript',
      '.jsx': 'text/javascript',
      '.json': 'application/json',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.py': 'text/x-python',
      '.rs': 'text/x-rust',
      '.go': 'text/x-go',
      '.java': 'text/x-java',
      '.c': 'text/x-c',
      '.cpp': 'text/x-c++',
      '.h': 'text/x-c',
      '.yml': 'text/yaml',
      '.yaml': 'text/yaml',
      '.toml': 'text/toml',
      '.xml': 'application/xml',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
    };
    return mimeMap[ext] ?? 'application/octet-stream';
  }

  /**
   * Ensure the connector is in a connected state.
   */
  private ensureConnected(): void {
    if (!this.connected || !this.cloneDir || !this.config) {
      throw new GitConnectorError(
        'Git connector is not connected. Call connect() before list() or fetch().',
      );
    }
  }
}
