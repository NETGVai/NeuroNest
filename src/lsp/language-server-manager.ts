/**
 * LanguageServerManager — Server lifecycle management for LSP Integration.
 *
 * Manages language server processes: auto-detects servers based on project
 * tech stack markers, starts on project open, restarts on crash with retry
 * logic, and stops on project close. Feature-gated behind `lsp_intelligence`.
 *
 * Follows NeuroNest's lazy-initialized TypeScript singleton pattern.
 *
 * Requirements: 13.1, 13.5, 13.6
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

// ─── Types ──────────────────────────────────────────────────────

/** Supported language identifiers */
export type SupportedLanguage = 'typescript' | 'python' | 'go' | 'rust' | 'java';

/** Health status of a language server */
export type ServerHealth = 'starting' | 'running' | 'crashed' | 'stopped' | 'restarting';

/** Configuration for detecting a language server */
export interface LanguageServerConfig {
  /** Language identifier */
  language: SupportedLanguage;
  /** File markers that indicate this language is used in the project */
  markers: string[];
  /** Command to start the language server */
  command: string;
  /** Arguments for the server process */
  args: string[];
  /** Optional project-level config files to respect */
  configFiles: string[];
}

/** Represents a managed language server instance */
export interface ManagedServer {
  /** Language this server supports */
  language: SupportedLanguage;
  /** Current health status */
  health: ServerHealth;
  /** Number of consecutive crash restarts */
  restartCount: number;
  /** Timestamp of last start */
  lastStartedAt: number | null;
  /** Timestamp of last crash */
  lastCrashedAt: number | null;
  /** Process reference (null if not running) */
  process: ChildProcess | null;
  /** The command used to start the server */
  command: string;
  /** Arguments used */
  args: string[];
}

/** Events emitted by the LanguageServerManager */
export interface LanguageServerManagerEvents {
  'server:started': { language: SupportedLanguage };
  'server:stopped': { language: SupportedLanguage };
  'server:crashed': { language: SupportedLanguage; restartCount: number };
  'server:restarting': { language: SupportedLanguage; attempt: number };
  'server:max-retries': { language: SupportedLanguage };
  'detection:complete': { detected: SupportedLanguage[] };
}

/** Configuration for the manager itself */
export interface LanguageServerManagerConfig {
  /** Maximum restart attempts before giving up (default: 3) */
  maxRestarts: number;
  /** Delay between restart attempts in ms (default: 1000) */
  restartDelayMs: number;
  /** Whether the feature is enabled via feature gate */
  enabled: boolean;
}

// ─── Constants ──────────────────────────────────────────────────

/** Default manager configuration */
export const DEFAULT_MANAGER_CONFIG: LanguageServerManagerConfig = {
  maxRestarts: 3,
  restartDelayMs: 1000,
  enabled: false,
};

/** Default language server configurations keyed by project markers */
export const DEFAULT_SERVER_CONFIGS: LanguageServerConfig[] = [
  {
    language: 'typescript',
    markers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    configFiles: ['tsconfig.json', 'jsconfig.json'],
  },
  {
    language: 'python',
    markers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    configFiles: ['pyrightconfig.json', 'pyproject.toml'],
  },
  {
    language: 'go',
    markers: ['go.mod', 'go.sum'],
    command: 'gopls',
    args: ['serve'],
    configFiles: ['go.mod'],
  },
  {
    language: 'rust',
    markers: ['Cargo.toml', 'Cargo.lock'],
    command: 'rust-analyzer',
    args: [],
    configFiles: ['Cargo.toml', 'rust-toolchain.toml'],
  },
  {
    language: 'java',
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.classpath'],
    command: 'jdtls',
    args: [],
    configFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  },
];

// ─── LanguageServerManager ──────────────────────────────────────

/**
 * LanguageServerManager — Manages language server lifecycles.
 *
 * Responsibilities:
 * - Auto-detect which language servers are needed based on project file markers
 * - Start language servers on project open
 * - Monitor health and restart on crash (up to maxRestarts times)
 * - Stop all servers on project close
 * - Respect existing project LSP configuration
 *
 * Feature-gated: when `lsp_intelligence` is disabled, all lifecycle actions
 * are no-ops and the manager remains completely inactive.
 *
 * Lazy-initialized singleton following NeuroNest's established patterns.
 *
 * Requirements: 13.1, 13.5, 13.6
 */
export class LanguageServerManager extends EventEmitter {
  private static instance: LanguageServerManager | null = null;

  private config: LanguageServerManagerConfig;
  private servers: Map<SupportedLanguage, ManagedServer> = new Map();
  private projectDir: string | null = null;
  private serverConfigs: LanguageServerConfig[];
  private active = false;

  /** Injectable file-existence checker (for testability) */
  private fileExists: (path: string) => Promise<boolean>;

  /** Injectable process spawner (for testability) */
  private processSpawner: (command: string, args: string[], cwd: string) => ChildProcess;

  private constructor(
    config?: Partial<LanguageServerManagerConfig>,
    deps?: {
      fileExists?: (path: string) => Promise<boolean>;
      processSpawner?: (command: string, args: string[], cwd: string) => ChildProcess;
      serverConfigs?: LanguageServerConfig[];
    },
  ) {
    super();
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config };
    this.serverConfigs = deps?.serverConfigs ?? DEFAULT_SERVER_CONFIGS;
    this.fileExists = deps?.fileExists ?? defaultFileExists;
    this.processSpawner = deps?.processSpawner ?? defaultProcessSpawner;
  }

  /**
   * Get or create the singleton instance.
   * Follows NeuroNest's lazy-initialized singleton pattern.
   */
  static getInstance(
    config?: Partial<LanguageServerManagerConfig>,
    deps?: {
      fileExists?: (path: string) => Promise<boolean>;
      processSpawner?: (command: string, args: string[], cwd: string) => ChildProcess;
      serverConfigs?: LanguageServerConfig[];
    },
  ): LanguageServerManager {
    if (!LanguageServerManager.instance) {
      LanguageServerManager.instance = new LanguageServerManager(config, deps);
    }
    return LanguageServerManager.instance;
  }

  /** Reset singleton (for testing) */
  static resetInstance(): void {
    if (LanguageServerManager.instance) {
      LanguageServerManager.instance.stopAll();
      LanguageServerManager.instance.removeAllListeners();
    }
    LanguageServerManager.instance = null;
  }

  // ─── Feature Gate Check ─────────────────────────────────────────

  /**
   * Check if the manager is enabled via feature gate.
   * When disabled, all lifecycle actions are no-ops.
   *
   * Requirements: 13.5
   */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Get current configuration (readonly copy) */
  getConfig(): Readonly<LanguageServerManagerConfig> {
    return { ...this.config };
  }

  /** Update configuration at runtime */
  updateConfig(config: Partial<LanguageServerManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ─── Auto-Detection ─────────────────────────────────────────────

  /**
   * Auto-detect language servers needed for the project based on file markers.
   * Checks for the presence of marker files (tsconfig.json, go.mod, etc.)
   * in the project root directory.
   *
   * Requirements: 13.1, 13.6
   *
   * @param projectDir - Project root directory path
   * @returns Array of detected languages
   */
  async detectLanguages(projectDir: string): Promise<SupportedLanguage[]> {
    if (!this.config.enabled) {
      return [];
    }

    const detected: SupportedLanguage[] = [];

    for (const serverConfig of this.serverConfigs) {
      const hasMarker = await this.checkMarkers(projectDir, serverConfig.markers);
      if (hasMarker) {
        detected.push(serverConfig.language);
      }
    }

    this.emit('detection:complete', { detected });
    return detected;
  }

  /**
   * Check if any marker file exists in the given directory.
   */
  private async checkMarkers(dir: string, markers: string[]): Promise<boolean> {
    for (const marker of markers) {
      const markerPath = join(dir, marker);
      if (await this.fileExists(markerPath)) {
        return true;
      }
    }
    return false;
  }

  // ─── Lifecycle: Start ───────────────────────────────────────────

  /**
   * Start all detected language servers for a project.
   * Called on project open.
   *
   * Requirements: 13.1, 13.5
   *
   * @param projectDir - Project root directory path
   * @returns Map of languages to their start success status
   */
  async startAll(projectDir: string): Promise<Map<SupportedLanguage, boolean>> {
    if (!this.config.enabled) {
      return new Map();
    }

    this.projectDir = projectDir;
    this.active = true;

    const detected = await this.detectLanguages(projectDir);
    const results = new Map<SupportedLanguage, boolean>();

    for (const language of detected) {
      const success = await this.startServer(language);
      results.set(language, success);
    }

    return results;
  }

  /**
   * Start a single language server.
   *
   * Requirements: 13.5, 13.6
   */
  async startServer(language: SupportedLanguage): Promise<boolean> {
    if (!this.config.enabled || !this.projectDir) {
      return false;
    }

    // Don't start if already running
    const existing = this.servers.get(language);
    if (existing && (existing.health === 'running' || existing.health === 'starting')) {
      return true;
    }

    const serverConfig = this.serverConfigs.find(c => c.language === language);
    if (!serverConfig) {
      return false;
    }

    const managed: ManagedServer = {
      language,
      health: 'starting',
      restartCount: existing?.restartCount ?? 0,
      lastStartedAt: Date.now(),
      lastCrashedAt: existing?.lastCrashedAt ?? null,
      process: null,
      command: serverConfig.command,
      args: [...serverConfig.args],
    };

    this.servers.set(language, managed);

    try {
      const process = this.processSpawner(
        serverConfig.command,
        serverConfig.args,
        this.projectDir,
      );

      managed.process = process;
      managed.health = 'running';

      // Monitor process for crashes
      process.on('exit', (code, signal) => {
        this.handleProcessExit(language, code, signal);
      });

      process.on('error', (err) => {
        this.handleProcessError(language, err);
      });

      this.emit('server:started', { language });
      return true;
    } catch (err) {
      managed.health = 'crashed';
      managed.lastCrashedAt = Date.now();
      return false;
    }
  }

  // ─── Lifecycle: Stop ────────────────────────────────────────────

  /**
   * Stop all language servers.
   * Called on project close.
   *
   * Requirements: 13.5
   */
  stopAll(): void {
    this.active = false;

    for (const [language] of this.servers) {
      this.stopServer(language);
    }
  }

  /**
   * Stop a single language server.
   *
   * Requirements: 13.5
   */
  stopServer(language: SupportedLanguage): void {
    const server = this.servers.get(language);
    if (!server) return;

    if (server.process && server.health !== 'stopped') {
      try {
        server.process.kill('SIGTERM');
      } catch {
        // Process may already be gone
      }
    }

    server.health = 'stopped';
    server.process = null;
    this.emit('server:stopped', { language });
  }

  // ─── Lifecycle: Restart on Crash ────────────────────────────────

  /**
   * Handle unexpected process exit (crash detection).
   * Implements restart logic with max retries.
   *
   * Requirements: 13.5
   */
  private handleProcessExit(language: SupportedLanguage, _code: number | null, _signal: string | null): void {
    const server = this.servers.get(language);
    if (!server) return;

    // If the server was explicitly stopped or manager is inactive, don't restart
    if (server.health === 'stopped' || !this.active) {
      return;
    }

    // Unexpected exit — process crashed
    server.health = 'crashed';
    server.lastCrashedAt = Date.now();
    server.process = null;
    server.restartCount++;

    this.emit('server:crashed', { language, restartCount: server.restartCount });

    // Attempt restart if under the retry limit
    if (server.restartCount <= this.config.maxRestarts) {
      this.scheduleRestart(language);
    } else {
      this.emit('server:max-retries', { language });
    }
  }

  /**
   * Handle process spawn error (e.g., command not found).
   */
  private handleProcessError(language: SupportedLanguage, _err: Error): void {
    const server = this.servers.get(language);
    if (!server) return;

    if (server.health === 'stopped' || !this.active) {
      return;
    }

    server.health = 'crashed';
    server.lastCrashedAt = Date.now();
    server.process = null;
    server.restartCount++;

    this.emit('server:crashed', { language, restartCount: server.restartCount });

    if (server.restartCount <= this.config.maxRestarts) {
      this.scheduleRestart(language);
    } else {
      this.emit('server:max-retries', { language });
    }
  }

  /**
   * Schedule a server restart after the configured delay.
   *
   * Requirements: 13.5
   */
  private scheduleRestart(language: SupportedLanguage): void {
    const server = this.servers.get(language);
    if (!server) return;

    server.health = 'restarting';
    this.emit('server:restarting', { language, attempt: server.restartCount });

    setTimeout(() => {
      // Only restart if still active and server hasn't been explicitly stopped
      if (this.active && server.health === 'restarting') {
        this.startServer(language);
      }
    }, this.config.restartDelayMs);
  }

  // ─── Health Monitoring ──────────────────────────────────────────

  /**
   * Get the health status of a specific language server.
   */
  getServerHealth(language: SupportedLanguage): ServerHealth | null {
    const server = this.servers.get(language);
    return server?.health ?? null;
  }

  /**
   * Get health statuses for all managed servers.
   */
  getAllServerHealth(): Map<SupportedLanguage, ServerHealth> {
    const statuses = new Map<SupportedLanguage, ServerHealth>();
    for (const [language, server] of this.servers) {
      statuses.set(language, server.health);
    }
    return statuses;
  }

  /**
   * Get detailed information about a managed server.
   */
  getServerInfo(language: SupportedLanguage): Omit<ManagedServer, 'process'> | null {
    const server = this.servers.get(language);
    if (!server) return null;
    const { process: _proc, ...info } = server;
    return info;
  }

  /**
   * Get all currently running server languages.
   */
  getRunningServers(): SupportedLanguage[] {
    const running: SupportedLanguage[] = [];
    for (const [language, server] of this.servers) {
      if (server.health === 'running') {
        running.push(language);
      }
    }
    return running;
  }

  /**
   * Check if a specific language server is available (running or starting).
   */
  isServerAvailable(language: SupportedLanguage): boolean {
    const server = this.servers.get(language);
    return server !== undefined && (server.health === 'running' || server.health === 'starting');
  }

  /**
   * Get the project directory this manager is operating on.
   */
  getProjectDir(): string | null {
    return this.projectDir;
  }

  /**
   * Check if the manager is currently active (project open).
   */
  get isActive(): boolean {
    return this.active;
  }

  // ─── Configuration Respect ──────────────────────────────────────

  /**
   * Read project-specific LSP configuration file content.
   * Used to pass configuration to language servers.
   *
   * Requirements: 13.6
   *
   * @param language - Language to read config for
   * @returns Configuration file content or null if no config found
   */
  async getProjectConfig(language: SupportedLanguage): Promise<string | null> {
    if (!this.projectDir) return null;

    const serverConfig = this.serverConfigs.find(c => c.language === language);
    if (!serverConfig) return null;

    for (const configFile of serverConfig.configFiles) {
      const configPath = join(this.projectDir, configFile);
      if (await this.fileExists(configPath)) {
        try {
          const content = await readFile(configPath, 'utf-8');
          return content;
        } catch {
          // File exists but can't be read — skip
        }
      }
    }

    return null;
  }
}

// ─── Default Implementations ────────────────────────────────────

/** Default file existence check using node:fs/promises */
async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Default process spawner using child_process.spawn */
function defaultProcessSpawner(command: string, args: string[], cwd: string): ChildProcess {
  return spawn(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
}
