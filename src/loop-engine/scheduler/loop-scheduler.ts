/**
 * LoopScheduler — Cross-platform scheduler for unattended loop execution.
 *
 * Supports macOS launchd, Linux systemd, and Windows Task Scheduler.
 * Promotes interactive loops to scheduled runs with proper prerequisite checks.
 *
 * Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7
 */

import { join } from 'node:path';
import { writeFile, mkdir, access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { SchedulerPlatform, ScheduleConfig } from '../index.js';

// ─── Constants ──────────────────────────────────────────────────

const PLIST_LABEL_PREFIX = 'com.neuronest.loop';
const SYSTEMD_UNIT_PREFIX = 'neuronest-loop';
const TASK_SCHEDULER_PREFIX = 'NeuroNestLoop';

// ─── Interfaces ─────────────────────────────────────────────────

export interface FeatureGateCheckLike {
  isEnabled(feature: string): boolean;
}

export interface KillSwitchLike {
  isOperational(): Promise<boolean>;
}

export interface LoopSchedulerDeps {
  featureGate: FeatureGateCheckLike;
  killSwitch: KillSwitchLike;
  workspacePath: string;
  executablePath?: string;
}

// ─── LoopScheduler Class ────────────────────────────────────────

export class LoopScheduler {
  private deps: LoopSchedulerDeps;

  constructor(deps: LoopSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * Detect the current platform from process.platform.
   */
  detectPlatform(): SchedulerPlatform {
    switch (process.platform) {
      case 'darwin':
        return 'macos';
      case 'linux':
        return 'linux';
      case 'win32':
        return 'windows';
      default:
        // Default to linux for unrecognized Unix-like platforms
        return 'linux';
    }
  }

  /**
   * Promote an interactive loop to a scheduled run.
   *
   * 1. Gate behind loops_scheduler flag (REQ-28.6)
   * 2. Verify prerequisites (REQ-28.4)
   * 3. Write platform-specific scheduler config (REQ-28.1)
   * 4. Freeze GOAL.md version (REQ-28.1)
   */
  async promote(config: ScheduleConfig): Promise<void> {
    // Gate behind loops_scheduler flag (REQ-28.6)
    if (!this.deps.featureGate.isEnabled('loops_scheduler')) {
      throw new Error(
        'Schedule-promotion rejected: loops_scheduler flag is disabled. ' +
        'Enable the loops_scheduler feature flag to use scheduled loop runs.',
      );
    }

    // Verify prerequisites (REQ-28.4)
    const { ready, missing } = await this.verifyPrerequisites();
    if (!ready) {
      throw new Error(
        `Cannot promote to scheduled run. Missing prerequisites: ${missing.join(', ')}`,
      );
    }

    // Write platform-specific scheduler config (REQ-28.1)
    await this.writeSchedulerConfig(config);
  }

  /**
   * Generate and write platform-specific scheduler configuration.
   *
   * - macOS: launchd plist under ~/Library/LaunchAgents/
   * - Linux: systemd timer + service unit files under ~/.config/systemd/user/
   * - Windows: Task Scheduler XML under AppData
   *
   * The scheduler is deliberately stateless (REQ-28.3): it fires the run
   * and logs; all decision logic resides in the LoopRunner.
   *
   * Returns the path to the written config file.
   */
  async writeSchedulerConfig(config: ScheduleConfig): Promise<string> {
    const platform = this.detectPlatform();
    const execPath = this.deps.executablePath ?? process.execPath;
    const logsDir = join(this.deps.workspacePath, 'logs');

    // Ensure logs directory exists
    await mkdir(logsDir, { recursive: true });

    switch (platform) {
      case 'macos':
        return this.writeLaunchdPlist(config, execPath, logsDir);
      case 'linux':
        return this.writeSystemdUnits(config, execPath, logsDir);
      case 'windows':
        return this.writeTaskSchedulerXml(config, execPath, logsDir);
    }
  }

  /**
   * Verify all prerequisites for scheduled execution (REQ-28.4):
   * 1. Permission patterns configured (.neuronest/settings.json exists)
   * 2. Messaging channel URL is set (for AWAITING_APPROVAL routing, REQ-28.7)
   * 3. Kill switch is operational (REQ-28.5)
   */
  async verifyPrerequisites(): Promise<{ ready: boolean; missing: string[] }> {
    const missing: string[] = [];

    // Check permission patterns are configured
    const settingsPath = join(this.deps.workspacePath, '.neuronest', 'settings.json');
    try {
      await access(settingsPath);
      // Verify the file has actual permission patterns
      const content = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      if (!settings.permissions || (!settings.permissions.allow?.length && !settings.permissions.deny?.length)) {
        missing.push('permission_patterns_not_configured');
      }
    } catch {
      missing.push('permission_patterns_missing');
    }

    // Check messaging channel is configured for approval routing
    const messagingConfigPath = join(this.deps.workspacePath, '.neuronest', 'messaging.json');
    try {
      await access(messagingConfigPath);
      const content = await readFile(messagingConfigPath, 'utf-8');
      const messaging = JSON.parse(content);
      if (!messaging.webhookUrl) {
        missing.push('messaging_channel_url_not_set');
      }
    } catch {
      missing.push('messaging_channel_not_configured');
    }

    // Check kill switch is operational
    try {
      const operational = await this.deps.killSwitch.isOperational();
      if (!operational) {
        missing.push('kill_switch_not_operational');
      }
    } catch {
      missing.push('kill_switch_check_failed');
    }

    return {
      ready: missing.length === 0,
      missing,
    };
  }

  // ─── Private: Platform-Specific Config Writers ──────────────────

  /**
   * Write macOS launchd plist to ~/Library/LaunchAgents/.
   * Fires the loop on the configured interval in headless mode.
   */
  private async writeLaunchdPlist(
    config: ScheduleConfig,
    execPath: string,
    logsDir: string,
  ): Promise<string> {
    const label = `${PLIST_LABEL_PREFIX}.${config.specId}`;
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = join(plistDir, `${label}.plist`);

    await mkdir(plistDir, { recursive: true });

    const intervalSeconds = config.intervalMinutes * 60;
    const logPath = join(logsDir, '$(date +%Y-%m-%d).log');

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(execPath)}</string>
        <string>--headless</string>
        <string>--loop-run</string>
        <string>${escapeXml(config.specId)}</string>
        <string>--goal-version</string>
        <string>${escapeXml(config.goalMdVersion)}</string>
        <string>--log-dir</string>
        <string>${escapeXml(logsDir)}</string>
    </array>
    <key>StartInterval</key>
    <integer>${intervalSeconds}</integer>
    <key>WorkingDirectory</key>
    <string>${escapeXml(this.deps.workspacePath)}</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>`;

    await writeFile(plistPath, plistContent, 'utf-8');
    return plistPath;
  }

  /**
   * Write Linux systemd timer + service unit files.
   * Timer fires at the configured interval; service executes in headless mode.
   */
  private async writeSystemdUnits(
    config: ScheduleConfig,
    execPath: string,
    logsDir: string,
  ): Promise<string> {
    const unitName = `${SYSTEMD_UNIT_PREFIX}-${config.specId}`;
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    const servicePath = join(unitDir, `${unitName}.service`);
    const timerPath = join(unitDir, `${unitName}.timer`);

    await mkdir(unitDir, { recursive: true });

    // Write service unit
    const serviceContent = `[Unit]
Description=NeuroNest Loop Run: ${config.specId}

[Service]
Type=oneshot
WorkingDirectory=${this.deps.workspacePath}
ExecStart=/bin/sh -c '${escapeShell(execPath)} --headless --loop-run ${escapeShell(config.specId)} --goal-version ${escapeShell(config.goalMdVersion)} --log-dir ${escapeShell(logsDir)} >> ${escapeShell(logsDir)}/$(date +%%Y-%%m-%%d).log 2>&1'
Environment=NEURONEST_HEADLESS=1
`;

    // Write timer unit
    const timerContent = `[Unit]
Description=Timer for NeuroNest Loop Run: ${config.specId}

[Timer]
OnBootSec=${config.intervalMinutes}min
OnUnitActiveSec=${config.intervalMinutes}min
Persistent=true

[Install]
WantedBy=timers.target
`;

    await writeFile(servicePath, serviceContent, 'utf-8');
    await writeFile(timerPath, timerContent, 'utf-8');
    return timerPath;
  }

  /**
   * Write Windows Task Scheduler XML.
   * Registers a task that fires at the configured interval in headless mode.
   */
  private async writeTaskSchedulerXml(
    config: ScheduleConfig,
    execPath: string,
    logsDir: string,
  ): Promise<string> {
    const taskName = `${TASK_SCHEDULER_PREFIX}_${config.specId}`;
    const xmlDir = join(this.deps.workspacePath, '.neuronest', 'scheduler');
    const xmlPath = join(xmlDir, `${taskName}.xml`);

    await mkdir(xmlDir, { recursive: true });

    // Convert interval to ISO 8601 duration for Task Scheduler
    const hours = Math.floor(config.intervalMinutes / 60);
    const minutes = config.intervalMinutes % 60;
    const duration = `PT${hours > 0 ? `${hours}H` : ''}${minutes > 0 ? `${minutes}M` : ''}`;

    const xmlContent = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>NeuroNest Loop Run: ${escapeXml(config.specId)}</Description>
    <URI>\\${escapeXml(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>${duration}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXml(execPath)}</Command>
      <Arguments>--headless --loop-run ${escapeXml(config.specId)} --goal-version ${escapeXml(config.goalMdVersion)} --log-dir ${escapeXml(logsDir)}</Arguments>
      <WorkingDirectory>${escapeXml(this.deps.workspacePath)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

    await writeFile(xmlPath, xmlContent, 'utf-8');
    return xmlPath;
  }
}

// ─── Utility Functions ──────────────────────────────────────────

/** Escape special XML characters */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Escape shell special characters for systemd ExecStart */
function escapeShell(str: string): string {
  return str.replace(/'/g, "'\\''");
}
