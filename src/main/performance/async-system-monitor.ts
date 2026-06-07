/**
 * AsyncSystemMonitor - Fully async system stats collection with parallel execution.
 *
 * Replaces synchronous execSync calls for system monitoring with async patterns.
 * Uses os module for instant CPU/memory data and util.promisify(exec) for
 * disk, network, and GPU commands with per-command 500ms timeout via AbortController.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */
import * as os from 'os';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(execCallback);

// ─── Local Type Definitions ──────────────────────────────────────────────────

/** Per-core CPU usage information */
export interface CpuCoreInfo {
  core: number;
  usage: number;
}

/** CPU statistics */
export interface CpuStats {
  model: string;
  cores: number;
  usage: number;
  user: number;
  sys: number;
  idle: number;
  freq: number;
  perCore: CpuCoreInfo[];
}

/** Memory statistics */
export interface MemoryStats {
  total: string;
  used: string;
  free: string;
  percent: number;
}

/** Disk statistics */
export interface DiskStats {
  total: string;
  used: string;
  free: string;
  percent: number;
}

/** Network statistics */
export interface NetworkStats {
  sent: string;
  received: string;
  connections: number;
  interfaces: string[];
}

/** GPU statistics */
export interface GpuStats {
  model: string;
  cores: string;
  vram: string;
}

/** Fast system stats available instantly from os module (<10ms) */
export interface FastSystemStats {
  cpu: CpuStats;
  memory: MemoryStats;
  uptime: string;
  hostname: string;
  platform: string;
}

/** Full system stats including shell command results */
export interface SystemStats extends FastSystemStats {
  disk: DiskStats;
  network: NetworkStats;
  gpu: GpuStats;
}

/** Cache entry for system stats */
interface SystemStatsCache {
  stats: SystemStats | null;
  timestamp: number;
}

/** Tracked in-flight command for cancellation */
interface InFlightCommand {
  abortController: AbortController;
  startedAt: number;
  label: string;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatUptime(uptimeSec: number): string {
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  return (days > 0 ? days + 'd ' : '') + hours + 'h ' + mins + 'm';
}

// ─── AsyncSystemMonitor Class ────────────────────────────────────────────────

export class AsyncSystemMonitor {
  private cache: SystemStatsCache = { stats: null, timestamp: 0 };
  private inFlightCommands: Map<string, InFlightCommand> = new Map();

  /** Default timeout for shell commands in milliseconds */
  private static readonly COMMAND_TIMEOUT_MS = 500;

  /**
   * Execute a shell command with a 500ms timeout using AbortController.
   * Returns the stdout output or an empty string if the command times out or fails.
   */
  private async execWithTimeout(command: string, label: string): Promise<string> {
    const abortController = new AbortController();
    const { signal } = abortController;

    this.inFlightCommands.set(label, {
      abortController,
      startedAt: Date.now(),
      label,
    });

    try {
      const { stdout } = await execAsync(command, {
        encoding: 'utf-8',
        timeout: AsyncSystemMonitor.COMMAND_TIMEOUT_MS,
        signal,
      });
      return stdout.trim();
    } catch {
      // Command timed out, was aborted, or failed — return empty string for partial results
      return '';
    } finally {
      this.inFlightCommands.delete(label);
    }
  }

  /**
   * Cancel any in-flight slow commands exceeding 500ms.
   * Aborts commands that have been running longer than the threshold.
   */
  private cancelSlowCommands(): void {
    const now = Date.now();
    const entries = Array.from(this.inFlightCommands.entries());
    for (const [label, command] of entries) {
      if (now - command.startedAt >= AsyncSystemMonitor.COMMAND_TIMEOUT_MS) {
        try {
          command.abortController.abort();
        } catch {
          // Already aborted or completed
        }
        this.inFlightCommands.delete(label);
      }
    }
  }

  /**
   * Get fast stats only (CPU, memory from os module) — <10ms.
   * Uses Node.js os module APIs for instant data without shell commands.
   */
  getFastStats(): FastSystemStats {
    const cpus = os.cpus();
    const cpuModel = cpus[0]?.model || 'Unknown';
    const cpuCores = cpus.length;
    const cpuFreq = cpus[0]?.speed || 0;

    // Calculate per-core usage from cpu times
    const perCore: CpuCoreInfo[] = cpus.map((c, i) => {
      const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      const active = total - c.times.idle;
      return { core: i, usage: total > 0 ? Math.round((active / total) * 100) : 0 };
    });

    // Calculate overall CPU usage
    const totalTimes = cpus.reduce(
      (acc, c) => ({
        user: acc.user + c.times.user,
        sys: acc.sys + c.times.sys,
        idle: acc.idle + c.times.idle,
        total: acc.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq,
      }),
      { user: 0, sys: 0, idle: 0, total: 0 }
    );

    const userPercent = totalTimes.total > 0 ? Math.round((totalTimes.user / totalTimes.total) * 100) : 0;
    const sysPercent = totalTimes.total > 0 ? Math.round((totalTimes.sys / totalTimes.total) * 100) : 0;
    const idlePercent = totalTimes.total > 0 ? Math.round((totalTimes.idle / totalTimes.total) * 100) : 0;

    // Memory stats from os module
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    // Uptime from os module
    const uptime = formatUptime(os.uptime());

    return {
      cpu: {
        model: cpuModel,
        cores: cpuCores,
        usage: userPercent + sysPercent,
        user: userPercent,
        sys: sysPercent,
        idle: idlePercent,
        freq: cpuFreq,
        perCore,
      },
      memory: {
        total: formatBytes(totalMem),
        used: formatBytes(usedMem),
        free: formatBytes(freeMem),
        percent: memPercent,
      },
      uptime,
      hostname: os.hostname(),
      platform: os.platform() + ' ' + os.release(),
    };
  }

  /**
   * Collect all system stats asynchronously with parallel execution.
   * Uses Promise.allSettled() to run disk, network, and GPU commands in parallel.
   * Returns partial results when individual commands timeout (500ms per command).
   */
  async collectStats(): Promise<SystemStats> {
    // Get fast stats instantly from os module
    const fastStats = this.getFastStats();

    // Determine platform-appropriate commands
    const platform = os.platform();
    const diskCommand = platform === 'darwin'
      ? 'df -g / | tail -1'
      : 'df -BG / | tail -1';
    const networkCommand = platform === 'darwin'
      ? 'netstat -ib | grep -e en0 -m 1'
      : 'cat /proc/net/dev | grep -E "eth0|ens" | head -1';
    const networkConnectionsCommand = platform === 'darwin'
      ? 'netstat -an | grep ESTABLISHED | wc -l'
      : 'ss -t state established | wc -l';
    const networkInterfacesCommand = platform === 'darwin'
      ? 'networksetup -listallhardwareports | grep "Device:" | awk \'{print $2}\''
      : 'ip -o link show | awk -F\': \' \'{print $2}\'';
    const gpuCommand = platform === 'darwin'
      ? 'system_profiler SPDisplaysDataType 2>/dev/null | grep -E "Chipset Model|Cores|VRAM"'
      : 'lspci | grep -i vga 2>/dev/null';

    // Execute all shell commands in parallel with individual 500ms timeouts
    const [diskResult, networkResult, connectionsResult, interfacesResult, gpuResult] = await Promise.allSettled([
      this.execWithTimeout(diskCommand, 'disk'),
      this.execWithTimeout(networkCommand, 'network'),
      this.execWithTimeout(networkConnectionsCommand, 'connections'),
      this.execWithTimeout(networkInterfacesCommand, 'interfaces'),
      this.execWithTimeout(gpuCommand, 'gpu'),
    ]);

    // Cancel any commands that are still running beyond threshold
    this.cancelSlowCommands();

    // Parse disk results (partial results on timeout — empty string)
    const diskOutput = diskResult.status === 'fulfilled' ? diskResult.value : '';
    let diskTotal = 0;
    let diskUsed = 0;
    let diskFree = 0;
    if (diskOutput) {
      const parts = diskOutput.split(/\s+/);
      diskTotal = parseInt(parts[1] || '0', 10) || 0;
      diskUsed = parseInt(parts[2] || '0', 10) || 0;
      diskFree = parseInt(parts[3] || '0', 10) || 0;
    }

    // Parse network results
    const networkOutput = networkResult.status === 'fulfilled' ? networkResult.value : '';
    let netSent = '0 B';
    let netRecv = '0 B';
    if (networkOutput) {
      const parts = networkOutput.split(/\s+/);
      if (platform === 'darwin' && parts.length >= 10) {
        netRecv = formatBytes(parseInt(parts[6] || '0', 10) || 0);
        netSent = formatBytes(parseInt(parts[9] || '0', 10) || 0);
      } else if (parts.length >= 10) {
        // Linux /proc/net/dev format
        netRecv = formatBytes(parseInt(parts[1] || '0', 10) || 0);
        netSent = formatBytes(parseInt(parts[9] || '0', 10) || 0);
      }
    }

    // Parse connections count
    const connectionsOutput = connectionsResult.status === 'fulfilled' ? connectionsResult.value : '';
    const connections = parseInt(connectionsOutput.trim(), 10) || 0;

    // Parse network interfaces
    const interfacesOutput = interfacesResult.status === 'fulfilled' ? interfacesResult.value : '';
    const interfaces = interfacesOutput
      ? interfacesOutput.split('\n').map(s => s.trim()).filter(Boolean)
      : [];

    // Parse GPU results
    const gpuOutput = gpuResult.status === 'fulfilled' ? gpuResult.value : '';
    let gpuModel = 'Unknown';
    let gpuCores = '';
    let gpuVram = '';
    if (gpuOutput) {
      if (platform === 'darwin') {
        const modelMatch = gpuOutput.match(/Chipset Model:\s*(.+)/);
        const coresMatch = gpuOutput.match(/Total Number of Cores:\s*(\d+)/);
        const vramMatch = gpuOutput.match(/VRAM.*?:\s*(.+)/);
        gpuModel = modelMatch && modelMatch[1] ? modelMatch[1].trim() : 'Unknown';
        gpuCores = coresMatch && coresMatch[1] ? coresMatch[1].trim() : '';
        gpuVram = vramMatch && vramMatch[1] ? vramMatch[1].trim() : '';
      } else {
        // Linux: lspci output
        const match = gpuOutput.match(/:\s*(.+)/);
        gpuModel = match && match[1] ? match[1].trim() : 'Unknown';
      }
    }

    const stats: SystemStats = {
      ...fastStats,
      disk: {
        total: diskTotal + ' GB',
        used: diskUsed + ' GB',
        free: diskFree + ' GB',
        percent: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
      },
      network: {
        sent: netSent,
        received: netRecv,
        connections,
        interfaces,
      },
      gpu: {
        model: gpuModel,
        cores: gpuCores,
        vram: gpuVram,
      },
    };

    // Update cache
    this.cache = { stats, timestamp: Date.now() };

    return stats;
  }

  /**
   * Get cached stats if available and fresh (within 5 seconds).
   */
  getCachedStats(): SystemStats | null {
    if (this.cache.stats && (Date.now() - this.cache.timestamp) < 5000) {
      return this.cache.stats;
    }
    return null;
  }
}
