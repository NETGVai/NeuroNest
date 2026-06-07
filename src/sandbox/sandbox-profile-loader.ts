/**
 * Sandbox Profile Loader — manages loading, validation, and hot-reloading
 * of `.sandbox-profile.json` configuration files.
 *
 * Provides declarative sandbox profile configuration with variable expansion,
 * file watching for hot-reload, and validation with graceful error handling.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import { readFileSync, existsSync, watch, type FSWatcher } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../events/event-bus.js';
import { logger } from '../utils/logger.js';

// ─── Interfaces ─────────────────────────────────────────────────

/**
 * Declarative sandbox profile defining filesystem, network, and syscall restrictions.
 */
export interface SandboxProfile {
  allowedReadPaths: string[];
  allowedWritePaths: string[];
  allowedNetworkHosts: string[]; // max 256 entries
  blockedSyscalls: string[];
}

/**
 * Raw profile schema as stored in `.sandbox-profile.json`.
 * Supports `${PROJECT_DIR}` and `${TEMP_DIR}` variable placeholders.
 */
export interface SandboxProfileRaw {
  allowedReadPaths?: unknown;
  allowedWritePaths?: unknown;
  allowedNetworkHosts?: unknown;
  blockedSyscalls?: unknown;
}

/**
 * Event emitted when a profile validation fails.
 */
export interface ProfileValidationErrorEvent {
  projectPath: string;
  reason: string;
  timestamp: number;
}

/**
 * Options for creating a SandboxProfileLoader instance.
 */
export interface SandboxProfileLoaderOptions {
  eventBus?: EventBus;
}

// ─── Constants ──────────────────────────────────────────────────

const PROFILE_FILENAME = '.sandbox-profile.json';
const MAX_NETWORK_HOSTS = 256;

/**
 * Regex for validating hostnames (RFC 1123).
 * Allows labels of 1-63 chars (alphanumeric + hyphens, not starting/ending with hyphen),
 * separated by dots, with total length up to 253 chars.
 */
const HOSTNAME_REGEX = /^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.[a-zA-Z0-9-]{1,63})*$/;

/**
 * Regex for validating IPv4 addresses.
 */
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

/**
 * Regex for validating IPv6 addresses (simplified — covers common forms).
 */
const IPV6_REGEX = /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}$|^(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}$|^(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}$|^[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}$|^::1$|^::$/;

// ─── Validation Helpers ─────────────────────────────────────────

/**
 * Validates that a hostname or IP address is valid.
 */
export function isValidHost(host: unknown): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
    return false;
  }

  // Check IPv4 first — if it looks like an IP (all digits and dots), validate as IP
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return IPV4_REGEX.test(host);
  }

  // Check if it looks like it could be an IPv4 with extra octets (e.g., 1.2.3.4.5)
  if (/^\d+(\.\d+){4,}$/.test(host)) {
    return false;
  }

  return HOSTNAME_REGEX.test(host) || IPV6_REGEX.test(host);
}

/**
 * Validates that a path is absolute after variable expansion.
 * Paths containing unexpanded variables (${...}) are invalid.
 */
export function isValidAbsolutePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }
  // After expansion, path must be absolute and not contain unexpanded variables
  if (path.includes('${')) {
    return false;
  }
  return isAbsolute(path);
}

/**
 * Expands `${PROJECT_DIR}` and `${TEMP_DIR}` variables in a path string.
 */
export function expandVariables(path: string, projectPath: string): string {
  return path
    .replace(/\$\{PROJECT_DIR\}/g, projectPath)
    .replace(/\$\{TEMP_DIR\}/g, tmpdir());
}

// ─── Default Profile ────────────────────────────────────────────

/**
 * Creates the default sandbox profile for a given project path.
 *
 * Default profile:
 * - Read: project directory + standard toolchain dirs (/usr/bin, /usr/local/bin)
 * - Write: project directory + system temp directory
 * - Network: localhost only
 * - Blocked syscalls: ptrace, mount, kexec_load
 */
export function createDefaultProfile(projectPath: string): SandboxProfile {
  return {
    allowedReadPaths: [projectPath, '/usr/bin', '/usr/local/bin'],
    allowedWritePaths: [projectPath, tmpdir()],
    allowedNetworkHosts: ['localhost'],
    blockedSyscalls: ['ptrace', 'mount', 'kexec_load'],
  };
}

// ─── SandboxProfileLoader ───────────────────────────────────────

/**
 * Manages loading, validation, and hot-reloading of sandbox profiles.
 *
 * Loads `.sandbox-profile.json` from the project root, validates all entries,
 * expands path variables, and watches for changes to hot-reload within 5 seconds.
 * On invalid profile: rejects the profile, retains the previous active profile,
 * and emits an error event on the EventBus.
 */
export class SandboxProfileLoader {
  private activeProfile: SandboxProfile | null = null;
  private activeProjectPath: string | null = null;
  private watcher: FSWatcher | null = null;
  private eventBus?: EventBus;
  private watchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SandboxProfileLoaderOptions = {}) {
    this.eventBus = options.eventBus;
  }

  /**
   * Load a sandbox profile from the project root.
   *
   * If `.sandbox-profile.json` exists, it is parsed, validated, and returned.
   * If the file does not exist, the default profile is returned.
   * If the file is invalid, the profile is rejected, the previous profile is retained,
   * and an error event is emitted.
   *
   * @param projectPath - Absolute path to the project root
   * @returns The loaded and validated SandboxProfile
   * @throws Error if projectPath is not absolute
   */
  loadProfile(projectPath: string): SandboxProfile {
    if (!isAbsolute(projectPath)) {
      throw new Error(`Project path must be absolute: ${projectPath}`);
    }

    const profilePath = join(projectPath, PROFILE_FILENAME);

    if (!existsSync(profilePath)) {
      const defaultProfile = createDefaultProfile(projectPath);
      this.activeProfile = defaultProfile;
      this.activeProjectPath = projectPath;
      logger.info('No .sandbox-profile.json found, using default profile', { projectPath });
      return defaultProfile;
    }

    const result = this.parseAndValidateProfile(profilePath, projectPath);

    if (result.valid) {
      this.activeProfile = result.profile;
      this.activeProjectPath = projectPath;
      return result.profile;
    }

    // Invalid profile: retain previous or use default
    this.emitValidationError(projectPath, result.reason);

    if (this.activeProfile) {
      logger.warn('Invalid profile, retaining previous active profile', {
        projectPath,
        reason: result.reason,
      });
      return this.activeProfile;
    }

    // No previous profile — use default
    const defaultProfile = createDefaultProfile(projectPath);
    this.activeProfile = defaultProfile;
    this.activeProjectPath = projectPath;
    return defaultProfile;
  }

  /**
   * Watch for profile changes and reload within 5 seconds.
   *
   * @param projectPath - Absolute path to the project root
   * @param onChange - Callback invoked with the new profile when it changes
   */
  watchProfile(projectPath: string, onChange: (profile: SandboxProfile) => void): void {
    if (!isAbsolute(projectPath)) {
      throw new Error(`Project path must be absolute: ${projectPath}`);
    }

    // Stop any existing watcher
    this.stopWatching();

    const profilePath = join(projectPath, PROFILE_FILENAME);

    try {
      this.watcher = watch(profilePath, { persistent: false }, (_eventType) => {
        // Debounce rapid file changes (e.g., editor save + format)
        if (this.watchDebounceTimer) {
          clearTimeout(this.watchDebounceTimer);
        }

        this.watchDebounceTimer = setTimeout(() => {
          this.watchDebounceTimer = null;
          this.handleProfileChange(projectPath, onChange);
        }, 200);
      });

      this.watcher.on('error', (err) => {
        logger.error('File watcher error', {
          profilePath,
          error: err.message,
        });
      });

      logger.info('Watching sandbox profile for changes', { profilePath });
    } catch (err) {
      logger.error('Failed to start profile watcher', {
        profilePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop watching for profile changes.
   */
  stopWatching(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      logger.info('Stopped watching sandbox profile');
    }
  }

  /**
   * Get the currently active profile.
   * Returns the default profile for the current project if none has been loaded.
   */
  getActiveProfile(): SandboxProfile {
    if (this.activeProfile) {
      return this.activeProfile;
    }

    // No profile loaded yet — return a generic default
    return createDefaultProfile(this.activeProjectPath ?? '/');
  }

  // ─── Private Methods ────────────────────────────────────────────

  /**
   * Handle a profile file change event.
   */
  private handleProfileChange(projectPath: string, onChange: (profile: SandboxProfile) => void): void {
    const profilePath = join(projectPath, PROFILE_FILENAME);

    if (!existsSync(profilePath)) {
      // File was deleted — apply default profile
      const defaultProfile = createDefaultProfile(projectPath);
      this.activeProfile = defaultProfile;
      onChange(defaultProfile);
      return;
    }

    const result = this.parseAndValidateProfile(profilePath, projectPath);

    if (result.valid) {
      this.activeProfile = result.profile;
      onChange(result.profile);
      logger.info('Sandbox profile reloaded successfully', { projectPath });
    } else {
      // Invalid profile: retain previous, emit error
      this.emitValidationError(projectPath, result.reason);
      logger.warn('Profile change rejected, retaining previous profile', {
        projectPath,
        reason: result.reason,
      });
    }
  }

  /**
   * Parse and validate a profile file.
   */
  private parseAndValidateProfile(
    profilePath: string,
    projectPath: string,
  ): { valid: true; profile: SandboxProfile } | { valid: false; reason: string } {
    let fileContent: string;
    try {
      fileContent = readFileSync(profilePath, 'utf-8');
    } catch (err) {
      return {
        valid: false,
        reason: `Cannot read profile file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let raw: SandboxProfileRaw;
    try {
      raw = JSON.parse(fileContent);
    } catch (err) {
      return {
        valid: false,
        reason: `Malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, reason: 'Profile must be a JSON object' };
    }

    // Validate and expand allowedReadPaths
    const readPathsResult = this.validatePaths(raw.allowedReadPaths, 'allowedReadPaths', projectPath);
    if (!readPathsResult.valid) {
      return { valid: false, reason: readPathsResult.reason };
    }

    // Validate and expand allowedWritePaths
    const writePathsResult = this.validatePaths(raw.allowedWritePaths, 'allowedWritePaths', projectPath);
    if (!writePathsResult.valid) {
      return { valid: false, reason: writePathsResult.reason };
    }

    // Validate allowedNetworkHosts
    const hostsResult = this.validateNetworkHosts(raw.allowedNetworkHosts);
    if (!hostsResult.valid) {
      return { valid: false, reason: hostsResult.reason };
    }

    // Validate blockedSyscalls
    const syscallsResult = this.validateSyscalls(raw.blockedSyscalls);
    if (!syscallsResult.valid) {
      return { valid: false, reason: syscallsResult.reason };
    }

    return {
      valid: true,
      profile: {
        allowedReadPaths: readPathsResult.paths,
        allowedWritePaths: writePathsResult.paths,
        allowedNetworkHosts: hostsResult.hosts,
        blockedSyscalls: syscallsResult.syscalls,
      },
    };
  }

  /**
   * Validate and expand path entries.
   * Each entry must be a string that, after variable expansion, is an absolute path.
   */
  private validatePaths(
    paths: unknown,
    fieldName: string,
    projectPath: string,
  ): { valid: true; paths: string[] } | { valid: false; reason: string } {
    if (paths === undefined || paths === null) {
      return { valid: true, paths: [] };
    }

    if (!Array.isArray(paths)) {
      return { valid: false, reason: `${fieldName} must be an array` };
    }

    const expanded: string[] = [];

    for (let i = 0; i < paths.length; i++) {
      const entry = paths[i];
      if (typeof entry !== 'string') {
        return { valid: false, reason: `${fieldName}[${i}] must be a string` };
      }

      const expandedPath = expandVariables(entry, projectPath);

      if (!isValidAbsolutePath(expandedPath)) {
        return {
          valid: false,
          reason: `${fieldName}[${i}] is not a valid absolute path after expansion: "${expandedPath}"`,
        };
      }

      expanded.push(expandedPath);
    }

    return { valid: true, paths: expanded };
  }

  /**
   * Validate network host entries.
   * Each entry must be a valid hostname or IP address. Max 256 entries.
   */
  private validateNetworkHosts(
    hosts: unknown,
  ): { valid: true; hosts: string[] } | { valid: false; reason: string } {
    if (hosts === undefined || hosts === null) {
      return { valid: true, hosts: [] };
    }

    if (!Array.isArray(hosts)) {
      return { valid: false, reason: 'allowedNetworkHosts must be an array' };
    }

    if (hosts.length > MAX_NETWORK_HOSTS) {
      return {
        valid: false,
        reason: `allowedNetworkHosts exceeds maximum of ${MAX_NETWORK_HOSTS} entries (got ${hosts.length})`,
      };
    }

    const validated: string[] = [];

    for (let i = 0; i < hosts.length; i++) {
      const entry = hosts[i];
      if (!isValidHost(entry)) {
        return {
          valid: false,
          reason: `allowedNetworkHosts[${i}] is not a valid hostname or IP address: "${String(entry)}"`,
        };
      }
      validated.push(entry);
    }

    return { valid: true, hosts: validated };
  }

  /**
   * Validate blocked syscall entries.
   * Each entry must be a non-empty string.
   */
  private validateSyscalls(
    syscalls: unknown,
  ): { valid: true; syscalls: string[] } | { valid: false; reason: string } {
    if (syscalls === undefined || syscalls === null) {
      return { valid: true, syscalls: [] };
    }

    if (!Array.isArray(syscalls)) {
      return { valid: false, reason: 'blockedSyscalls must be an array' };
    }

    const validated: string[] = [];

    for (let i = 0; i < syscalls.length; i++) {
      const entry = syscalls[i];
      if (typeof entry !== 'string' || entry.length === 0) {
        return {
          valid: false,
          reason: `blockedSyscalls[${i}] must be a non-empty string`,
        };
      }
      validated.push(entry);
    }

    return { valid: true, syscalls: validated };
  }

  /**
   * Emit a profile validation error event on the EventBus.
   */
  private emitValidationError(projectPath: string, reason: string): void {
    logger.error('Sandbox profile validation failed', { projectPath, reason });

    if (!this.eventBus) {
      return;
    }

    const eventData: ProfileValidationErrorEvent = {
      projectPath,
      reason,
      timestamp: Date.now(),
    };

    this.eventBus.publish('sandbox.profile.validation_error', {
      type: 'profile_validation_error',
      data: eventData,
    }).catch((err) => {
      logger.error('Failed to emit profile validation error event', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
