// ─── Philips Hue Adapter ────────────────────────────────────────
// Full ChannelAdapter implementation for Philips Hue smart lighting
// using the Hue Bridge local REST API.
// Supports getting/setting individual light states, activating scenes,
// listing rooms/groups, and toggling lights on/off.
// Responses are formatted as device status objects.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.3, REQ 8.1, REQ 8.2

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Philips Hue adapter configuration.
 * Requires the Hue Bridge IP address and a username/app key obtained
 * through the Hue Bridge pairing process.
 */
export const PhilipsHueConfigSchema = z.object({
  /** IP address of the Hue Bridge on the local network */
  bridgeIp: z.string().min(1),
  /** Username / application key for Hue Bridge API authentication */
  username: z.string().min(1),
  /** Optional polling interval in ms for state change detection (default: 10000ms) */
  pollingIntervalMs: z.number().int().min(2000).default(10000),
});

export type PhilipsHueConfig = z.infer<typeof PhilipsHueConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Hue command actions */
type HueAction = 'get-light' | 'set-light' | 'toggle' | 'set-scene' | 'list-rooms' | 'list-lights';

/** Parsed inbound command structure */
interface HueCommand {
  action: HueAction;
  lightId?: string | undefined;
  groupId?: string | undefined;
  sceneId?: string | undefined;
  state?: HueLightState | undefined;
}

/** Light state properties that can be set via the Hue API */
interface HueLightState {
  on?: boolean;
  bri?: number;      // Brightness 1–254
  hue?: number;      // Hue 0–65535
  sat?: number;      // Saturation 0–254
  ct?: number;       // Color temperature 153–500 (mirek)
  xy?: [number, number]; // CIE color space coordinates
  alert?: 'none' | 'select' | 'lselect';
  effect?: 'none' | 'colorloop';
  transitiontime?: number; // Multiples of 100ms
}

/** Device status response format for IoT channels (REQ 4.3) */
interface HueDeviceStatus {
  type: 'light' | 'group' | 'scene';
  id: string;
  name: string;
  state: Record<string, unknown>;
}

// ─── Philips Hue Adapter ────────────────────────────────────────

export class PhilipsHueAdapter extends BaseChannelAdapter {
  readonly channelId = 'philips-hue';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'polling',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Philips Hue',
    emoji: '💡',
    description: 'Smart lighting control',
    actionTags: ['set light', 'set scene', 'list rooms', 'toggle'],
    sortOrder: 1020,
  };

  readonly configSchema = PhilipsHueConfigSchema;

  private config: PhilipsHueConfig | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastLightStates: Map<string, boolean> = new Map();

  /** Construct the Hue Bridge API base URL */
  private get apiBase(): string {
    if (!this.config) throw new Error('Philips Hue adapter is not configured');
    return `http://${this.config.bridgeIp}/api/${this.config.username}`;
  }

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Philips Hue adapter requires a bridge IP and username/app key.\n\n' +
        'Setup steps:\n' +
        '1. Find your Hue Bridge IP (check your router or use discovery)\n' +
        '2. Press the link button on your Hue Bridge\n' +
        '3. POST to http://<bridge-ip>/api with body {"devicetype":"neuronest#app"}\n' +
        '4. Use the returned username as the app key\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify connectivity by fetching the bridge config
    try {
      const response = await this.hueFetch('/config');
      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          message: `Hue Bridge API error (${response.status}): ${errorBody}`,
          error: { code: 'PROVIDER_ERROR', message: errorBody },
        };
      }

      const data = (await response.json()) as Record<string, unknown>;

      // Check for unauthorized response (Hue returns an array with error on bad username)
      if (Array.isArray(data)) {
        const errItem = (data as Array<{ error?: { description?: string } }>)[0];
        if (errItem?.error) {
          return this.authFailed(errItem.error.description ?? 'Invalid username/app key');
        }
      }

      // If bridgeid is missing, likely bad credentials
      if (!data['bridgeid'] && !data['name']) {
        return this.authFailed('Unable to authenticate with Hue Bridge. Check your username/app key.');
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to Hue Bridge at ${this.config.bridgeIp}: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Start polling for state changes to emit inbound messages
    this.startPolling();

    this.connected = true;
    this.log('info', 'Connected to Hue Bridge', { bridgeIp: this.config.bridgeIp });

    return {
      success: true,
      message: 'Philips Hue connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    this.connected = false;
    this.config = null;
    this.lastLightStates.clear();
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Philips Hue adapter is not connected' };
    }

    // Parse the outbound message content as a Hue command
    const command = this.parseCommand(message.content);
    if (!command) {
      return { success: false, message: `Unable to parse Hue command: ${message.content}` };
    }

    // Execute the parsed command
    try {
      switch (command.action) {
        case 'get-light':
          return this.getLight(command.lightId ?? message.to);

        case 'set-light':
          return this.setLightState(
            command.lightId ?? message.to,
            command.state ?? {},
          );

        case 'toggle':
          return this.toggleLight(command.lightId ?? command.groupId ?? message.to);

        case 'set-scene':
          return this.activateScene(command.sceneId ?? message.to, command.groupId);

        case 'list-rooms':
          return this.listRooms();

        case 'list-lights':
          return this.listLights();

        default:
          return { success: false, message: `Unknown Hue action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Hue operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Hue API operations ─────────────────────────────────

  /**
   * Get the current state of a single light.
   */
  private async getLight(lightId: string): Promise<SendResult> {
    const response = await this.hueFetch(`/lights/${lightId}`);
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get light failed: ${errorBody}` };
    }

    const data = (await response.json()) as {
      name?: string;
      state?: { on?: boolean; bri?: number; hue?: number; sat?: number; ct?: number; reachable?: boolean; colormode?: string };
      type?: string;
      modelid?: string;
    };

    const status: HueDeviceStatus = {
      type: 'light',
      id: lightId,
      name: data.name ?? `Light ${lightId}`,
      state: {
        on: data.state?.on,
        brightness: data.state?.bri,
        hue: data.state?.hue,
        saturation: data.state?.sat,
        colorTemp: data.state?.ct,
        reachable: data.state?.reachable,
        colorMode: data.state?.colormode,
        model: data.modelid,
        type: data.type,
      },
    };

    return {
      success: true,
      message: JSON.stringify(status),
    };
  }

  /**
   * Set the state of a single light.
   */
  private async setLightState(lightId: string, state: HueLightState): Promise<SendResult> {
    const response = await this.hueFetch(`/lights/${lightId}/state`, {
      method: 'PUT',
      body: JSON.stringify(state),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Set light state failed: ${errorBody}` };
    }

    const results = (await response.json()) as Array<{ success?: Record<string, unknown>; error?: { description: string } }>;

    // Check for errors in the response array
    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      const errorMessages = errors.map((e) => e.error?.description).join(', ');
      return { success: false, message: `Hue errors: ${errorMessages}` };
    }

    const status: HueDeviceStatus = {
      type: 'light',
      id: lightId,
      name: `Light ${lightId}`,
      state: { ...state, applied: true },
    };

    return {
      success: true,
      message: JSON.stringify(status),
    };
  }

  /**
   * Toggle a light on/off. If it's on, turn it off and vice versa.
   */
  private async toggleLight(lightId: string): Promise<SendResult> {
    // First get the current state
    const response = await this.hueFetch(`/lights/${lightId}`);
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Toggle failed (get state): ${errorBody}` };
    }

    const data = (await response.json()) as { name?: string; state?: { on?: boolean } };
    const currentlyOn = data.state?.on ?? false;
    const newState = !currentlyOn;

    // Set the opposite state
    const setResponse = await this.hueFetch(`/lights/${lightId}/state`, {
      method: 'PUT',
      body: JSON.stringify({ on: newState }),
    });

    if (!setResponse.ok) {
      const errorBody = await setResponse.text();
      return { success: false, message: `Toggle failed (set state): ${errorBody}` };
    }

    const status: HueDeviceStatus = {
      type: 'light',
      id: lightId,
      name: data.name ?? `Light ${lightId}`,
      state: { on: newState, toggled: true, previousState: currentlyOn },
    };

    return {
      success: true,
      message: JSON.stringify(status),
    };
  }

  /**
   * Activate a scene on the bridge, optionally within a specific group.
   */
  private async activateScene(sceneId: string, groupId?: string): Promise<SendResult> {
    const targetGroup = groupId ?? '0'; // Group 0 = all lights
    const response = await this.hueFetch(`/groups/${targetGroup}/action`, {
      method: 'PUT',
      body: JSON.stringify({ scene: sceneId }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Activate scene failed: ${errorBody}` };
    }

    const status: HueDeviceStatus = {
      type: 'scene',
      id: sceneId,
      name: `Scene ${sceneId}`,
      state: { activated: true, group: targetGroup },
    };

    return {
      success: true,
      message: JSON.stringify(status),
    };
  }

  /**
   * List all rooms/groups on the bridge.
   */
  private async listRooms(): Promise<SendResult> {
    const response = await this.hueFetch('/groups');
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `List rooms failed: ${errorBody}` };
    }

    const data = (await response.json()) as Record<string, {
      name?: string;
      type?: string;
      lights?: string[];
      state?: { all_on?: boolean; any_on?: boolean };
    }>;

    const rooms = Object.entries(data).map(([id, group]) => ({
      type: 'group' as const,
      id,
      name: group.name ?? `Group ${id}`,
      state: {
        type: group.type,
        lights: group.lights,
        allOn: group.state?.all_on,
        anyOn: group.state?.any_on,
      },
    }));

    return {
      success: true,
      message: JSON.stringify(rooms),
    };
  }

  /**
   * List all lights on the bridge.
   */
  private async listLights(): Promise<SendResult> {
    const response = await this.hueFetch('/lights');
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `List lights failed: ${errorBody}` };
    }

    const data = (await response.json()) as Record<string, {
      name?: string;
      type?: string;
      state?: { on?: boolean; bri?: number; reachable?: boolean };
      modelid?: string;
    }>;

    const lights = Object.entries(data).map(([id, light]) => ({
      type: 'light' as const,
      id,
      name: light.name ?? `Light ${id}`,
      state: {
        on: light.state?.on,
        brightness: light.state?.bri,
        reachable: light.state?.reachable,
        model: light.modelid,
        type: light.type,
      },
    }));

    return {
      success: true,
      message: JSON.stringify(lights),
    };
  }

  // ─── Private: Polling for state changes ─────────────────────────

  /**
   * Start polling the bridge for light state changes.
   * Emits inbound messages when a light's on/off state changes
   * (e.g., toggled via physical switch or another app).
   */
  private startPolling(): void {
    if (!this.config) return;

    // Initialize light states
    this.initializeLightStates().catch((err) => {
      this.log('warn', 'Failed to initialize light states for polling', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.pollTimer = setInterval(() => {
      this.pollForStateChanges().catch((err) => {
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
   * Capture the initial on/off state for all lights.
   */
  private async initializeLightStates(): Promise<void> {
    const response = await this.hueFetch('/lights');
    if (!response.ok) return;

    const data = (await response.json()) as Record<string, { state?: { on?: boolean } }>;
    for (const [id, light] of Object.entries(data)) {
      this.lastLightStates.set(id, light.state?.on ?? false);
    }
  }

  /**
   * Poll the bridge for light state changes and emit inbound messages
   * when a light's state differs from the last known state.
   */
  private async pollForStateChanges(): Promise<void> {
    const response = await this.hueFetch('/lights');
    if (!response.ok) {
      this.log('warn', 'Poll query failed', { status: response.status });
      return;
    }

    const data = (await response.json()) as Record<string, {
      name?: string;
      state?: { on?: boolean; bri?: number };
    }>;

    for (const [id, light] of Object.entries(data)) {
      const currentOn = light.state?.on ?? false;
      const previousOn = this.lastLightStates.get(id);

      // Emit inbound if state changed (or if this is a newly discovered light)
      if (previousOn !== undefined && previousOn !== currentOn) {
        const statusPayload = JSON.stringify({
          event: 'state-change',
          lightId: id,
          name: light.name ?? `Light ${id}`,
          previousState: { on: previousOn },
          currentState: { on: currentOn, brightness: light.state?.bri },
        });

        this.emitInbound('hue-bridge', statusPayload, 'text');
      }

      this.lastLightStates.set(id, currentOn);
    }
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured Hue command.
   * Supports both JSON-format commands and natural language patterns:
   * - "get light <id>"
   * - "set light <id> on/off" or "set light <id> brightness 200"
   * - "toggle <id>"
   * - "set scene <sceneId> [in group <groupId>]"
   * - "list rooms" / "list lights"
   */
  private parseCommand(content: string): HueCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as HueCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "list rooms"
    if (/^list\s+rooms?$/i.test(lower)) {
      return { action: 'list-rooms' };
    }

    // Pattern: "list lights"
    if (/^list\s+lights?$/i.test(lower)) {
      return { action: 'list-lights' };
    }

    // Pattern: "get light <id>"
    const getMatch = lower.match(/^get\s+light\s+(\S+)$/i);
    if (getMatch && getMatch[1]) {
      return { action: 'get-light', lightId: getMatch[1] };
    }

    // Pattern: "toggle <id>" or "toggle light <id>"
    const toggleMatch = lower.match(/^toggle\s+(?:light\s+)?(\S+)$/i);
    if (toggleMatch && toggleMatch[1]) {
      return { action: 'toggle', lightId: toggleMatch[1] };
    }

    // Pattern: "set scene <sceneId> [in group <groupId>]"
    const sceneMatch = lower.match(/^(?:set|activate)\s+scene\s+(\S+)(?:\s+(?:in\s+)?group\s+(\S+))?$/i);
    if (sceneMatch && sceneMatch[1]) {
      return {
        action: 'set-scene',
        sceneId: sceneMatch[1],
        groupId: sceneMatch[2] || undefined,
      };
    }

    // Pattern: "set light <id> <state properties>"
    const setMatch = lower.match(/^set\s+light\s+(\S+)\s+(.+)$/i);
    if (setMatch && setMatch[1] && setMatch[2]) {
      const lightId = setMatch[1];
      const stateStr = setMatch[2];
      const state = this.parseStateString(stateStr);
      return { action: 'set-light', lightId, state };
    }

    // Pattern: "turn on/off <id>" or "turn <id> on/off"
    const turnMatch = lower.match(/^turn\s+(?:(on|off)\s+(?:light\s+)?(\S+)|(?:light\s+)?(\S+)\s+(on|off))$/i);
    if (turnMatch) {
      const onOff = turnMatch[1] ?? turnMatch[4];
      const lightId = turnMatch[2] ?? turnMatch[3];
      if (lightId) {
        return { action: 'set-light', lightId, state: { on: onOff === 'on' } };
      }
    }

    return null;
  }

  /**
   * Parse a natural language state description into HueLightState.
   * Examples: "on", "off", "brightness 200", "on brightness 150 hue 30000"
   */
  private parseStateString(stateStr: string): HueLightState {
    const state: HueLightState = {};
    const lower = stateStr.toLowerCase();

    if (lower.includes('on')) state.on = true;
    if (lower.includes('off')) state.on = false;

    const briMatch = lower.match(/(?:brightness|bri)\s+(\d+)/);
    if (briMatch?.[1]) state.bri = Math.min(254, Math.max(1, parseInt(briMatch[1], 10)));

    const hueMatch = lower.match(/hue\s+(\d+)/);
    if (hueMatch?.[1]) state.hue = Math.min(65535, Math.max(0, parseInt(hueMatch[1], 10)));

    const satMatch = lower.match(/(?:saturation|sat)\s+(\d+)/);
    if (satMatch?.[1]) state.sat = Math.min(254, Math.max(0, parseInt(satMatch[1], 10)));

    const ctMatch = lower.match(/(?:ct|color.?temp)\s+(\d+)/);
    if (ctMatch?.[1]) state.ct = Math.min(500, Math.max(153, parseInt(ctMatch[1], 10)));

    return state;
  }

  // ─── Private: Hue Bridge fetch helper ───────────────────────────

  /**
   * Make a request to the Hue Bridge local REST API.
   * Uses the configured bridge IP and username for authentication.
   */
  private async hueFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('Philips Hue adapter is not configured');
    }

    const url = `${this.apiBase}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }
}
