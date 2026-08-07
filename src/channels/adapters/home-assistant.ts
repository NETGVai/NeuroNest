// ─── Home Assistant Adapter ──────────────────────────────────────
// Full ChannelAdapter implementation for Home Assistant smart home
// using the REST API (POST /api/services/..., GET /api/states/...)
// and WebSocket API (ws://<url>/api/websocket) for real-time state
// change subscriptions. Supports service calls, entity states,
// and automation triggers. Emits inbound messages on state changes
// via WebSocket subscription.
//
// Requirements: REQ 1.1, REQ 1.2, REQ 1.3, REQ 1.4, REQ 1.5,
// REQ 4.3, REQ 8.4, REQ 8.5, REQ 8.6

import { z } from 'zod';
import { BaseChannelAdapter } from './base-adapter';
import type { AdapterContext } from '../types/adapter';
import type { OutgoingMessage, ConnectResult, SendResult } from '../types/messages';
import type { AdapterCapabilities } from '../types/capabilities';
import type { TileMetadata } from '../types/tile-metadata';

// ─── Config Schema (REQ 1.6) ────────────────────────────────────

/**
 * Zod schema for Home Assistant adapter configuration.
 * Requires the base URL of the Home Assistant instance and a long-lived
 * access token generated from the user's HA profile.
 */
export const HomeAssistantConfigSchema = z.object({
  /** Base URL of the Home Assistant instance (e.g., http://homeassistant.local:8123) */
  baseUrl: z.string().url(),
  /** Long-lived access token from Home Assistant profile */
  accessToken: z.string().min(1),
  /** Optional list of entity IDs to subscribe to for state changes (default: all) */
  entityFilter: z.array(z.string()).optional(),
});

export type HomeAssistantConfig = z.infer<typeof HomeAssistantConfigSchema>;

// ─── Types ──────────────────────────────────────────────────────

/** Supported Home Assistant command actions (REQ 8.5) */
type HomeAssistantAction =
  | 'call-service'
  | 'get-state'
  | 'get-states'
  | 'trigger-automation'
  | 'list-entities'
  | 'list-services';

/** Parsed inbound command structure */
interface HomeAssistantCommand {
  action: HomeAssistantAction;
  domain?: string | undefined;
  service?: string | undefined;
  entityId?: string | undefined;
  serviceData?: Record<string, unknown> | undefined;
}

/** Home Assistant entity state object */
interface HAEntityState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

/** WebSocket message from Home Assistant */
interface HAWebSocketMessage {
  id?: number;
  type: string;
  success?: boolean;
  result?: unknown;
  event?: {
    event_type: string;
    data: {
      entity_id?: string;
      old_state?: HAEntityState;
      new_state?: HAEntityState;
    };
  };
  ha_version?: string;
  message?: string;
}

// ─── Home Assistant Adapter ─────────────────────────────────────

export class HomeAssistantAdapter extends BaseChannelAdapter {
  readonly channelId = 'home-assistant';

  readonly capabilities: AdapterCapabilities = {
    direction: 'bidirectional',
    supportsTyping: false,
    supportsRichMedia: false,
    deliveryMode: 'websocket',
    requiresListener: false,
    implementationStatus: 'available',
  };

  readonly tileMetadata: TileMetadata = {
    displayName: 'Home Assistant',
    emoji: '🏠',
    description: 'Smart home control and automation',
    actionTags: ['service call', 'entity state', 'automation', 'status'],
    sortOrder: 1040,
  };

  readonly configSchema = HomeAssistantConfigSchema;

  private config: HomeAssistantConfig | null = null;
  private ws: WebSocket | null = null;
  private wsMessageId = 1;
  private subscriptionId: number | null = null;

  /** Construct the REST API base URL */
  private get restBase(): string {
    if (!this.config) throw new Error('Home Assistant adapter is not configured');
    // Remove trailing slash if present
    return this.config.baseUrl.replace(/\/$/, '');
  }

  /** Construct the WebSocket URL from the base URL */
  private get wsUrl(): string {
    if (!this.config) throw new Error('Home Assistant adapter is not configured');
    const base = this.config.baseUrl.replace(/\/$/, '');
    // Convert http(s):// to ws(s)://
    const wsBase = base.replace(/^http/, 'ws');
    return `${wsBase}/api/websocket`;
  }

  async connect(config: unknown, context: AdapterContext): Promise<ConnectResult> {
    this.ctx = context;

    // Validate config
    const parsed = this.configSchema.safeParse(config);
    if (!parsed.success) {
      const msg =
        'Home Assistant adapter requires a base URL and long-lived access token.\n\n' +
        'Setup steps:\n' +
        '1. Open your Home Assistant instance in a browser\n' +
        '2. Go to Profile → Long-Lived Access Tokens\n' +
        '3. Create a new token and copy it\n' +
        '4. Provide the base URL (e.g., http://homeassistant.local:8123)\n\n' +
        `Validation errors: ${parsed.error.message}`;
      return {
        success: false,
        message: msg,
        error: { code: 'CONFIG_INVALID', message: msg },
      };
    }

    this.config = parsed.data;

    // Verify REST API connectivity and authentication
    try {
      const verifyResult = await this.verifyConnection();
      if (!verifyResult.success) {
        return verifyResult;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to connect to Home Assistant at ${this.config.baseUrl}: ${errMsg}`,
        error: { code: 'PROVIDER_ERROR', message: errMsg },
      };
    }

    // Establish WebSocket connection for state change subscriptions (REQ 8.6)
    try {
      await this.connectWebSocket();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // WebSocket failure is non-fatal — REST API still works
      this.log('warn', 'WebSocket connection failed (state subscriptions unavailable)', {
        error: errMsg,
      });
    }

    this.connected = true;
    this.log('info', 'Connected to Home Assistant', { baseUrl: this.config.baseUrl });

    return {
      success: true,
      message: 'Home Assistant connected successfully',
    };
  }

  async disconnect(): Promise<void> {
    this.disconnectWebSocket();
    this.connected = false;
    this.config = null;
    this.ctx = null;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (!this.connected || !this.config) {
      return { success: false, message: 'Home Assistant adapter is not connected' };
    }

    // Parse the outbound message content as a command
    const command = this.parseCommand(message.content);
    if (!command) {
      // Default to get-states if we can't parse the command
      return this.getAllStates();
    }

    // Execute the parsed command (REQ 8.4, REQ 8.5)
    try {
      switch (command.action) {
        case 'call-service':
          return this.callService(
            command.domain ?? 'homeassistant',
            command.service ?? 'toggle',
            command.entityId,
            command.serviceData,
          );

        case 'get-state':
          return this.getEntityState(command.entityId ?? '');

        case 'get-states':
          return this.getAllStates();

        case 'trigger-automation':
          return this.triggerAutomation(command.entityId ?? '');

        case 'list-entities':
          return this.listEntities(command.domain);

        case 'list-services':
          return this.listServices(command.domain);

        default:
          return { success: false, message: `Unknown Home Assistant action: ${command.action}` };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log('error', 'Send failed', { error: errMsg });
      return { success: false, message: `Home Assistant operation failed: ${errMsg}` };
    }
  }

  // ─── Private: Connection verification ─────────────────────────

  /**
   * Verify REST API connectivity by calling GET /api/ which returns
   * a simple { message: "API running." } response.
   */
  private async verifyConnection(): Promise<ConnectResult> {
    const response = await this.restFetch('/api/');
    if (!response.ok) {
      if (response.status === 401) {
        return this.authFailed('Invalid or expired long-lived access token.');
      }
      const errorBody = await response.text();
      return {
        success: false,
        message: `Home Assistant API error (${response.status}): ${errorBody}`,
        error: { code: 'PROVIDER_ERROR', message: errorBody },
      };
    }

    const data = (await response.json()) as { message?: string };
    if (!data.message) {
      return {
        success: false,
        message: 'Unexpected response from Home Assistant API',
        error: { code: 'PROVIDER_ERROR', message: 'Invalid API response' },
      };
    }

    return { success: true, message: 'Verified' };
  }

  // ─── Private: WebSocket connection (REQ 8.6) ──────────────────

  /**
   * Establish a WebSocket connection to Home Assistant for real-time
   * state change subscriptions. The connection flow is:
   * 1. Connect to ws://<url>/api/websocket
   * 2. Receive auth_required message
   * 3. Send auth message with access token
   * 4. Receive auth_ok or auth_invalid
   * 5. Subscribe to state_changed events
   */
  private connectWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.config) {
        reject(new Error('Not configured'));
        return;
      }

      try {
        this.ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(err);
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timed out'));
      }, 10000);

      this.ws.onopen = () => {
        this.log('info', 'WebSocket connected, awaiting auth_required');
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(String(event.data)) as HAWebSocketMessage;
          this.handleWsMessage(msg, resolve, reject, timeout);
        } catch (err) {
          this.log('error', 'Failed to parse WebSocket message', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        const errMsg = 'WebSocket error occurred';
        this.log('error', errMsg);
        reject(new Error(errMsg));
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        this.subscriptionId = null;
        this.log('info', 'WebSocket connection closed');
      };
    });
  }

  /**
   * Handle incoming WebSocket messages during connection setup
   * and state change event processing.
   */
  private handleWsMessage(
    msg: HAWebSocketMessage,
    onConnected?: (value: void) => void,
    onError?: (reason: Error) => void,
    timeout?: ReturnType<typeof setTimeout>,
  ): void {
    switch (msg.type) {
      case 'auth_required':
        // Send authentication
        this.wsSend({
          type: 'auth',
          access_token: this.config!.accessToken,
        });
        break;

      case 'auth_ok':
        if (timeout) clearTimeout(timeout);
        this.log('info', 'WebSocket authenticated', { ha_version: msg.ha_version });
        // Subscribe to state_changed events
        this.subscribeToStateChanges();
        onConnected?.();
        break;

      case 'auth_invalid':
        if (timeout) clearTimeout(timeout);
        this.log('error', 'WebSocket auth failed', { message: msg.message });
        onError?.(new Error(msg.message ?? 'Authentication failed'));
        break;

      case 'result':
        // Subscription confirmation or other result
        if (msg.success && msg.id === this.subscriptionId) {
          this.log('info', 'Subscribed to state_changed events');
        }
        break;

      case 'event':
        // State change event (REQ 8.6)
        this.handleStateChangeEvent(msg);
        break;

      default:
        // Ignore unknown message types
        break;
    }
  }

  /**
   * Subscribe to state_changed events via the WebSocket connection.
   */
  private subscribeToStateChanges(): void {
    const id = this.wsMessageId++;
    this.subscriptionId = id;

    this.wsSend({
      id,
      type: 'subscribe_events',
      event_type: 'state_changed',
    });
  }

  /**
   * Handle a state_changed event from Home Assistant WebSocket.
   * Emits an inbound message reporting the state change (REQ 8.6).
   */
  private handleStateChangeEvent(msg: HAWebSocketMessage): void {
    if (!msg.event?.data) return;

    const { entity_id, old_state, new_state } = msg.event.data;
    if (!entity_id || !new_state) return;

    // Apply entity filter if configured
    if (this.config?.entityFilter && this.config.entityFilter.length > 0) {
      const matches = this.config.entityFilter.some(
        (filter) => entity_id === filter || entity_id.startsWith(filter + '.'),
      );
      if (!matches) return;
    }

    // Only emit if state actually changed (not just attribute updates)
    if (old_state && old_state.state === new_state.state) return;

    const stateChangePayload = JSON.stringify({
      event: 'state_changed',
      entity_id,
      old_state: old_state
        ? { state: old_state.state, attributes: old_state.attributes }
        : null,
      new_state: {
        state: new_state.state,
        attributes: new_state.attributes,
        last_changed: new_state.last_changed,
      },
    });

    this.emitInbound(entity_id, stateChangePayload, 'text');
  }

  /**
   * Send a message through the WebSocket connection.
   */
  private wsSend(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('warn', 'Cannot send WebSocket message — not connected');
      return;
    }
    this.ws.send(JSON.stringify(data));
  }

  /**
   * Close the WebSocket connection and clean up.
   */
  private disconnectWebSocket(): void {
    if (this.ws) {
      this.ws.onclose = null; // Prevent reconnection logic on intentional close
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.subscriptionId = null;
  }

  // ─── Private: REST API operations (REQ 8.4, REQ 8.5) ─────────

  /**
   * Call a Home Assistant service (REQ 8.5).
   * POST /api/services/<domain>/<service>
   */
  private async callService(
    domain: string,
    service: string,
    entityId?: string,
    serviceData?: Record<string, unknown>,
  ): Promise<SendResult> {
    const body: Record<string, unknown> = { ...serviceData };
    if (entityId) {
      body['entity_id'] = entityId;
    }

    const response = await this.restFetch(`/api/services/${domain}/${service}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Service call failed: ${errorBody}` };
    }

    const result = await response.json();

    return {
      success: true,
      message: JSON.stringify({
        action: 'call-service',
        domain,
        service,
        entityId: entityId ?? null,
        result: Array.isArray(result) ? result.map((s: HAEntityState) => ({
          entity_id: s.entity_id,
          state: s.state,
        })) : result,
      }, null, 2),
    };
  }

  /**
   * Get the state of a single entity (REQ 8.5).
   * GET /api/states/<entity_id>
   */
  private async getEntityState(entityId: string): Promise<SendResult> {
    if (!entityId) {
      return { success: false, message: 'Entity ID is required for get-state' };
    }

    const response = await this.restFetch(`/api/states/${entityId}`);
    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, message: `Entity not found: ${entityId}` };
      }
      const errorBody = await response.text();
      return { success: false, message: `Get state failed: ${errorBody}` };
    }

    const state = (await response.json()) as HAEntityState;

    return {
      success: true,
      message: JSON.stringify({
        action: 'get-state',
        entity_id: state.entity_id,
        state: state.state,
        attributes: state.attributes,
        last_changed: state.last_changed,
        last_updated: state.last_updated,
      }, null, 2),
    };
  }

  /**
   * Get all entity states.
   * GET /api/states
   */
  private async getAllStates(): Promise<SendResult> {
    const response = await this.restFetch('/api/states');
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `Get states failed: ${errorBody}` };
    }

    const states = (await response.json()) as HAEntityState[];

    // Apply entity filter if configured
    let filteredStates = states;
    if (this.config?.entityFilter && this.config.entityFilter.length > 0) {
      filteredStates = states.filter((s) =>
        this.config!.entityFilter!.some(
          (filter) => s.entity_id === filter || s.entity_id.startsWith(filter + '.'),
        ),
      );
    }

    const summary = filteredStates.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      last_changed: s.last_changed,
    }));

    return {
      success: true,
      message: JSON.stringify({
        action: 'get-states',
        count: summary.length,
        entities: summary,
      }, null, 2),
    };
  }

  /**
   * Trigger an automation (REQ 8.5).
   * POST /api/services/automation/trigger with entity_id
   */
  private async triggerAutomation(entityId: string): Promise<SendResult> {
    if (!entityId) {
      return { success: false, message: 'Automation entity ID is required' };
    }

    // Ensure the entity ID has the automation domain prefix
    const automationId = entityId.startsWith('automation.')
      ? entityId
      : `automation.${entityId}`;

    return this.callService('automation', 'trigger', automationId);
  }

  /**
   * List entities, optionally filtered by domain.
   * GET /api/states and filter by domain prefix.
   */
  private async listEntities(domain?: string): Promise<SendResult> {
    const response = await this.restFetch('/api/states');
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `List entities failed: ${errorBody}` };
    }

    const states = (await response.json()) as HAEntityState[];

    let filtered = states;
    if (domain) {
      filtered = states.filter((s) => s.entity_id.startsWith(`${domain}.`));
    }

    const entities = filtered.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      friendly_name: (s.attributes?.['friendly_name'] as string) ?? s.entity_id,
    }));

    return {
      success: true,
      message: JSON.stringify({
        action: 'list-entities',
        domain: domain ?? 'all',
        count: entities.length,
        entities,
      }, null, 2),
    };
  }

  /**
   * List available services, optionally filtered by domain.
   * GET /api/services
   */
  private async listServices(domain?: string): Promise<SendResult> {
    const response = await this.restFetch('/api/services');
    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, message: `List services failed: ${errorBody}` };
    }

    const services = (await response.json()) as Array<{
      domain: string;
      services: Record<string, { description?: string }>;
    }>;

    let filtered = services;
    if (domain) {
      filtered = services.filter((s) => s.domain === domain);
    }

    const result = filtered.map((s) => ({
      domain: s.domain,
      services: Object.keys(s.services),
    }));

    return {
      success: true,
      message: JSON.stringify({
        action: 'list-services',
        domain: domain ?? 'all',
        domains: result,
      }, null, 2),
    };
  }

  // ─── Private: Command parsing ───────────────────────────────────

  /**
   * Parse message content into a structured Home Assistant command.
   * Supports JSON-format commands and natural language patterns:
   * - "get state <entity_id>"
   * - "get states" / "list states"
   * - "call service <domain>.<service> [entity_id] [data JSON]"
   * - "trigger automation <entity_id>"
   * - "list entities [domain]"
   * - "list services [domain]"
   * - "turn on/off <entity_id>"
   * - "toggle <entity_id>"
   */
  private parseCommand(content: string): HomeAssistantCommand | null {
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.action) {
        return parsed as HomeAssistantCommand;
      }
    } catch {
      // Not JSON, try natural language patterns
    }

    const lower = content.toLowerCase().trim();

    // Pattern: "get states" / "list states" / "all states"
    if (/^(?:get|list|all)\s+states?$/i.test(lower)) {
      return { action: 'get-states' };
    }

    // Pattern: "get state <entity_id>"
    const getStateMatch = lower.match(/^get\s+state\s+(\S+)$/i);
    if (getStateMatch && getStateMatch[1]) {
      return { action: 'get-state', entityId: getStateMatch[1] };
    }

    // Pattern: "trigger automation <entity_id>"
    const triggerMatch = lower.match(/^trigger\s+(?:automation\s+)?(\S+)$/i);
    if (triggerMatch && triggerMatch[1]) {
      return { action: 'trigger-automation', entityId: triggerMatch[1] };
    }

    // Pattern: "list entities [domain]"
    const listEntMatch = lower.match(/^list\s+entities?\s*(\S*)$/i);
    if (listEntMatch) {
      return { action: 'list-entities', domain: listEntMatch[1] || undefined };
    }

    // Pattern: "list services [domain]"
    const listSvcMatch = lower.match(/^list\s+services?\s*(\S*)$/i);
    if (listSvcMatch) {
      return { action: 'list-services', domain: listSvcMatch[1] || undefined };
    }

    // Pattern: "turn on <entity_id>" / "turn off <entity_id>"
    const turnMatch = lower.match(/^turn\s+(on|off)\s+(\S+)$/i);
    if (turnMatch && turnMatch[1] && turnMatch[2]) {
      const domain = turnMatch[2].split('.')[0] ?? 'homeassistant';
      return {
        action: 'call-service',
        domain,
        service: `turn_${turnMatch[1]}`,
        entityId: turnMatch[2],
      };
    }

    // Pattern: "toggle <entity_id>"
    const toggleMatch = lower.match(/^toggle\s+(\S+)$/i);
    if (toggleMatch && toggleMatch[1]) {
      const domain = toggleMatch[1].split('.')[0] ?? 'homeassistant';
      return {
        action: 'call-service',
        domain,
        service: 'toggle',
        entityId: toggleMatch[1],
      };
    }

    // Pattern: "call service <domain>.<service> [entity_id] [data]"
    const callMatch = content.match(
      /^call\s+(?:service\s+)?(\w+)\.(\w+)(?:\s+(\S+))?(?:\s+(.+))?$/i,
    );
    if (callMatch && callMatch[1] && callMatch[2]) {
      let serviceData: Record<string, unknown> | undefined;
      if (callMatch[4]) {
        try {
          serviceData = JSON.parse(callMatch[4]) as Record<string, unknown>;
        } catch {
          // Ignore parse failure — proceed without serviceData
        }
      }
      return {
        action: 'call-service',
        domain: callMatch[1],
        service: callMatch[2],
        entityId: callMatch[3] || undefined,
        serviceData,
      };
    }

    return null;
  }

  // ─── Private: REST API fetch helper ─────────────────────────────

  /**
   * Make an authenticated request to the Home Assistant REST API.
   * Uses Bearer token auth with the long-lived access token.
   */
  private async restFetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    if (!this.config) {
      throw new Error('Home Assistant adapter is not configured');
    }

    const url = `${this.restBase}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    };

    return fetch(url, {
      ...options,
      headers,
    });
  }
}
