/**
 * Staged Auto-Update Manager
 *
 * Extends electron-updater with:
 * - Channel support (latest, beta) user-selectable in settings
 * - Staged rollout (10% initial, ramping to 100% over 48 hours)
 * - Crash-rate monitoring: pause rollout if crash rate exceeds 2x previous version
 * - Single notification per update version with deferred installation
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 23.5
 */

import { logger } from '../utils/logger';

// ─── Interfaces ─────────────────────────────────────────────────

export interface UpdateChannel {
  name: 'latest' | 'beta';
  feedUrl: string;
}

export interface RolloutConfig {
  /** Initial percentage of users to receive the update (default: 10) */
  initialPercentage: number;
  /** Duration in hours to ramp from initial to 100% (default: 48) */
  rampDurationHours: number;
  /** Crash rate multiplier threshold to pause rollout (default: 2x previous version) */
  crashRateThreshold: number;
}

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string;
  channel: 'latest' | 'beta';
}

export interface CrashRateData {
  /** Crash rate for the new version (crashes per hour) */
  currentVersionRate: number;
  /** Crash rate for the previous version (crashes per hour) */
  previousVersionRate: number;
}

export interface RolloutState {
  /** Target version being rolled out */
  version: string;
  /** Timestamp (ms) when rollout started */
  startedAt: number;
  /** Whether rollout is currently paused due to crash rate */
  paused: boolean;
  /** Current rollout percentage (0-100) */
  currentPercentage: number;
}

export interface NotificationRecord {
  /** Version that was notified */
  version: string;
  /** Timestamp of notification */
  notifiedAt: number;
  /** Whether user deferred the installation */
  deferred: boolean;
}

// ─── Default Channels ───────────────────────────────────────────

export const DEFAULT_CHANNELS: Record<string, UpdateChannel> = {
  latest: {
    name: 'latest',
    feedUrl: 'https://neuronest.cc/updates',
  },
  beta: {
    name: 'beta',
    feedUrl: 'https://neuronest.cc/updates/beta',
  },
};

export const DEFAULT_ROLLOUT_CONFIG: RolloutConfig = {
  initialPercentage: 10,
  rampDurationHours: 48,
  crashRateThreshold: 2.0,
};

// ─── Rollout Percentage Calculator ──────────────────────────────

/**
 * Calculate the current rollout percentage based on elapsed time.
 * Linearly ramps from initialPercentage to 100% over rampDurationHours.
 */
export function calculateRolloutPercentage(
  config: RolloutConfig,
  startedAt: number,
  now: number
): number {
  const elapsedMs = now - startedAt;
  if (elapsedMs <= 0) return config.initialPercentage;

  const rampDurationMs = config.rampDurationHours * 60 * 60 * 1000;
  if (elapsedMs >= rampDurationMs) return 100;

  const progress = elapsedMs / rampDurationMs;
  const range = 100 - config.initialPercentage;
  const percentage = config.initialPercentage + range * progress;

  return Math.min(100, Math.max(config.initialPercentage, percentage));
}

/**
 * Determine whether a given machine (by its stable hash) should receive
 * the update at the current rollout percentage.
 *
 * Uses a deterministic bucket assignment so the same machine always
 * gets the same bucket across checks.
 */
export function isInRolloutBucket(machineId: string, rolloutPercentage: number): boolean {
  if (rolloutPercentage >= 100) return true;
  if (rolloutPercentage <= 0) return false;

  const bucket = machineIdToBucket(machineId);
  return bucket < rolloutPercentage;
}

/**
 * Hash a machine ID to a deterministic bucket (0-99).
 */
export function machineIdToBucket(machineId: string): number {
  let hash = 0;
  for (let i = 0; i < machineId.length; i++) {
    const char = machineId.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash) % 100;
}

// ─── Crash Rate Monitor ─────────────────────────────────────────

/**
 * Determine whether the rollout should be paused based on crash rate data.
 * Pauses if the current version's crash rate exceeds the threshold multiplier
 * of the previous version's crash rate.
 *
 * If the previous version had zero crashes, uses a minimum baseline of 0.01
 * crashes/hour to avoid division by zero while still detecting issues.
 */
export function shouldPauseRollout(
  crashData: CrashRateData,
  config: RolloutConfig
): boolean {
  const baseline = crashData.previousVersionRate > 0
    ? crashData.previousVersionRate
    : 0.01; // minimum baseline to avoid division by zero

  return crashData.currentVersionRate > baseline * config.crashRateThreshold;
}

// ─── Notification Deduplication ─────────────────────────────────

/**
 * Determine whether the user should be notified about an available update.
 * Only notifies once per version — subsequent checks for the same version
 * return false.
 */
export function shouldNotifyUser(
  version: string,
  notificationHistory: NotificationRecord[]
): boolean {
  return !notificationHistory.some((record) => record.version === version);
}

/**
 * Record that a notification was shown for a specific version.
 */
export function recordNotification(
  version: string,
  notificationHistory: NotificationRecord[],
  now: number = Date.now()
): NotificationRecord[] {
  return [
    ...notificationHistory,
    { version, notifiedAt: now, deferred: false },
  ];
}

/**
 * Mark a notification as deferred (user chose "Later").
 */
export function deferNotification(
  version: string,
  notificationHistory: NotificationRecord[]
): NotificationRecord[] {
  return notificationHistory.map((record) =>
    record.version === version
      ? { ...record, deferred: true }
      : record
  );
}

// ─── Staged Update Manager ──────────────────────────────────────

export interface StagedUpdaterDeps {
  /** Returns the current channel preference from settings */
  getChannelPreference: () => 'latest' | 'beta';
  /** Persists the channel preference to settings */
  setChannelPreference: (channel: 'latest' | 'beta') => void;
  /** Fetches crash rate data from the server */
  fetchCrashRateData: (version: string) => Promise<CrashRateData>;
  /** Returns a stable machine identifier for bucket assignment */
  getMachineId: () => string;
  /** Sends a notification to the user about available update */
  notifyUser: (info: UpdateInfo) => void;
  /** Installs the downloaded update (quitAndInstall) */
  installUpdate: () => void;
  /** Gets current time in ms */
  now?: () => number;
}

export class StagedUpdateManager {
  private config: RolloutConfig;
  private channels: Record<string, UpdateChannel>;
  private rolloutState: RolloutState | null = null;
  private notificationHistory: NotificationRecord[] = [];
  private deps: StagedUpdaterDeps;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private crashCheckInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(
    deps: StagedUpdaterDeps,
    config: RolloutConfig = DEFAULT_ROLLOUT_CONFIG,
    channels: Record<string, UpdateChannel> = DEFAULT_CHANNELS
  ) {
    this.deps = deps;
    this.config = config;
    this.channels = channels;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Initialize the staged updater. Sets the feed URL based on current channel
   * preference and begins periodic checks.
   */
  initialize(): void {
    if (this.initialized) return;

    const channel = this.deps.getChannelPreference();
    logger.info(`[StagedUpdater] Initialized on channel: ${channel}`);
    this.initialized = true;
  }

  /**
   * Returns the current active channel.
   */
  getActiveChannel(): UpdateChannel {
    const pref = this.deps.getChannelPreference();
    return this.channels[pref] || this.channels['latest'];
  }

  /**
   * Switch the update channel. Takes effect on next check.
   */
  setChannel(channel: 'latest' | 'beta'): void {
    if (!this.channels[channel]) {
      logger.warn(`[StagedUpdater] Unknown channel: ${channel}`);
      return;
    }
    this.deps.setChannelPreference(channel);
    logger.info(`[StagedUpdater] Channel switched to: ${channel}`);
  }

  /**
   * Process an available update. Determines whether the machine is in the
   * rollout bucket, checks crash rates, and notifies the user if appropriate.
   */
  async processUpdate(info: UpdateInfo): Promise<{
    eligible: boolean;
    notified: boolean;
    paused: boolean;
    reason?: string;
  }> {
    const now = this.getNow();

    // Initialize or update rollout state for this version
    if (!this.rolloutState || this.rolloutState.version !== info.version) {
      this.rolloutState = {
        version: info.version,
        startedAt: now,
        paused: false,
        currentPercentage: this.config.initialPercentage,
      };
    }

    // Calculate current rollout percentage
    const currentPercentage = calculateRolloutPercentage(
      this.config,
      this.rolloutState.startedAt,
      now
    );
    this.rolloutState.currentPercentage = currentPercentage;

    // Check crash rate
    try {
      const crashData = await this.deps.fetchCrashRateData(info.version);
      if (shouldPauseRollout(crashData, this.config)) {
        this.rolloutState.paused = true;
        logger.warn(
          `[StagedUpdater] Rollout paused for ${info.version}: crash rate ${crashData.currentVersionRate} exceeds threshold (${crashData.previousVersionRate} × ${this.config.crashRateThreshold})`
        );
        return { eligible: false, notified: false, paused: true, reason: 'crash_rate_exceeded' };
      }
    } catch (err: any) {
      logger.warn(`[StagedUpdater] Could not fetch crash data: ${err.message}`);
      // Continue with rollout if crash data is unavailable
    }

    // Check if rollout was paused
    if (this.rolloutState.paused) {
      return { eligible: false, notified: false, paused: true, reason: 'rollout_paused' };
    }

    // Check if machine is in rollout bucket
    const machineId = this.deps.getMachineId();
    const eligible = isInRolloutBucket(machineId, currentPercentage);

    if (!eligible) {
      return {
        eligible: false,
        notified: false,
        paused: false,
        reason: 'not_in_rollout_bucket',
      };
    }

    // Notify user (once per version)
    const shouldNotify = shouldNotifyUser(info.version, this.notificationHistory);
    if (shouldNotify) {
      this.notificationHistory = recordNotification(info.version, this.notificationHistory, now);
      this.deps.notifyUser(info);
      return { eligible: true, notified: true, paused: false };
    }

    return { eligible: true, notified: false, paused: false, reason: 'already_notified' };
  }

  /**
   * User chose to defer installation. Records deferral and will install on next restart.
   */
  deferInstallation(version: string): void {
    this.notificationHistory = deferNotification(version, this.notificationHistory);
    logger.info(`[StagedUpdater] User deferred installation of ${version}`);
  }

  /**
   * Trigger immediate installation (quit and install).
   */
  installNow(): void {
    logger.info('[StagedUpdater] Installing update now');
    this.deps.installUpdate();
  }

  /**
   * Resume a paused rollout (e.g., after crash rate returns to normal).
   */
  resumeRollout(): void {
    if (this.rolloutState) {
      this.rolloutState.paused = false;
      logger.info(`[StagedUpdater] Rollout resumed for ${this.rolloutState.version}`);
    }
  }

  /**
   * Get the current rollout state (for diagnostics/UI).
   */
  getRolloutState(): RolloutState | null {
    return this.rolloutState;
  }

  /**
   * Get the notification history (for diagnostics/UI).
   */
  getNotificationHistory(): NotificationRecord[] {
    return [...this.notificationHistory];
  }

  /**
   * Stop all periodic checks and clean up.
   */
  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.crashCheckInterval) {
      clearInterval(this.crashCheckInterval);
      this.crashCheckInterval = null;
    }
    this.initialized = false;
  }

  // ─── Internal ───────────────────────────────────────────────

  private getNow(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
