import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type ShippedLegacyChatChannel =
  | 'chat-response'
  | 'chat:stream'
  | 'chat:done'
  | 'chat:error'
  | 'chat:stream-chunk';

export type LegacyResponseOrigin = 'chat' | 'dashboard' | 'channel' | 'system';

export interface LegacyResponseAdapterPort {
  accept(raw: unknown, channel: ShippedLegacyChatChannel): unknown;
  cleanup?(): void;
}

export interface LegacyResponseTurnContext {
  sessionId: string;
  branchId?: string;
  turnId?: string;
  messageId?: string;
  attempt?: number;
  origin?: LegacyResponseOrigin;
  agent?: string;
  provider?: string;
  model?: string;
  channelId?: string;
}

export interface LegacyResponseEmissionMetadata {
  family?:
    | 'start'
    | 'token'
    | 'reasoning'
    | 'completion'
    | 'cancellation'
    | 'error'
    | 'retry'
    | 'reconnect'
    | 'duplicate_delivery';
  origin?: LegacyResponseOrigin;
  agent?: string;
  provider?: string;
  model?: string;
  channelId?: string;
  ordinal?: number;
  occurredAt?: string;
}

export interface LegacyResponseIPCBridgeOptions {
  adapter?: LegacyResponseAdapterPort;
  now?: () => string;
  createId?: () => string;
}

interface LegacyResponsePayload {
  role?: string;
  content?: string;
  msgId?: string;
  messageId?: string;
  token?: string;
  /** Present on `chat:stream-chunk` deliveries (DispatchBridge). */
  chunk?: string;
  start?: boolean;
  /** Present on `chat:stream-chunk` completion deliveries. */
  done?: boolean;
  error?: unknown;
  reasoning?: unknown;
  agent?: string;
  agentEmoji?: string;
  source?: string;
  provider?: string;
  model?: string;
  channelSource?: { channelId?: string };
  relayTarget?: { channelId?: string };
  isChannelMessage?: boolean;
  isChannelStreaming?: boolean;
  [key: string]: unknown;
}

/**
 * Main-process compatibility seam between shipped IPC emissions and the
 * LegacyResponseAdapter. It never buffers messages or emits renderer-visible
 * channels of its own: `emit` preserves the caller's existing send exactly,
 * then feeds the same payload and correlation metadata to the adapter.
 */
export class LegacyResponseIPCBridge {
  private readonly contexts = new AsyncLocalStorage<Required<Pick<LegacyResponseTurnContext, 'sessionId' | 'branchId' | 'turnId' | 'messageId' | 'attempt' | 'origin'>> & LegacyResponseTurnContext>();
  private readonly ordinals = new Map<string, number>();
  private readonly now: () => string;
  private readonly createId: () => string;
  private adapter?: LegacyResponseAdapterPort;
  private disposed = false;

  constructor(options: LegacyResponseIPCBridgeOptions = {}) {
    this.adapter = options.adapter;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
  }

  setAdapter(adapter: LegacyResponseAdapterPort | undefined): void {
    this.adapter = adapter;
  }

  enterTurn(context: LegacyResponseTurnContext): void {
    if (this.disposed) return;
    const messageId = context.messageId || context.turnId || this.createId();
    this.contexts.enterWith({
      ...context,
      sessionId: context.sessionId || 'legacy-unscoped',
      branchId: context.branchId || 'main',
      turnId: context.turnId || messageId,
      messageId,
      attempt: context.attempt ?? 0,
      origin: context.origin || 'chat',
    });
  }

  emit(
    mainWindow: { webContents: { send(channel: string, payload: unknown): void } },
    channel: ShippedLegacyChatChannel,
    payload: LegacyResponsePayload,
    metadata: LegacyResponseEmissionMetadata = {},
  ): void {
    mainWindow.webContents.send(channel, payload);
    this.feed(channel, payload, metadata);
  }

  feed(
    channel: ShippedLegacyChatChannel,
    payload: LegacyResponsePayload,
    metadata: LegacyResponseEmissionMetadata = {},
  ): void {
    if (this.disposed || !this.adapter) return;

    const current = this.contexts.getStore();
    const payloadMessageId = this.readString(payload.msgId) || this.readString(payload.messageId);
    const messageId = payloadMessageId || current?.messageId || this.createId();
    const turnId = current?.turnId || messageId;
    const sessionId = current?.sessionId || 'legacy-unscoped';
    const branchId = current?.branchId || 'main';
    const attempt = current?.attempt ?? 0;
    const family = metadata.family || this.inferFamily(channel, payload);
    const ordinal = metadata.ordinal ?? this.nextOrdinal(sessionId, branchId, turnId, messageId, attempt, family);
    const agent = metadata.agent || this.readString(payload.agent) || current?.agent;
    const provider = metadata.provider || this.readString(payload.provider) || current?.provider;
    const model = metadata.model || this.readString(payload.model) || current?.model;
    const channelId = metadata.channelId
      || this.readString(payload.channelSource?.channelId)
      || this.readString(payload.relayTarget?.channelId)
      || current?.channelId;
    const origin = metadata.origin
      || current?.origin
      || (payload.isChannelMessage ? 'channel' : 'system');

    const envelope = {
      schemaVersion: 1 as const,
      deliveryId: this.createId(),
      family,
      channel,
      sessionId,
      branchId,
      turnId,
      messageId,
      attempt,
      ordinal,
      occurredAt: metadata.occurredAt || this.now(),
      ...(agent ? { agent } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      origin,
      ...(channelId ? { channelId } : {}),
      payload,
    };

    try {
      this.adapter.accept(envelope, channel);
    } catch (error) {
      console.warn('[LegacyResponseIPCBridge] Adapter rejected mirrored emission:', error instanceof Error ? error.message : String(error));
    }
  }

  cancel(metadata: LegacyResponseEmissionMetadata = {}): void {
    this.feed('chat-response', { role: 'assistant', content: '' }, {
      ...metadata,
      family: 'cancellation',
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ordinals.clear();
    this.contexts.disable();
    try {
      this.adapter?.cleanup?.();
    } catch (error) {
      console.warn('[LegacyResponseIPCBridge] Adapter cleanup failed:', error instanceof Error ? error.message : String(error));
    }
    this.adapter = undefined;
  }

  private inferFamily(channel: ShippedLegacyChatChannel, payload: LegacyResponsePayload): LegacyResponseEmissionMetadata['family'] {
    if (channel === 'chat:error' || payload.error) return 'error';
    if (channel === 'chat:done') return 'completion';
    if (channel === 'chat:stream') return payload.start ? 'start' : 'token';
    if (channel === 'chat:stream-chunk') {
      // DispatchBridge collapses start/token/done/error into one shipped
      // channel using boolean discriminators. Reasoning arrives alongside the
      // completion flag.
      if (payload.error !== undefined) return 'error';
      if (payload.done === true) return 'completion';
      if (payload.start === true) return 'start';
      if (payload.reasoning !== undefined && payload.chunk === undefined && payload.token === undefined) {
        return 'reasoning';
      }
      return 'token';
    }
    if (payload.reasoning) return 'reasoning';
    if (payload.isChannelStreaming) return 'start';
    return 'completion';
  }

  private nextOrdinal(
    sessionId: string,
    branchId: string,
    turnId: string,
    messageId: string,
    attempt: number,
    family: LegacyResponseEmissionMetadata['family'],
  ): number {
    if (family !== 'token' && family !== 'reasoning') return 0;
    const key = `${sessionId}\u0000${branchId}\u0000${turnId}\u0000${messageId}\u0000${attempt}\u0000${family}`;
    const next = this.ordinals.get(key) ?? 0;
    this.ordinals.set(key, next + 1);
    return next;
  }

  private readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
