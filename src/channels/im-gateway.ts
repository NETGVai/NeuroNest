// ─── IM_Gateway ─────────────────────────────────────────────────
// Receives tasks from Telegram, Slack, and Discord via long-polling
// or WebSocket. All incoming messages pass through Firewall_Engine
// before task creation in the Swarm_Coordinator pipeline.
//
// Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8

import type { ConnectResult, SendResult } from './channel-manager.js';
import type { IMConfig, IMTask } from './types/im-types.js';

// ─── Dependency Interfaces (for DI / testing) ───────────────────

export interface ChannelManagerLike {
  connect(channelId: string, config: any): Promise<ConnectResult>;
  disconnect(channelId: string): Promise<void>;
  sendMessage(channelId: string, to: string, message: string): Promise<SendResult>;
  onMessage(handler: (msg: { channelId: string; from: string; content: string; timestamp: Date }) => void): void;
}

export interface FirewallEngineLike {
  evaluate(input: string): { allowed: boolean; reason?: string };
}

export interface SwarmCoordinatorLike {
  execute(task: string, sessionId: string): Promise<{ output: string }>;
}

// ─── Internal Types ─────────────────────────────────────────────

export interface IMChannelHandle {
  platform: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  config: IMConfig;
  failureCount: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

// ─── Constants ──────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;

// ─── IMGateway ──────────────────────────────────────────────────

export class IMGateway {
  private connections: Map<string, IMChannelHandle> = new Map();
  private channelManager: ChannelManagerLike;
  private firewallEngine: FirewallEngineLike;
  private swarmCoordinator: SwarmCoordinatorLike;

  constructor(
    channelManager: ChannelManagerLike,
    firewallEngine: FirewallEngineLike,
    swarmCoordinator: SwarmCoordinatorLike,
  ) {
    this.channelManager = channelManager;
    this.firewallEngine = firewallEngine;
    this.swarmCoordinator = swarmCoordinator;

    // Listen for incoming messages from all connected channels
    this.channelManager.onMessage((msg) => {
      this.handleIncomingMessage(msg);
    });
  }

  // ── Public API ──────────────────────────────────────────────────

  /**
   * Configure and start a new IM channel connection.
   * Supports Telegram (long-polling), Slack (WebSocket), Discord (WebSocket).
   * Validates config, delegates to ChannelManager, and stores the handle.
   */
  async connect(config: IMConfig): Promise<ConnectResult> {
    const { platform, credentials } = config;

    // Validate platform
    if (!['whatsapp', 'telegram', 'slack', 'discord'].includes(platform)) {
      return { success: false, message: `Unsupported platform: ${platform}` };
    }

    // Validate credentials are present
    if (!credentials || Object.keys(credentials).length === 0) {
      return { success: false, message: `Credentials required for ${platform}` };
    }

    // If already connected, disconnect first
    if (this.connections.has(platform)) {
      this.disconnect(platform);
    }

    // Store handle as connecting
    const handle: IMChannelHandle = {
      platform,
      status: 'connecting',
      config,
      failureCount: 0,
    };
    this.connections.set(platform, handle);

    try {
      const result = await this.channelManager.connect(platform, credentials);

      if (result.success) {
        handle.status = 'connected';
        handle.failureCount = 0;
      } else {
        handle.status = 'error';
        this.scheduleReconnect(platform);
      }

      return result;
    } catch (err: any) {
      handle.status = 'error';
      this.scheduleReconnect(platform);
      return { success: false, message: err?.message ?? 'Connection failed' };
    }
  }

  /**
   * Disconnect a channel and clean up reconnect timers.
   */
  disconnect(platform: string): void {
    const handle = this.connections.get(platform);
    if (!handle) return;

    // Clear any pending reconnect timer
    if (handle.reconnectTimer) {
      clearTimeout(handle.reconnectTimer);
      handle.reconnectTimer = undefined;
    }

    // Delegate to channel manager (fire-and-forget)
    this.channelManager.disconnect(platform).catch(() => {});

    this.connections.delete(platform);
  }

  /**
   * Send a result back to the originating channel/thread.
   */
  async reply(task: IMTask, result: string): Promise<SendResult> {
    const target = task.threadId ?? task.channelId;
    return this.channelManager.sendMessage(task.platform, target, result);
  }

  /**
   * Get status of all IM connections.
   */
  getStatus(): Array<{ platform: string; status: string }> {
    const statuses: Array<{ platform: string; status: string }> = [];
    for (const [platform, handle] of this.connections) {
      statuses.push({ platform, status: handle.status });
    }
    return statuses;
  }

  /**
   * Calculate exponential backoff delay for a given number of failures.
   * delay = min(initialDelay × 2^(failures-1), maxDelay)
   * Public for testing (Property 20).
   */
  getBackoffDelay(failures: number): number {
    if (failures <= 0) return 0;
    return Math.min(INITIAL_BACKOFF_MS * Math.pow(2, failures - 1), MAX_BACKOFF_MS);
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Handle an incoming message from any connected channel.
   * Passes through firewall before creating a task.
   */
  private async handleIncomingMessage(msg: {
    channelId: string;
    from: string;
    content: string;
    timestamp: Date;
  }): Promise<void> {
    // Determine platform from channelId (the channelId IS the platform key)
    const handle = this.connections.get(msg.channelId);
    if (!handle) return;

    // Firewall gate — Requirement 5.7
    const firewallResult = this.firewallEngine.evaluate(msg.content);
    if (!firewallResult.allowed) {
      console.log(
        `[IMGateway] Message blocked by firewall from ${msg.from}: ${firewallResult.reason ?? 'blocked'}`,
      );
      return;
    }

    // Create task in Swarm_Coordinator pipeline — Requirement 5.2
    const task: IMTask = {
      channelId: msg.channelId,
      platform: handle.platform,
      from: msg.from,
      content: msg.content,
    };

    try {
      const result = await this.swarmCoordinator.execute(task.content, `im-${handle.platform}-${msg.from}`);
      // Reply to originating channel — Requirement 5.4
      await this.reply(task, result.output);
    } catch (err: any) {
      console.error(`[IMGateway] Task execution failed:`, err?.message);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * Requirement 5.6: initial 1s, max 60s.
   */
  private scheduleReconnect(platform: string): void {
    const handle = this.connections.get(platform);
    if (!handle) return;

    handle.failureCount++;
    const delay = this.getBackoffDelay(handle.failureCount);

    handle.reconnectTimer = setTimeout(async () => {
      handle.reconnectTimer = undefined;
      handle.status = 'connecting';

      try {
        const result = await this.channelManager.connect(platform, handle.config.credentials);
        if (result.success) {
          handle.status = 'connected';
          handle.failureCount = 0;
        } else {
          handle.status = 'error';
          this.scheduleReconnect(platform);
        }
      } catch {
        handle.status = 'error';
        this.scheduleReconnect(platform);
      }
    }, delay);
  }
}

export default IMGateway;
