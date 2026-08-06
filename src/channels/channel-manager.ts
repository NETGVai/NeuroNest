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
import type { ChannelAdapter, AdapterContext, AdapterFactory } from './types/adapter';
import type {
  IncomingMessage,
  OutgoingMessage,
  ConnectResult,
  SendResult,
  ChannelConnection,
} from './types/messages';
import type { ChannelStatus } from './types/capabilities';
import type { ErrorCode } from './types/errors';
import type { ListenerConfig } from './listener-config';
import {
  buildListenerConfig,
  validateListenerPair,
} from './listener-config';

// ── Re-export types so existing `import { ..., type X } from '../channels/channel-manager'` compile ──

export type { ChannelConnection, IncomingMessage, ConnectResult, SendResult };

// ── Event constants ─────────────────────────────────────────────

export const CHANNEL_STATUS_EVENT = 'channel-status' as const;
export const CHANNEL_REGISTRY_EVENT = 'channel-registry' as const;

// ── Payload / Diagnostics types ─────────────────────────────────

export interface ChannelStatusPayload {
  channelId: string;
  status: ChannelStatus;
  qrCode?: string;
  error?: string;
  errorCode?: ErrorCode;
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
      const errorMsg = `Invalid config for '${channelId}': fields = ${fields}`;
      this.emitter.emit(CHANNEL_STATUS_EVENT, {
        channelId,
        status: 'error',
        error: errorMsg,
        errorCode: 'CONFIG_INVALID' as ErrorCode,
      });
      return { success: false, message: errorMsg, error: { code: 'CONFIG_INVALID', message: `Invalid fields: ${fields}` } };
    }

    // Create active instance record
    const instance: ActiveInstance = {
      adapter,
      status: 'connecting',
      reconnectAttempts: 0,
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

  // ── Private — Reconnect scheduling (REQ 20) ───────────────────

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

    // REQ 20.1 — increment BEFORE scheduling
    instance.reconnectAttempts++;
    const n = instance.reconnectAttempts;
    const delay = Math.min(1000 * Math.pow(2, n - 1), 60000);

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
