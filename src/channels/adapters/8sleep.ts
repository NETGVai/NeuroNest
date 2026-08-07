// ─── 8Sleep Adapter ─────────────────────────────────────────────
// Full ChannelAdapter implementation for 8Sleep smart mattress.
// Communicates with the 8Sleep API for bed temperature control,
// schedule management, and device status queries. Responses are
// formatted as device status objects per IoT channel requirements.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.3, REQ 8.3

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for 8Sleep adapter configuration.
 * Requires email and password for authentication, plus an optional
 * client ID for API identification.
 */
export const EightSleepConfigSchema = z.object({
  /** 8Sleep account email address */
  email: z.string().email(),
  /** 8Sleep account password */
  password: z.string().min(1),
  /** Optional client ID for API identification */
  clientId: z.string().optional(),
  /** Polling interval in ms for status updates (default: 60000ms = 1min) */
  pollingIntervalMs: z.number().int().min(10000).default(60000),
});

export type EightSleepConfig = z.infer<typeof EightSleepConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported 8Sleep command actions */
type EightSleepAction = 'get-status' | 'set-temperature' | 'get-schedule' | 'set-schedule' | 'turn-on' | 'turn-off';

/** Parsed inbound command structure */
interface EightSleepCommand {
  action: EightSleepAction;
  side?: 'left' | 'right';
  temperature?: number;
  schedule?: EightSleepScheduleEntry[];
}

/** A schedule entry for the 8Sleep bed */
interface EightSleepScheduleEntry {
  time: string; // HH:mm format
  temperature: number; // -10 to +10 range
}

/** Device status response object */
interface EightSleepDeviceStatus {
  leftSide: {
    temperature: number;
    targetTemperature: number;
    isOn: boolean;
    userId?: string;
  };
  rightSide: {
    temperature: number;
    targetTemperature: number;
    isOn: boolean;
    userId?: string;
  };
  firmwareVersion?: string;
  isOnline: boolean;
  lastSeen?: string;
}

// ─── 8Sleep Adapter ─────────────────────────────────────────────

export class EightSleepAdapter extends BaseChannelAdapter {
  readonly channelId = '8sleep';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: '8Sleep',
    emoji: '🛏️',
    description: 'Smart mattress temperature control',
    actionTags: ['temperature', 'schedule', 'status', 'on/off'],
    sortOrder: 1030,
  };

  readonly configSchema = EightSleepConfigSchema;

  private config: EightSleepConfig | null = null;
  private accessToken: string | null = null;
  private userId: string | null = null;
  private deviceId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: EightSleepDeviceStatus | null = null;

  /** Base URL for the 8Sleep API */
  private readonly API_BASE = 'https://client-api.8slp.net/v1';

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        '8Sleep adapter requires email and password credentials.\n\n' +
        'Setup steps:\n' +
        '1. Use the same email/password as your 8Sleep app account\n' +
        '2. Optionally provide a client ID for API identification\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Authenticate with the 8Sleep API
    try {
      const authResult = await this.authenticate();
      if (!authResult.success) {
        return authResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to 8Sleep API: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Fetch device info to verify we have access
    try {
      await this.fetchDeviceId();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to discover 8Sleep device: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start polling for status changes
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected', { channelId: '8sleep', deviceId: this.deviceId });

    return {
      success: true,
      message: '8Sleep connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.accessToken = null;
    this.userId = null;
    this.deviceId = null;
    this.lastStatus = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config || !this.accessToken || !this.deviceId) {
      return { success: false, message: '8Sleep adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      // Default to get-status if we can't parse the command
      return this.getDeviceStatus();
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'get-status':
          return this.getDeviceStatus();

        case 'set-temperature':
          return this.setTemperature(command.side ?? 'left', command.temperature ?? 0);

        case 'get-schedule':
          return this.getSchedule(command.side ?? 'left');

        case 'set-schedule':
          return this.setSchedule(command.side ?? 'left', command.schedule ?? []);

        case 'turn-on':
          return this.setPowerState(command.side ?? 'left', true);

        case 'turn-off':
          return this.setPowerState(command.side ?? 'left', false);

        default:
          return { success: false, message: `Unknown 8Sleep action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `8Sleep operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Authentication ────────────────────────────────────

  /**
   * Authenticate with the 8Sleep API using email/password.
   * Stores the access token and user ID for subsequent requests.
   */
  private async authenticate(): Promise<ConnectResult> {
    if (!this.config) {
      return { success: false, message: 'Not configured', error: { code: 'CONFIG_INVALID', message: 'Not configured' } };
    }

    const body = {
      email: this.config.email,
      password: this.config.password,
      ...(this.config.clientId ? { client_id: this.config.clientId } : {}),
    };

    const response = await fetch(`${this.API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return this.authFailed('Invalid email or password for 8Sleep account.');
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `8Sleep auth error (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    const result = (await response.json()) as {
      session?: { token: string; userId: string };
    };

    if (!result.session?.token || !result.session?.userId) {
      return this.authFailed('Unexpected auth response from 8Sleep API.');
    }

    this.accessToken = result.session.token;
    this.userId = result.session.userId;

    return { success: true, message: 'Authenticated' };
  }

  /**
   * Fetch the user's device ID from the 8Sleep API.
   */
  private async fetchDeviceId(): Promise<void> {
    const response = await this.apiFetch(`/users/${this.userId}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch user profile: ${response.status}`);
    }

    const result = (await response.json()) as {
      user?: { devices?: string[]; currentDevice?: { id: string } };
    };

    const deviceId =
      result.user?.currentDevice?.id ??
      result.user?.devices?.[0];

    if (!deviceId) {
      throw new Error('No 8Sleep device found for this account');
    }

    this.deviceId = deviceId;
  }

  // ─── Private: Device operations ─────────────────────────────────

  /**
   * Get the current device status (temperature, power state).
   * Returns a formatted device status object per REQ 4.3.
   */
  private async getDeviceStatus(): Promise<SendResult> {
    const response = await this.apiFetch(`/devices/${this.deviceId}`);
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get status failed: ${errorBody}` };
    }

    const result = (await response.json()) as {
      result?: {
        leftKelvin?: { currentTemperature?: number; targetTemperature?: number; active?: boolean };
        rightKelvin?: { currentTemperature?: number; targetTemperature?: number; active?: boolean };
        firmwareVersion?: string;
        online?: boolean;
        lastSeen?: string;
      };
    };

    const device = result.result;
    if (!device) {
      return { success: false, message: 'No device data returned' };
    }

    const status: EightSleepDeviceStatus = {
      leftSide: {
        temperature: device.leftKelvin?.currentTemperature ?? 0,
        targetTemperature: device.leftKelvin?.targetTemperature ?? 0,
        isOn: device.leftKelvin?.active ?? false,
      },
      rightSide: {
        temperature: device.rightKelvin?.currentTemperature ?? 0,
        targetTemperature: device.rightKelvin?.targetTemperature ?? 0,
        isOn: device.rightKelvin?.active ?? false,
      },
      firmwareVersion: device.firmwareVersion,
      isOnline: device.online ?? false,
      lastSeen: device.lastSeen,
    };

    this.lastStatus = status;

    return {
      success: true,
      message: JSON.stringify(status, null, 2),
    };
  }

  /**
   * Set the temperature for a specific side of the bed.
   * Temperature range is typically -10 to +10 (relative cooling/heating).
   */
  private async setTemperature(side: 'left' | 'right', temperature: number): Promise<SendResult> {
    // Clamp temperature to valid range
    const clampedTemp = Math.max(-10, Math.min(10, temperature));
    const sideKey = side === 'left' ? 'leftKelvin' : 'rightKelvin';

    const body = {
      [sideKey]: {
        targetTemperature: clampedTemp,
        active: true,
      },
    };

    const response = await this.apiFetch(`/devices/${this.deviceId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Set temperature failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: 'set-temperature',
        side,
        temperature: clampedTemp,
        status: 'applied',
      }),
    };
  }

  /**
   * Get the sleep schedule for a specific side of the bed.
   */
  private async getSchedule(side: 'left' | 'right'): Promise<SendResult> {
    const sideParam = side === 'left' ? 'left' : 'right';
    const response = await this.apiFetch(
      `/devices/${this.deviceId}/schedule?side=${sideParam}`,
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get schedule failed: ${errorBody}` };
    }

    const result = (await response.json()) as {
      schedule?: Array<{ time: string; temperature: number }>;
    };

    return {
      success: true,
      message: JSON.stringify({
        action: 'get-schedule',
        side,
        schedule: result.schedule ?? [],
      }, null, 2),
    };
  }

  /**
   * Set the sleep schedule for a specific side of the bed.
   */
  private async setSchedule(
    side: 'left' | 'right',
    schedule: EightSleepScheduleEntry[],
  ): Promise<SendResult> {
    const sideParam = side === 'left' ? 'left' : 'right';
    const body = { schedule };

    const response = await this.apiFetch(
      `/devices/${this.deviceId}/schedule?side=${sideParam}`,
      {
        method: 'PUT',
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Set schedule failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: 'set-schedule',
        side,
        schedule,
        status: 'applied',
      }),
    };
  }

  /**
   * Turn the bed side on or off.
   */
  private async setPowerState(side: 'left' | 'right', on: boolean): Promise<SendResult> {
    const sideKey = side === 'left' ? 'leftKelvin' : 'rightKelvin';

    const body = {
      [sideKey]: {
        active: on,
      },
    };

    const response = await this.apiFetch(`/devices/${this.deviceId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Power state change failed: ${errorBody}` };
    }

    return {
      success: true,
      message: JSON.stringify({
        action: on ? 'turn-on' : 'turn-off',
        side,
        status: 'applied',
      }),
    };
  }

  // ─── Private: Polling for status changes ────────────────────────

  /**
   * Start polling for device status changes.
   * Emits inbound messages when temperature or power state changes.
   */
  private startPolling(): void {
    if (!this.config) return;

    this.pollTimer = setInterval(() => {
      this.pollForChanges().catch((err) => {
        this.log('error', 'Polling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop the polling timer.
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Poll device status and emit inbound messages on changes.
   */
  private async pollForChanges(): Promise<void> {
    if (!this.deviceId) return;

    const response = await this.apiFetch(`/devices/${this.deviceId}`);
    if (!response.ok) {
      this.log('warn', 'Poll query failed', { status: response.status });
      return;
    }

    const result = (await response.json()) as {
      result?: {
        leftKelvin?: { currentTemperature?: number; targetTemperature?: number; active?: boolean };
        rightKelvin?: { currentTemperature?: number; targetTemperature?: number; active?: boolean };
        online?: boolean;
      };
    };

    const device = result.result;
    if (!device) return;

    const currentStatus: EightSleepDeviceStatus = {
      leftSide: {
        temperature: device.leftKelvin?.currentTemperature ?? 0,
        targetTemperature: device.leftKelvin?.targetTemperature ?? 0,
        isOn: device.leftKelvin?.active ?? false,
      },
      rightSide: {
        temperature: device.rightKelvin?.currentTemperature ?? 0,
        targetTemperature: device.rightKelvin?.targetTemperature ?? 0,
        isOn: device.rightKelvin?.active ?? false,
      },
      isOnline: device.online ?? false,
    };

    // Detect changes and emit inbound messages
    if (this.lastStatus && this.hasStatusChanged(this.lastStatus, currentStatus)) {
      const changeContent = JSON.stringify({
        event: 'status-changed',
        deviceId: this.deviceId,
        previous: this.lastStatus,
        current: currentStatus,
      });

      this.emitInbound(this.deviceId, changeContent, 'text');
    }

    this.lastStatus = currentStatus;
  }

  /**
   * Compare two device statuses to detect meaningful changes.
   */
  private hasStatusChanged(
    prev: EightSleepDeviceStatus,
    curr: EightSleepDeviceStatus,
  ): boolean {
    return (
      prev.leftSide.temperature !== curr.leftSide.temperature ||
      prev.leftSide.targetTemperature !== curr.leftSide.targetTemperature ||
      prev.leftSide.isOn !== curr.leftSide.isOn ||
      prev.rightSide.temperature !== curr.rightSide.temperature ||
      prev.rightSide.targetTemperature !== curr.rightSide.targetTemperature ||
      prev.rightSide.isOn !== curr.rightSide.isOn ||
      prev.isOnline !== curr.isOnline
    );
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured 8Sleep command.
   * Supports JSON-format commands and natural language patterns:
   * - "get status" / "status"
   * - "set temperature <side> <value>"
   * - "get schedule [side]"
   * - "set schedule <side> <entries JSON>"
   * - "turn on [side]" / "turn off [side]"
   */
  private parseCommand(content: string): EightSleepCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as EightSleepCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "get status" or "status"
    if (/^(get\s+)?status$/i.test(lower)) {
      return { action: 'get-status' };
    }

    // Pattern: "set temperature <side> <value>" or "set temp <value>"
    const tempMatch = lower.match(
      /^set\s+temp(?:erature)?\s+(left|right)?\s*(-?\d+(?:\.\d+)?)$/i,
    );
    if (tempMatch) {
      return {
        action: 'set-temperature',
        side: (tempMatch[1] as 'left' | 'right') ?? 'left',
        temperature: parseFloat(tempMatch[2]!),
      };
    }

    // Pattern: "get schedule [side]"
    const getSchedMatch = lower.match(/^get\s+schedule\s*(left|right)?$/i);
    if (getSchedMatch) {
      return {
        action: 'get-schedule',
        side: (getSchedMatch[1] as 'left' | 'right') ?? 'left',
      };
    }

    // Pattern: "set schedule <side> <json>"
    const setSchedMatch = content.match(/^set\s+schedule\s+(left|right)\s+(.+)$/i);
    if (setSchedMatch) {
      try {
        const schedule = JSON.parse(setSchedMatch[2]!) as EightSleepScheduleEntry[];
        return {
          action: 'set-schedule',
          side: setSchedMatch[1]!.toLowerCase() as 'left' | 'right',
          schedule,
        };
      } catch {
        return null;
      }
    }

    // Pattern: "turn on [side]" / "turn off [side]"
    const powerMatch = lower.match(/^turn\s+(on|off)\s*(left|right)?$/i);
    if (powerMatch) {
      return {
        action: powerMatch[1] === 'on' ? 'turn-on' : 'turn-off',
        side: (powerMatch[2] as 'left' | 'right') ?? 'left',
      };
    }

    return null;
  }

  // ─── Private: API fetch helper ──────────────────────────────────

  /**
   * Make an authenticated request to the 8Sleep API.
   * Uses Bearer token auth with the session token.
   */
  private async apiFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.accessToken) {
      throw new Error('8Sleep adapter is not authenticated');
    }

    const url = `${this.API_BASE}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
      ...(this.config?.clientId ? { 'X-Client-Id': this.config.clientId } : {}),
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }
}
