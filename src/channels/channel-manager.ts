// ─── ChannelManager Orchestrator ────────────────────────────────
// Lean orchestrator: owns the AdapterRegistry, fans out events,
// schedules reconnects, and constructs a per-adapter AdapterContext.
// All provider-specific logic lives in individual adapter files.
//
// Requirements: REQ 3.4, REQ 3.5, REQ 5.1–5.4, REQ 6.3–6.5,
// REQ 14.1–14.5, REQ 15.1–15.6, REQ 20.1–20.5, REQ 21.4,
// REQ 22.2–22.4, REQ 24.3–24.7, REQ 26.5, REQ 27.5, REQ 27.6,
// REQ 28.1–28.7

import { EventEmitter } from 'events';
import { AdapterRegistry } from './registry';
import { SessionContextStore } from './session-context-store';
import type { SessionEntry } from './session-context-store';
import type { ChannelAdapter, AdapterContext, AdapterFactory } from './types/adapter';
import type {
  IncomingMessage,
  OutgoingMessage,
  ConnectResult,
  SendResult,
  ChannelConnection,
} from './types/messages';
import type { ChannelStatus, AdapterCapabilities } from './types/capabilities';
import type { ErrorCode } from './types/errors';
import type { ListenerConfig } from './listener-config';
import {
  buildListenerConfig,
  validateListenerPair,
} from './listener-config';

// ── AI Pipeline Interface ───────────────────────────────────────

/**
 * Contract for the AI processing pipeline that handles inbound channel
 * messages. Callers provide an implementation (e.g., the LLM client or
 * SwarmCoordinator) when wiring the channel manager.
 *
 * @satisfies REQ 2.1, REQ 2.5
 */
export interface AIPipelineInterface {
  /**
   * Process user input with conversation history context.
   * @param message - The user's message content
   * @param history - Previous messages in the session (oldest first)
   * @param metadata - Routing metadata (channelId, senderId)
   * @returns The AI-generated response text
   */
  process(
    message: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    metadata: { channelId: string; senderId: string },
  ): Promise<string>;

  /**
   * Process user input and stream response tokens as they generate.
   * Optional — when present and the adapter supports streaming delivery,
   * the ChannelManager will use this to pipe partial tokens to the channel.
   *
   * @param message - The user's message content
   * @param history - Previous messages in the session (oldest first)
   * @param metadata - Routing metadata (channelId, senderId)
   * @returns An async iterable of response token chunks
   *
   * @satisfies REQ 12.4
   */
  processStream?(
    message: string,
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    metadata: { channelId: string; senderId: string },
  ): AsyncIterable<string>;
}

// ── Re-export types so existing `import { ..., type X } from '../channels/channel-manager'` compile ──

export type { ChannelConnection, IncomingMessage, ConnectResult, SendResult, SessionEntry };

// ── Event constants ─────────────────────────────────────────────

export const CHANNEL_STATUS_EVENT = 'channel-status' as const;
export const CHANNEL_REGISTRY_EVENT = 'channel-registry' as const;
export const DELIVERY_FAILURE_EVENT = 'delivery-failure' as const;
export const CHANNEL_RELAY_EVENT = 'channel-relay' as const;

// ── Reconnection & Retry constants (REQ 11.1, 11.3) ─────────────

/** Maximum number of auto-reconnect attempts before giving up */
const RECONNECT_MAX_ATTEMPTS = 5;
/** Base delay (ms) for exponential reconnect backoff */
const RECONNECT_BASE_DELAY_MS = 1000;
/** Maximum delay (ms) between reconnect attempts — capped at 60s */
const RECONNECT_MAX_DELAY_MS = 60000;

/** Maximum number of send retries for transient errors */
const SEND_RETRY_MAX = 3;
/** Base delay (ms) for exponential send retry backoff */
const SEND_RETRY_BASE_MS = 500;
/** Maximum delay (ms) for send retry backoff */
const SEND_RETRY_MAX_DELAY_MS = 5000;

// ── Payload / Diagnostics types ─────────────────────────────────

export interface ChannelStatusPayload {
  channelId: string;
  status: ChannelStatus;
  qrCode?: string;
  error?: string;
  errorCode?: ErrorCode;
}

export interface DeliveryFailurePayload {
  channelId: string;
  to: string;
  error: string;
  attempts: number;
}

/**
 * Payload emitted on the 'channel-relay' event after processInbound
 * handles an inbound message. Contains the relay display metadata
 * for the chat-response IPC event (channelSource and relayTarget).
 *
 * @satisfies REQ 3.1, REQ 3.2, REQ 3.3, REQ 12.1, REQ 12.2, REQ 12.3
 */
export interface ChannelRelayPayload {
  /** The inbound message role ('user' for source display, 'assistant' for relay response). */
  role: 'user' | 'assistant';
  /** The message content to display. */
  content: string;
  /** Source metadata for inbound channel messages (present on role=user). */
  channelSource?: {
    channelId: string;
    displayName: string;
    emoji: string;
    from: string;
  };
  /** Relay metadata for outbound responses (present on role=assistant). */
  relayTarget?: {
    channelId: string;
    displayName: string;
    emoji: string;
    success: boolean;
  };
  /** Whether this is a channel-sourced message. */
  isChannelMessage: boolean;
  /** Whether the AI is currently streaming for this channel message. */
  isChannelStreaming?: boolean;
}

export interface Diagnostics {
  status: ChannelStatus;
  lastError?: string | undefined;
  reconnectAttempts: number;
  listenerConfig?: ListenerConfig | undefined;
}

// ── Per-adapter runtime state ───────────────────────────────────

interface ActiveInstance {
  adapter: ChannelAdapter;
  status: ChannelStatus;
  lastError?: string | undefined;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout> | undefined;
  listenerConfig?: ListenerConfig | undefined;
  lastConfig?: unknown;
}

// ── Scoped logger factory ───────────────────────────────────────

function makeScopedLogger(channelId: string) {
  const prefix = `[ChannelAdapter:${channelId}]`;
  return {
    info(msg: string, _extra?: Record<string, unknown>) {
      console.log(`${prefix} ${msg}`);
    },
    warn(msg: string, _extra?: Record<string, unknown>) {
      console.warn(`${prefix} ${msg}`);
    },
    error(msg: string, _extra?: Record<string, unknown>) {
      console.error(`${prefix} ${msg}`);
    },
  };
}

// ── ChannelManager ──────────────────────────────────────────────

export class ChannelManager {
  private readonly registry = new AdapterRegistry();
  private readonly instances = new Map<string, ActiveInstance>();
  private readonly emitter = new EventEmitter();
  private readonly sessionStore = new SessionContextStore();
  private aiPipeline: AIPipelineInterface | null = null;

  /**
   * Backward-compat shim: the pre-refactor ChannelManager exposed an internal
   * `channels` Map<string, { connection, stop, send }>`. Existing property tests
   * (REQ 25.4) insert mock handles via this map. This getter returns a proxy Map
   * that bridges old-format entries to the new ActiveInstance layout so those
   * tests continue to pass without assertion changes.
   * @internal — test-only compatibility surface; NOT part of the public API.
   */
  get channels(): Map<string, any> {
    const self = this;
    return new Proxy(this.instances as any, {
      get(target: Map<string, ActiveInstance>, prop: string | symbol) {
        if (prop === 'set') {
          return (channelId: string, handle: any) => {
            // Bridge old-format { connection, stop, send } → ActiveInstance
            const status = handle?.connection?.status ?? 'connected';
            const instance: ActiveInstance = {
              adapter: {
                channelId,
                capabilities: { direction: 'bidirectional', supportsTyping: false, supportsRichMedia: false, deliveryMode: 'push', requiresListener: false, implementationStatus: 'available' },
                tileMetadata: { displayName: channelId, emoji: '', description: '', actionTags: [] },
                configSchema: { safeParse: () => ({ success: true, data: {} }) } as any,
                connect: async () => ({ success: true, message: 'mock' }),
                disconnect: handle?.stop ?? (async () => {}),
                isConnected: () => status === 'connected',
                send: handle?.send ?? (async () => ({ success: true, message: 'mock' })),
              },
              status: status as ChannelStatus,
              reconnectAttempts: 0,
            };
            self.instances.set(channelId, instance);
          };
        }
        if (prop === 'size') {
          return self.instances.size;
        }
        if (prop === 'has') {
          return (key: string) => self.instances.has(key);
        }
        if (prop === 'get') {
          return (key: string) => self.instances.get(key);
        }
        if (prop === 'delete') {
          return (key: string) => self.instances.delete(key);
        }
        return Reflect.get(target, prop);
      },
    });
  }

  constructor() {
    // Attempt to register built-in adapters. During early development phases
    // the adapters/index module may not exist yet — handle gracefully (REQ 24.3).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { registerBuiltIns } = require('./adapters/index');
      registerBuiltIns(this.registry);
    } catch (_err) {
      // Built-in registration not available yet or failed — registry remains empty.
      // The manager is still functional: connect/send will return appropriate errors.
      console.warn('[ChannelManager] built-in registration skipped or failed:', (_err as Error)?.message);
    }
  }

  // ── Public API — signatures preserved (REQ 14) ─────────────────

  async connect(channelId: string, config: unknown): Promise<ConnectResult> {
    // Empty registry check (REQ 24.4) — must precede the per-channel check
    if (this.registry.list().length === 0) {
      return { success: false, message: 'No adapters registered' };
    }

    // Check registry has this channelId
    if (!this.registry.has(channelId)) {
      return {
        success: false,
        message: `Channel "${channelId}" is not registered.`,
      };
    }

    // If already connected, disconnect first
    // Preserve reconnect attempts count for reconnection logic (REQ 11.1)
    const previousReconnectAttempts = this.instances.get(channelId)?.reconnectAttempts ?? 0;
    if (this.instances.has(channelId)) {
      await this.disconnect(channelId);
    }

    // Instantiate adapter (lazy construction — REQ 22.4)
    let adapter: ChannelAdapter;
    try {
      adapter = this.registry.instantiate(channelId);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.emitter.emit(CHANNEL_STATUS_EVENT, {
        channelId,
        status: 'error',
        error: msg,
        errorCode: 'PROVIDER_ERROR' as ErrorCode,
      });
      return { success: false, message: msg, error: { code: 'PROVIDER_ERROR', message: msg } };
    }

    // Validate config via adapter's Zod schema (REQ 5.1, 5.2, 5.3)
    const parsed = adapter.configSchema.safeParse(config);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i: any) => i.path.join('.')).join(', ');
      const fieldError = `Invalid config for '${channelId}': fields = ${fields}`;
      const errorMsg = adapter.configHelp
        ? `${fieldError}\n\n${adapter.configHelp}`
        : fieldError;
      this.emitter.emit(CHANNEL_STATUS_EVENT, {
        channelId,
        status: 'error',
        error: errorMsg,
        errorCode: 'CONFIG_INVALID' as ErrorCode,
      });
      return { success: false, message: errorMsg, error: { code: 'CONFIG_INVALID', message: errorMsg } };
    }

    // Create active instance record (preserve reconnectAttempts if reconnecting)
    const instance: ActiveInstance = {
      adapter,
      status: 'connecting',
      reconnectAttempts: previousReconnectAttempts,
      lastConfig: config,
    };
    this.instances.set(channelId, instance);

    // Emit connecting status
    this.emitter.emit(CHANNEL_STATUS_EVENT, { channelId, status: 'connecting' });

    // Build adapter context (REQ 2.5, REQ 15.1)
    const ctx = this.buildContext(channelId, instance);

    // Invoke adapter.connect with validated config (REQ 5.4)
    try {
      const result = await adapter.connect(parsed.data, ctx);
      if (result.success) {
        instance.status = 'connected';
        instance.reconnectAttempts = 0; // REQ 11.1 — reset on successful connection
        this.emitter.emit(CHANNEL_STATUS_EVENT, { channelId, status: 'connected', qrCode: result.qrCode });
      } else {
        instance.status = 'error';
        instance.lastError = result.message;
        this.emitter.emit(CHANNEL_STATUS_EVENT, {
          channelId,
          status: 'error',
          error: result.message,
          errorCode: result.error?.code,
        });
        // Schedule reconnect for transient failures
        if (result.error?.code && result.error.code !== 'AUTH_FAILED' && result.error.code !== 'CONFIG_INVALID' && result.error.code !== 'SDK_MISSING') {
          this.scheduleReconnect(channelId, result.error.code);
        } else {
          // Permanent failure — reset reconnect attempts (REQ 20.4)
          instance.reconnectAttempts = 0;
        }
      }
      return result;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      instance.status = 'error';
      instance.lastError = msg;
      this.emitter.emit(CHANNEL_STATUS_EVENT, {
        channelId,
        status: 'error',
        error: msg,
        errorCode: 'PROVIDER_ERROR' as ErrorCode,
      });
      return { success: false, message: msg, error: { code: 'PROVIDER_ERROR', message: msg } };
    }
  }

  async disconnect(channelId: string): Promise<void> {
    const instance = this.instances.get(channelId);
    if (!instance) return;

    // Cancel any pending reconnect timer (REQ 20.5)
    if (instance.reconnectTimer) {
      clearTimeout(instance.reconnectTimer);
      delete instance.reconnectTimer;
    }

    // Emit status event synchronously so callers observe the transition immediately
    // (REQ 15.4, REQ 25.4 backward compat with existing property tests)
    instance.status = 'disconnected';
    delete instance.lastError;
    this.instances.delete(channelId);
    this.emitter.emit(CHANNEL_STATUS_EVENT, { channelId, status: 'disconnected' });

    // Perform async adapter cleanup after the event is emitted
    try {
      await instance.adapter.disconnect();
    } catch (err: any) {
      console.error(`[ChannelManager] disconnect(${channelId}) error:`, err?.message);
    }
  }

  async sendMessage(channelId: string, to: string, message: string): Promise<SendResult> {
    // Empty registry check (REQ 24.4)
    if (this.registry.list().length === 0) {
      return { success: false, message: 'No adapters registered' };
    }

    const instance = this.instances.get(channelId);
    if (!instance) {
      return { success: false, message: `Channel "${channelId}" is not connected.` };
    }
    if (instance.status !== 'connected') {
      return { success: false, message: `Channel "${channelId}" is ${instance.status}, not connected.` };
    }

    // Construct OutgoingMessage (REQ 3.4)
    const outgoing: OutgoingMessage = { to, content: message };

    // Discriminator mismatch check (REQ 3.5)
    // Note: providerMetadata is not passed via the simple sendMessage signature,
    // but we guard against it for internal/future usage
    if ((outgoing as any).providerMetadata && (outgoing as any).providerMetadata.channelId !== channelId) {
      return {
        success: false,
        message: `providerMetadata.channelId '${(outgoing as any).providerMetadata.channelId}' does not match send channelId '${channelId}'`,
      };
    }

    try {
      return await instance.adapter.send(outgoing);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      return { success: false, message: msg };
    }
  }

  // ── Send Retry Logic (REQ 11.3, 11.4) ─────────────────────────

  /**
   * Sends a message with automatic retries on transient errors.
   * Retries up to SEND_RETRY_MAX (3) times with exponential backoff.
   * If all retries are exhausted, emits a 'delivery-failure' event.
   *
   * @satisfies REQ 11.3, REQ 11.4
   */
  async sendWithRetry(channelId: string, to: string, message: string): Promise<SendResult> {
    for (let attempt = 0; attempt < SEND_RETRY_MAX; attempt++) {
      const result = await this.sendMessage(channelId, to, message);
      if (result.success) return result;

      // Only retry on transient errors — permanent errors bail immediately
      if (!this.isTransientError(result.message)) return result;

      // Don't sleep after the last failed attempt
      if (attempt < SEND_RETRY_MAX - 1) {
        const delay = Math.min(SEND_RETRY_BASE_MS * Math.pow(2, attempt), SEND_RETRY_MAX_DELAY_MS);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // All retry attempts exhausted — emit delivery-failure event
    const failurePayload: DeliveryFailurePayload = {
      channelId,
      to,
      error: 'All retry attempts exhausted',
      attempts: SEND_RETRY_MAX,
    };
    this.emitter.emit(DELIVERY_FAILURE_EVENT, failurePayload);

    return { success: false, message: 'All retry attempts exhausted' };
  }

  /**
   * Determines whether an error message indicates a transient failure
   * that may succeed on retry (network issues, rate limiting) vs a
   * permanent failure (auth, config, not connected).
   *
   * @satisfies REQ 11.3, 11.4
   */
  isTransientError(errorMessage: string): boolean {
    const msg = errorMessage.toLowerCase();
    const transientPatterns = [
      'timeout',
      'network',
      'rate limit',
      'rate_limit',
      'ratelimit',
      'too many requests',
      '429',
      '503',
      'service unavailable',
      'temporarily unavailable',
      'econnreset',
      'econnrefused',
      'enotfound',
      'socket hang up',
      'epipe',
      'etimedout',
    ];
    return transientPatterns.some(pattern => msg.includes(pattern));
  }

  /**
   * Handles connection loss for an adapter. Initiates auto-reconnect
   * with exponential backoff, max 5 attempts, max 60s delay.
   * Sets adapter status to 'error' if all reconnection attempts fail.
   *
   * @satisfies REQ 11.1, 11.2, 11.5
   */
  handleConnectionLoss(channelId: string): void {
    const instance = this.instances.get(channelId);
    if (!instance) return;

    instance.status = 'error';
    instance.lastError = 'Connection lost';
    this.emitter.emit(CHANNEL_STATUS_EVENT, {
      channelId,
      status: 'error',
      error: 'Connection lost',
      errorCode: 'NETWORK_ERROR' as ErrorCode,
    });

    // Start reconnection if under the attempt limit
    if (instance.reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
      this.scheduleReconnect(channelId, 'NETWORK_ERROR' as ErrorCode);
    }
  }

  /**
   * Register a handler for delivery-failure events (REQ 11.3).
   */
  onDeliveryFailure(handler: (payload: DeliveryFailurePayload) => void): void {
    this.emitter.on(DELIVERY_FAILURE_EVENT, handler);
  }

  /**
   * Register a handler for channel-relay events (REQ 3.1, 3.2, 3.3, 12.1, 12.2, 12.3).
   * The handler receives relay display metadata payloads that should be forwarded
   * to the chat-response IPC event for the renderer to display.
   */
  onChannelRelay(handler: (payload: ChannelRelayPayload) => void): void {
    this.emitter.on(CHANNEL_RELAY_EVENT, handler);
  }

  getStatus(channelId: string): ChannelConnection {
    const instance = this.instances.get(channelId);
    if (!instance) {
      return { id: channelId, status: 'disconnected' };
    }
    const conn: ChannelConnection = { id: channelId, status: instance.status };
    if (instance.lastError) {
      conn.error = instance.lastError;
    }
    return conn;
  }

  getAllStatuses(): ChannelConnection[] {
    return Array.from(this.instances.entries()).map(([id, inst]) => {
      const conn: ChannelConnection = { id, status: inst.status };
      if (inst.lastError) {
        conn.error = inst.lastError;
      }
      return conn;
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.emitter.on('message', handler);
  }

  onStatusChange(handler: (status: ChannelStatusPayload) => void): void {
    this.emitter.on(CHANNEL_STATUS_EVENT, handler);
  }

  async stopAll(): Promise<void> {
    const entries = Array.from(this.instances.entries());

    // Emit disconnected for every adapter synchronously first, and clean up
    // (REQ 15.4, REQ 25.4 backward compat with existing property tests that
    // do not await stopAll)
    for (const [id] of entries) {
      // Cancel reconnect timers synchronously
      const instance = this.instances.get(id);
      if (instance?.reconnectTimer) {
        clearTimeout(instance.reconnectTimer);
        delete instance.reconnectTimer;
      }
      this.emitter.emit(CHANNEL_STATUS_EVENT, { channelId: id, status: 'disconnected' });
    }
    this.instances.clear();
    this.emitter.removeAllListeners();

    // Then perform async adapter cleanup
    const results = await Promise.allSettled(
      entries.map(async ([id, instance]) => {
        await instance.adapter.disconnect();
        return id;
      }),
    );

    // Collect rejected channelIds and log once (REQ 22.3)
    const rejected: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === 'rejected') {
        rejected.push(entries[i]![0]);
      }
    }
    if (rejected.length > 0) {
      console.error(`[ChannelManager] stopAll – errors disconnecting: ${rejected.join(', ')}`);
    }
  }

  // ── New public API ─────────────────────────────────────────────

  /** REQ 6.4, REQ 27.4 — canonical enumeration for slash/IPC/IMGateway */
  listRegisteredChannels(): string[] {
    return this.registry.list();
  }

  /** REQ 21.4 — diagnostics for a given channel */
  getDiagnostics(channelId: string): Diagnostics {
    const instance = this.instances.get(channelId);
    if (!instance) {
      return { status: 'disconnected', reconnectAttempts: 0 };
    }
    const diag: Diagnostics = {
      status: instance.status,
      reconnectAttempts: instance.reconnectAttempts,
    };
    if (instance.lastError) {
      diag.lastError = instance.lastError;
    }
    if (instance.listenerConfig) {
      diag.listenerConfig = instance.listenerConfig;
    }
    return diag;
  }

  /**
   * REQ 3.1, 3.2 — Returns display metadata (emoji, displayName) for a channel.
   * Used by the IPC layer to populate channelSource/relayTarget on chat-response events.
   */
  getChannelDisplayInfo(channelId: string): { displayName: string; emoji: string } | null {
    const instance = this.instances.get(channelId);
    if (!instance) return null;
    return {
      displayName: instance.adapter.tileMetadata.displayName,
      emoji: instance.adapter.tileMetadata.emoji,
    };
  }

  /** REQ 8.3, REQ 8.4 — retained WhatsApp webhook helper */
  getWhatsAppWebhookListenerConfig(): ListenerConfig | null {
    const instance = this.instances.get('whatsapp');
    return instance?.listenerConfig ?? null;
  }

  /** REQ 27.5 — runtime registration; emits CHANNEL_REGISTRY_EVENT */
  registerAdapter(channelId: string, factory: AdapterFactory): void {
    this.registry.registerAdapter(channelId, factory);
    this.emitter.emit(CHANNEL_REGISTRY_EVENT, { channelId, action: 'added' });
  }

  // ── Inbound processing & session management (REQ 2.1–2.6, 5.1–5.4) ──

  /**
   * Set the AI pipeline implementation for processing inbound messages.
   * Must be called before inbound messages can be routed to the AI.
   */
  setAIPipeline(pipeline: AIPipelineInterface): void {
    this.aiPipeline = pipeline;
  }

  /**
   * Process an inbound message through the AI pipeline with session context.
   *
   * Flow:
   * 1. Retrieve session history for the channel-sender pair
   * 2. Append user message to session
   * 3. Process through AI pipeline with history context
   * 4. Append AI response to session
   * 5. Send response back to originating channel (with retry)
   * 6. Emit relay display metadata via CHANNEL_RELAY_EVENT
   *
   * On AI pipeline failure, sends an error response to the originating channel
   * without appending to session context.
   *
   * @satisfies REQ 2.1, REQ 2.2, REQ 2.3, REQ 2.4, REQ 2.5, REQ 2.6, REQ 3.1, REQ 3.2, REQ 3.3, REQ 5.1, REQ 5.2, REQ 11.3, REQ 12.1, REQ 12.2, REQ 12.3
   */
  async processInbound(msg: IncomingMessage, aiPipeline?: AIPipelineInterface): Promise<void> {
    // REQ 4.6: Send-only adapters never receive routing — skip response delivery
    const sendOnlyInstance = this.instances.get(msg.channelId);
    if (sendOnlyInstance && sendOnlyInstance.adapter.capabilities.direction === 'send-only') {
      return;
    }

    const pipeline = aiPipeline ?? this.aiPipeline;
    if (!pipeline) {
      // AI pipeline not configured — send error response
      console.error(`[ChannelManager] processInbound: no AI pipeline configured`);
      const errorMsg = 'NeuroNest is temporarily unavailable. Please try again later.';
      await this.sendWithRetry(msg.channelId, msg.from, errorMsg);
      return;
    }

    // Get display info for relay metadata (REQ 3.1, 3.2, 3.3)
    const displayInfo = this.getChannelDisplayInfo(msg.channelId);
    const displayName = displayInfo?.displayName ?? msg.channelId;
    const emoji = displayInfo?.emoji ?? '💬';

    // Emit inbound display metadata (REQ 3.1 — chat panel shows source indicator)
    this.emitter.emit(CHANNEL_RELAY_EVENT, {
      role: 'user',
      content: msg.content,
      channelSource: {
        channelId: msg.channelId,
        displayName,
        emoji,
        from: msg.from,
      },
      isChannelMessage: true,
    } as ChannelRelayPayload);

    // 1. Retrieve session history
    const history = this.sessionStore.getHistory(msg.channelId, msg.from);

    // 2. Append user message to session
    this.sessionStore.appendMessage(msg.channelId, msg.from, 'user', msg.content);

    // 3. Process through AI pipeline with context (with error handling for REQ 2.6)
    // Check if streaming delivery is available (REQ 12.4):
    //   - The pipeline supports processStream (async iteration)
    //   - The adapter for this channel supports streaming send
    const instance = this.instances.get(msg.channelId);
    const adapterCapabilities = instance?.adapter.capabilities as AdapterCapabilities | undefined;
    const useStreaming = !!(
      pipeline.processStream &&
      instance &&
      adapterCapabilities?.supportsStreamingSend
    );

    let response: string;
    try {
      if (useStreaming) {
        // Emit streaming indicator (REQ 12.1 — chat panel shows streaming progress)
        this.emitter.emit(CHANNEL_RELAY_EVENT, {
          role: 'assistant',
          content: '',
          channelSource: {
            channelId: msg.channelId,
            displayName,
            emoji,
            from: msg.from,
          },
          isChannelMessage: true,
          isChannelStreaming: true,
        } as ChannelRelayPayload);

        // Streaming path: pipe tokens through streamToChannel
        const stream = pipeline.processStream!(msg.content, history, {
          channelId: msg.channelId,
          senderId: msg.from,
        });

        // Buffer the full response while streaming to channel
        let fullResponse = '';
        const bufferingStream: AsyncIterable<string> = {
          [Symbol.asyncIterator]() {
            const iterator = stream[Symbol.asyncIterator]();
            return {
              async next() {
                const result = await iterator.next();
                if (!result.done) {
                  fullResponse += result.value;
                }
                return result;
              },
              async return(value?: any) {
                if (iterator.return) return iterator.return(value);
                return { done: true as const, value: undefined };
              },
              async throw(err?: any) {
                if (iterator.throw) return iterator.throw(err);
                throw err;
              },
            };
          },
        };

        const sendResult = await this.streamToChannel(
          msg.channelId,
          msg.from,
          bufferingStream,
          instance!.adapter,
        );

        response = fullResponse;

        // Append AI response to session
        this.sessionStore.appendMessage(msg.channelId, msg.from, 'assistant', response);

        // Emit relay display metadata (REQ 3.2, 3.3, 12.3 — relay indicator after delivery)
        this.emitter.emit(CHANNEL_RELAY_EVENT, {
          role: 'assistant',
          content: response,
          relayTarget: {
            channelId: msg.channelId,
            displayName,
            emoji,
            success: sendResult.success,
          },
          isChannelMessage: true,
        } as ChannelRelayPayload);

        // Emit delivery-failure event if streaming send failed (REQ 2.4)
        if (!sendResult.success) {
          const failurePayload: DeliveryFailurePayload = {
            channelId: msg.channelId,
            to: msg.from,
            error: sendResult.message,
            attempts: 1,
          };
          this.emitter.emit(DELIVERY_FAILURE_EVENT, failurePayload);
        }
        return;
      }

      // Non-streaming path: standard process call
      response = await pipeline.process(msg.content, history, {
        channelId: msg.channelId,
        senderId: msg.from,
      });
    } catch (error) {
      // AI pipeline unavailable — send error response to originating channel
      console.error(`[ChannelManager] AI pipeline failed for ${msg.channelId}::${msg.from}`, error);
      const errorMsg = 'NeuroNest is temporarily unavailable. Please try again later.';
      await this.sendWithRetry(msg.channelId, msg.from, errorMsg);
      // Do NOT append the error to session context
      return;
    }

    // 4. Append AI response to session
    this.sessionStore.appendMessage(msg.channelId, msg.from, 'assistant', response);

    // 5. Send response back to originating channel with retry (REQ 11.3)
    const sendResult = await this.sendWithRetry(msg.channelId, msg.from, response);

    // 6. Emit relay display metadata (REQ 3.2, 3.3, 12.3 — relay indicator after delivery confirmation)
    this.emitter.emit(CHANNEL_RELAY_EVENT, {
      role: 'assistant',
      content: response,
      relayTarget: {
        channelId: msg.channelId,
        displayName,
        emoji,
        success: sendResult.success,
      },
      isChannelMessage: true,
    } as ChannelRelayPayload);

    // Note: delivery-failure event is already emitted by sendWithRetry on exhaustion (REQ 2.4, 11.3)
  }

  /**
   * Clear the session context for a given channel-sender pair.
   *
   * @satisfies REQ 5.4
   */
  clearSessionContext(channelId: string, senderId: string): void {
    this.sessionStore.clear(channelId, senderId);
  }

  /**
   * Get session info for a given channel-sender pair.
   * Returns the full session entry or null if no session exists.
   *
   * @satisfies REQ 5.5
   */
  getSessionInfo(channelId: string, senderId: string): SessionEntry | null {
    const session = this.sessionStore.getOrCreate(channelId, senderId);
    // If the session has no messages, it was just created — treat as no session
    if (session.messages.length === 0) {
      return null;
    }
    return session;
  }

  /**
   * List all active sessions across all channels.
   */
  listActiveSessions(): SessionEntry[] {
    return this.sessionStore.listActiveSessions();
  }

  // ── Streaming Delivery (REQ 12.4) ─────────────────────────────

  /**
   * Stream or buffer AI response delivery to a channel.
   *
   * When the adapter declares `supportsStreamingSend === true`, pipes partial
   * AI response tokens to the channel as they generate. On first send failure,
   * aborts the stream and returns the failure result.
   *
   * When `supportsStreamingSend` is falsy, buffers the full response from the
   * async iterable and sends it as a single message (current behavior).
   *
   * @param channelId - The channel to send to
   * @param to - The recipient address within the channel
   * @param responseStream - An async iterable yielding response token chunks
   * @param adapter - The adapter instance (used to check capabilities and send)
   * @returns SendResult indicating success or failure of the delivery
   *
   * @satisfies REQ 12.4
   */
  async streamToChannel(
    channelId: string,
    to: string,
    responseStream: AsyncIterable<string>,
    adapter: ChannelAdapter,
  ): Promise<SendResult> {
    const capabilities = adapter.capabilities as AdapterCapabilities;

    if (capabilities.supportsStreamingSend) {
      // Adapter supports chunked delivery — pipe partial tokens as they generate
      for await (const chunk of responseStream) {
        const result = await adapter.send({ to, content: chunk, contentType: 'text' });
        if (!result.success) {
          return result; // Abort streaming on first failure
        }
      }
      // Signal end-of-stream to the adapter with empty content marker
      return await adapter.send({ to, content: '', contentType: 'other' });
    } else {
      // Adapter does not support streaming — buffer full response, send once
      let fullResponse = '';
      for await (const chunk of responseStream) {
        fullResponse += chunk;
      }
      return await this.sendMessage(channelId, to, fullResponse);
    }
  }

  // ── Private — AdapterContext builder ───────────────────────────

  private buildContext(channelId: string, instance: ActiveInstance): AdapterContext {
    const self = this;
    return {
      emit(msg: IncomingMessage) {
        // Enforce channelId matches the adapter that emitted (REQ 26.5)
        // Cross-adapter emissions are refused: emit error status AND throw
        if (msg.channelId !== channelId) {
          self.emitter.emit(CHANNEL_STATUS_EVENT, {
            channelId,
            status: 'error',
            error: `adapter emitted a message with foreign channelId '${msg.channelId}'`,
            errorCode: 'PROVIDER_ERROR' as ErrorCode,
          });
          throw new Error(
            `Cross-adapter emission refused: adapter '${channelId}' attempted to emit for '${msg.channelId}'`,
          );
        }
        // REQ 26.5: propagate exceptions from downstream handlers to caller.
        // Node.js EventEmitter.emit() is synchronous — if a listener throws,
        // the exception propagates up through this call.
        self.emitter.emit('message', msg);

        // REQ 2.1: Route inbound messages through AI pipeline (async, fire-and-forget).
        // This allows existing `onMessage` listeners (like IMGateway) to continue
        // working while also enabling direct AI processing for bidirectional channels.
        if (self.aiPipeline) {
          self.processInbound(msg).catch((err) => {
            console.error(`[ChannelManager] processInbound error for ${msg.channelId}::${msg.from}`, err);
          });
        }
      },
      setStatus(status: ChannelStatus, err?: { code: ErrorCode; message: string }) {
        // REQ 15.1: only emit on actual state change
        if (instance.status === status) return;
        instance.status = status;
        if (err) {
          instance.lastError = err.message;
        } else {
          delete instance.lastError;
        }
        const payload: ChannelStatusPayload = { channelId, status };
        if (err) {
          payload.error = err.message;
          payload.errorCode = err.code;
        }
        self.emitter.emit(CHANNEL_STATUS_EVENT, payload);
      },
      logger: makeScopedLogger(channelId),
      reserveListener(opts) {
        const buildOpts: { port?: number; host?: string; remoteAccessExplicit?: boolean } = {};
        if (opts.port !== undefined) buildOpts.port = opts.port;
        if (opts.host !== undefined) buildOpts.host = opts.host;
        if (opts.remoteAccessExplicit !== undefined) buildOpts.remoteAccessExplicit = opts.remoteAccessExplicit;
        const cfg = buildListenerConfig(
          buildOpts,
          { port: opts.defaultPort },
          opts.name,
        );
        // Detect cross-adapter conflicts against every currently-reserved listener
        for (const [otherId, other] of self.instances) {
          if (otherId !== channelId && other.listenerConfig) {
            validateListenerPair(
              { config: cfg, name: opts.name },
              { config: other.listenerConfig, name: otherId },
            );
          }
        }
        instance.listenerConfig = cfg;
        return cfg;
      },
      releaseListener() { delete instance.listenerConfig; },
    };
  }

  // ── Private — Reconnect scheduling (REQ 20, REQ 11.1, 11.2) ────

  private scheduleReconnect(channelId: string, failureCode?: ErrorCode): void {
    const instance = this.instances.get(channelId);
    if (!instance) return;

    // REQ 20.4 — cancel on auth failure; do NOT emit a duplicate status event
    // since the caller (connect) already emitted the 'error' status.
    if (failureCode === 'AUTH_FAILED') {
      if (instance.reconnectTimer) clearTimeout(instance.reconnectTimer);
      delete instance.reconnectTimer;
      instance.reconnectAttempts = 0;
      return;
    }

    // REQ 11.1 — enforce maximum reconnection attempts (max 5)
    if (instance.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      // REQ 11.2 — set adapter status to 'error' and emit status event
      instance.status = 'error';
      instance.lastError = 'Reconnection failed: maximum attempts exceeded';
      this.emitter.emit(CHANNEL_STATUS_EVENT, {
        channelId,
        status: 'error',
        error: 'Reconnection failed: maximum attempts exceeded',
        errorCode: 'NETWORK_ERROR' as ErrorCode,
      });
      // Clear any pending timer
      if (instance.reconnectTimer) {
        clearTimeout(instance.reconnectTimer);
        delete instance.reconnectTimer;
      }
      return;
    }

    // REQ 20.1 — increment BEFORE scheduling
    instance.reconnectAttempts++;
    const n = instance.reconnectAttempts;
    // REQ 11.1 — exponential backoff with max 60s delay
    const delay = Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, n - 1), RECONNECT_MAX_DELAY_MS);

    instance.reconnectTimer = setTimeout(async () => {
      delete instance.reconnectTimer;
      if (!this.instances.has(channelId)) return; // disconnected during backoff
      try {
        const result = await this.connect(channelId, instance.lastConfig);
        if (result.success) {
          instance.reconnectAttempts = 0; // REQ 20.2
        }
        // If not successful, connect() itself will schedule the next reconnect
      } catch {
        this.scheduleReconnect(channelId);
      }
    }, delay);
  }
}
