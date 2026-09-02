/**
 * ChannelRegistryAuthority — the unified Channel Registry and verified adapters
 * (FUT-PKG-08-OPTIONAL/T-001).
 *
 * NN-CHANNEL-001–012 require ONE versioned adapter contract, normalized
 * messages, a registry-derived 43-ID baseline that distinguishes the seven
 * source-declared REAL adapters from the 36 catalog-only entries, secure
 * config/credentials/webhooks, reconnect with bounded backoff that STOPS on an
 * auth failure, concurrent isolation without listener-port theft, per-chat
 * (never one global) sessions, messaging UX, and remote kill controls.
 *
 * This module is the SINGLE SOURCE OF TRUTH. Every entry point (slash command,
 * IM gateway, IPC list, settings, channel panel via
 * {@link ../experience/dashboard-authority}.deriveChannelCatalog) derives from
 * THIS registry — it never creates a parallel truth. The authority builds ON
 * the existing pieces rather than replacing them:
 *
 *   - the 43-ID baseline is derived here (7 REAL + 36 catalog-only) and fed to
 *     the dashboard catalog derivation as {@link ChannelRegistryEntry}[];
 *   - every durable session/status/delivery transition commits THROUGH the
 *     single same-transaction outbox authority
 *     ({@link ../storage/authority-transaction}.applyAuthorityMutation) — there
 *     is no private write path, so an operator-visible "connected" status or a
 *     delivered message is always a committed fact, never an in-memory guess;
 *   - secret redaction reuses {@link ./redact}; loopback port reservation reuses
 *     {@link ./listener-config}.
 *
 * Fail-closed / prohibited (each is enforced and property-tested):
 *   1. NO false connected state — a catalog-only or never-connected channel can
 *      never report `connected`; a catalog-only connect returns typed
 *      `UNAVAILABLE`.
 *   2. NO cross-chat / global session — a session is keyed by
 *      (channelId, chatId) and lives in its own outbox scope; there is no single
 *      global active session and one chat's history never leaks to another.
 *   3. NO listener-port theft — a loopback port is reserved exclusively; a
 *      second reservation of a live port is a typed `CONFLICT`.
 *   4. NO secret in a log/event — config/errors are redacted before they leave.
 *   5. NO retry after an auth failure — the reconnect policy classifies
 *      `AUTH_FAILED`/`CONFIG_INVALID`/`SDK_MISSING` as terminal (stop) and only
 *      a transient failure backs off from 1s to 60s.
 *
 * Design anchors: D-04, D-05, D-07, D-11, D-16, D-20.
 * Requirements: NN-CHANNEL-001–012, NN-SEC-006, NN-SEC-008, NN-EVENT-002,
 * NN-COMPAT-001, NN-COMPAT-003, NN-INV-003, NN-INV-007, NN-INV-008.
 */

import type Database from 'better-sqlite3';

import {
  CONTRACT_WRITE_VERSION,
  computeDigest,
  isOpaqueId,
  makeOpaqueId,
  type ErrorCode,
  type ErrorEnvelope,
  type ScopeDescriptor,
} from '../shared/contract-primitives.js';
import {
  applyAuthorityMutation,
  ensureAuthorityTables,
  readOutboxForScope,
} from '../storage/authority-transaction.js';
import { redactSecrets, redactString } from './redact.js';
import type { ChannelRegistryEntry } from '../experience/dashboard-authority.js';

const CHANNEL_OWNER = 'authority-channel-registry';

// ════════════════════════════════════════════════════════════════════════════
// 1. The exact 43-ID baseline (NN-CHANNEL-004) — the single source of truth
// ════════════════════════════════════════════════════════════════════════════

/**
 * Whether a channel is a qualified REAL adapter or a catalog-only entry.
 * `available` maps to a real SDK-backed adapter that can connect; `coming-soon`
 * maps to a catalog-only entry that must stay UNAVAILABLE (NN-CHANNEL-003).
 */
export type ChannelKind = 'available' | 'coming-soon';

/** One immutable baseline metadata row (NN-CHANNEL-004). */
export interface ChannelBaselineEntry {
  readonly channelId: string;
  readonly displayName: string;
  readonly kind: ChannelKind;
  /** Stable sort key — REAL adapters occupy 0..99, catalog-only 1000+ (NN-CHANNEL-011). */
  readonly sortOrder: number;
}

/**
 * The seven source-declared REAL adapters, in canonical activity-bar order
 * (NN-CHANNEL-004/005). These are the ONLY channels that may connect.
 */
export const REAL_CHANNEL_IDS = Object.freeze([
  'whatsapp',
  'telegram',
  'discord',
  'slack',
  'github',
  'email',
  'microsoft-teams',
] as const);
export type RealChannelId = (typeof REAL_CHANNEL_IDS)[number];

/**
 * The 36 catalog-only channel IDs, in the exact order declared by
 * NN-CHANNEL-004. Each stays typed UNAVAILABLE (NN-CHANNEL-003).
 */
export const CATALOG_ONLY_CHANNEL_IDS = Object.freeze([
  'signal',
  'imessage',
  'imessage-bluebubbles',
  'nextcloud-talk',
  'matrix',
  'nostr',
  'tlon-messenger',
  'zalo',
  'zalo-personal',
  'webchat',
  'apple-notes',
  'apple-reminders',
  'things-3',
  'notion',
  'obsidian',
  'bear-notes',
  'trello',
  'spotify',
  'sonos',
  'shazam',
  'philips-hue',
  '8sleep',
  'home-assistant',
  'browser',
  'canvas',
  'voice',
  'gmail',
  'cron',
  'webhooks',
  '1password',
  'weather',
  'image-gen',
  'gif-search',
  'peekaboo',
  'camera',
  'twitter-x',
] as const);
export type CatalogOnlyChannelId = (typeof CATALOG_ONLY_CHANNEL_IDS)[number];

/** Human-readable display names for the seven REAL adapters (NN-CHANNEL-011). */
const REAL_DISPLAY_NAMES: Readonly<Record<RealChannelId, string>> = Object.freeze({
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  github: 'GitHub',
  email: 'Email',
  'microsoft-teams': 'Microsoft Teams',
});

function toDisplayName(channelId: string): string {
  return channelId
    .split('-')
    .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(' ');
}

/**
 * Build the exact 43-ID baseline (NN-CHANNEL-004). REAL adapters occupy sort
 * order 10, 20, …; catalog-only entries occupy 1000 + declaration index. The
 * result is frozen and total: exactly 7 `available` + 36 `coming-soon` = 43.
 */
export function buildChannelBaseline(): readonly ChannelBaselineEntry[] {
  const real: ChannelBaselineEntry[] = REAL_CHANNEL_IDS.map((id, i) => ({
    channelId: id,
    displayName: REAL_DISPLAY_NAMES[id],
    kind: 'available',
    sortOrder: (i + 1) * 10,
  }));
  const catalog: ChannelBaselineEntry[] = CATALOG_ONLY_CHANNEL_IDS.map((id, i) => ({
    channelId: id,
    displayName: toDisplayName(id),
    kind: 'coming-soon',
    sortOrder: 1000 + i,
  }));
  return Object.freeze([...real, ...catalog]);
}

/** The canonical, revision-stable baseline instance (NN-CHANNEL-004). */
export const CHANNEL_BASELINE: readonly ChannelBaselineEntry[] = buildChannelBaseline();

/** The exact total baseline count. Runtime totals are registry-derived from here. */
export const CHANNEL_BASELINE_COUNT = CHANNEL_BASELINE.length; // 43

// ════════════════════════════════════════════════════════════════════════════
// 2. Normalized message contract (NN-CHANNEL-002)
// ════════════════════════════════════════════════════════════════════════════

/** The normalized message content types (NN-CHANNEL-002). */
export type NormalizedContentType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'other';

/**
 * A normalized inbound/outbound message record (NN-CHANNEL-002). Every required
 * field must be present or emission/send is refused. `providerMetadata.channel`
 * is the discriminator and must equal `channelId`.
 */
export interface NormalizedMessage {
  readonly channelId: string;
  /** The conversation/thread this message belongs to (per-chat isolation key). */
  readonly chatId: string;
  readonly sender: string;
  readonly recipient: string;
  readonly content: string;
  readonly contentType: NormalizedContentType;
  readonly timestamp: string;
  /** Correlation id threaded onto the durable delivery record. */
  readonly correlationId: string;
  /** Provider metadata; `channel` discriminator must match `channelId`. */
  readonly providerMetadata: { readonly channel: string; readonly [k: string]: unknown };
}

/**
 * Validate a normalized message (NN-CHANNEL-002). Missing required fields refuse
 * emission (`VALIDATION`); a `providerMetadata.channel` that does not match the
 * `channelId` discriminator refuses send (`CONFLICT`). Pure and deterministic.
 */
export function validateNormalizedMessage(
  msg: NormalizedMessage,
): { readonly ok: true } | { readonly ok: false; readonly error: ErrorEnvelope } {
  const required: ReadonlyArray<[keyof NormalizedMessage, unknown]> = [
    ['channelId', msg.channelId],
    ['chatId', msg.chatId],
    ['sender', msg.sender],
    ['recipient', msg.recipient],
    ['content', msg.content],
    ['contentType', msg.contentType],
    ['timestamp', msg.timestamp],
    ['correlationId', msg.correlationId],
  ];
  for (const [field, value] of required) {
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        error: channelError('VALIDATION', `normalized message missing required field '${String(field)}'`, 'channel.message.validate', msg.correlationId),
      };
    }
  }
  if (!msg.providerMetadata || typeof msg.providerMetadata.channel !== 'string') {
    return {
      ok: false,
      error: channelError('VALIDATION', 'normalized message missing providerMetadata discriminator', 'channel.message.validate', msg.correlationId),
    };
  }
  if (msg.providerMetadata.channel !== msg.channelId) {
    return {
      ok: false,
      error: channelError('CONFLICT', `providerMetadata.channel '${msg.providerMetadata.channel}' does not match channelId '${msg.channelId}'`, 'channel.message.validate', msg.correlationId),
    };
  }
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Reconnect policy (NN-CHANNEL-007) — bounded backoff; STOP on auth failure
// ════════════════════════════════════════════════════════════════════════════

/** The channel-local failure taxonomy for a connect/transport failure. */
export type ChannelFailureCode =
  | 'AUTH_FAILED'
  | 'CONFIG_INVALID'
  | 'SDK_MISSING'
  | 'NETWORK_ERROR'
  | 'LISTENER_PORT_CONFLICT'
  | 'PROVIDER_ERROR';

/** The set of failure codes that are TERMINAL — they must never be retried. */
const TERMINAL_FAILURES: ReadonlySet<ChannelFailureCode> = new Set<ChannelFailureCode>([
  'AUTH_FAILED',
  'CONFIG_INVALID',
  'SDK_MISSING',
]);

/** Backoff bounds (NN-CHANNEL-007): 1s floor, 60s ceiling. */
export const RECONNECT_MIN_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 60_000;
/** Bounded attempt ceiling — reconnect never loops unbounded. */
export const RECONNECT_MAX_ATTEMPTS = 6;

/** The decision produced by {@link planReconnect}. */
export type ReconnectDecision =
  | { readonly action: 'stop'; readonly reason: 'auth-failure' | 'exhausted' }
  | { readonly action: 'retry'; readonly attempt: number; readonly delayMs: number };

/**
 * Decide whether to reconnect after a transport failure (NN-CHANNEL-007). Pure.
 *
 *   - an `AUTH_FAILED`/`CONFIG_INVALID`/`SDK_MISSING` failure STOPS retry
 *     (never retried) — the single most important fail-closed rule;
 *   - a transient failure retries with exponential backoff bounded to [1s, 60s];
 *   - once the attempt budget is exhausted the decision STOPS (no unbounded
 *     loop). A successful connect resets `priorAttempts` to 0 (caller's job).
 */
export function planReconnect(
  failure: ChannelFailureCode,
  priorAttempts: number,
): ReconnectDecision {
  if (TERMINAL_FAILURES.has(failure)) {
    return { action: 'stop', reason: 'auth-failure' };
  }
  const attempt = priorAttempts + 1;
  if (attempt > RECONNECT_MAX_ATTEMPTS) {
    return { action: 'stop', reason: 'exhausted' };
  }
  const raw = RECONNECT_MIN_DELAY_MS * Math.pow(2, attempt - 1);
  const delayMs = Math.min(raw, RECONNECT_MAX_DELAY_MS);
  return { action: 'retry', attempt, delayMs };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Loopback listener reservation (NN-CHANNEL-006/008) — no port theft
// ════════════════════════════════════════════════════════════════════════════

/** A live loopback reservation held by exactly one channel. */
interface PortReservation {
  readonly channelId: string;
  readonly host: string;
  readonly port: number;
}

/**
 * Reserves loopback listener ports exclusively so one adapter can never steal
 * another's port (NN-CHANNEL-008). A reservation binds `127.0.0.1` by default
 * (NN-CHANNEL-006); a second live reservation of the same host:port is a typed
 * `CONFLICT`. Release is idempotent.
 */
export class ListenerReservations {
  private readonly byKey = new Map<string, PortReservation>();
  private readonly byChannel = new Map<string, string>();

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  /**
   * Reserve a loopback port for `channelId`. Rejects an out-of-range port
   * (`VALIDATION`) and a port already held by ANOTHER channel (`CONFLICT`). A
   * re-reservation by the same channel of the same port is idempotent.
   */
  reserve(
    channelId: string,
    port: number,
    host = '127.0.0.1',
  ): { readonly ok: true } | { readonly ok: false; readonly error: ErrorEnvelope } {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: channelError('VALIDATION', `invalid listener port ${port}`, 'channel.listener.reserve') };
    }
    const key = this.key(host, port);
    const held = this.byKey.get(key);
    if (held && held.channelId !== channelId) {
      return {
        ok: false,
        error: channelError('CONFLICT', `listener ${key} is already reserved by channel '${held.channelId}'`, 'channel.listener.reserve'),
      };
    }
    // Release any different port this channel previously held.
    const prevKey = this.byChannel.get(channelId);
    if (prevKey && prevKey !== key) this.byKey.delete(prevKey);
    this.byKey.set(key, { channelId, host, port });
    this.byChannel.set(channelId, key);
    return { ok: true };
  }

  /** Release the reservation held by `channelId`. Idempotent. */
  release(channelId: string): void {
    const key = this.byChannel.get(channelId);
    if (key) {
      this.byKey.delete(key);
      this.byChannel.delete(channelId);
    }
  }

  /** The channel currently holding host:port, or undefined. */
  holderOf(port: number, host = '127.0.0.1'): string | undefined {
    return this.byKey.get(this.key(host, port))?.channelId;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Typed errors and durable tables
// ════════════════════════════════════════════════════════════════════════════

function channelError(
  code: ErrorCode,
  message: string,
  operation: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: CHANNEL_OWNER,
    operation,
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'UNAVAILABLE' || code === 'TIMEOUT',
    redaction: 'internal',
  };
}

/**
 * Create the channel authority tables. Additive over the canonical durability
 * tables; the Channel Registry authority is the SOLE writer of
 * `channel_connections` and `channel_sessions` (NN-INV-008). Idempotent.
 */
export function ensureChannelTables(db: Database.Database): void {
  ensureAuthorityTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_connections (
      channel_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      error_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channel_sessions (
      session_key TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL
    );
  `);
}

/** The operator-visible connection lifecycle states (NN-CHANNEL-003). */
export type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** The durable connection record read back from the store. */
export interface ChannelConnectionRecord {
  readonly channelId: string;
  readonly status: ChannelConnectionStatus;
  readonly attempts: number;
  readonly error?: ErrorEnvelope;
}

interface ConnectionRow {
  readonly channel_id: string;
  readonly status: ChannelConnectionStatus;
  readonly attempts: number;
  readonly error_json: string | null;
}

/** A durable per-chat session record (NN-CHANNEL-009). */
export interface ChannelSessionRecord {
  readonly channelId: string;
  readonly chatId: string;
  readonly messageCount: number;
}

interface SessionRow {
  readonly channel_id: string;
  readonly chat_id: string;
  readonly message_count: number;
}

// ════════════════════════════════════════════════════════════════════════════
// 6. Adapter contract descriptor (NN-CHANNEL-001) & connect outcome
// ════════════════════════════════════════════════════════════════════════════

/**
 * The versioned adapter contract descriptor a REAL adapter presents to the
 * registry (NN-CHANNEL-001). A catalog-only entry has no descriptor — the
 * registry refuses it UNAVAILABLE before any SDK is touched.
 */
export interface AdapterContractDescriptor {
  readonly channelId: string;
  readonly contractVersion: typeof CONTRACT_WRITE_VERSION;
  /** Validate the untrusted config; returns ok or a typed failure code. */
  readonly validateConfig: (config: unknown) => { readonly ok: true } | { readonly ok: false; readonly code: ChannelFailureCode; readonly message: string };
  /** Attempt a real connection; the descriptor is the ONLY connect path. */
  readonly attemptConnect: (config: unknown) => Promise<{ readonly ok: true } | { readonly ok: false; readonly code: ChannelFailureCode; readonly message: string }>;
}

/** The outcome the caller sees from {@link ChannelRegistryAuthority.connect}. */
export type ConnectOutcome =
  | { readonly kind: 'connected'; readonly record: ChannelConnectionRecord }
  | { readonly kind: 'unavailable'; readonly error: ErrorEnvelope }
  | { readonly kind: 'failed'; readonly error: ErrorEnvelope; readonly reconnect: ReconnectDecision };

// ════════════════════════════════════════════════════════════════════════════
// 7. The Channel Registry Authority
// ════════════════════════════════════════════════════════════════════════════

/**
 * The unified Channel Registry authority (NN-CHANNEL-001–012). It is the single
 * source of truth for the 43-ID baseline and the SOLE durable writer of channel
 * connection/session state; every transition commits through the outbox
 * authority so a "connected" status or a delivered message is a committed fact
 * (NN-INV-003).
 */
export class ChannelRegistryAuthority {
  private readonly db: Database.Database;
  private readonly baseline: ReadonlyMap<string, ChannelBaselineEntry>;
  private readonly descriptors = new Map<string, AdapterContractDescriptor>();
  private readonly listeners = new ListenerReservations();

  constructor(db: Database.Database) {
    this.db = db;
    ensureChannelTables(db);
    this.baseline = new Map(CHANNEL_BASELINE.map((e) => [e.channelId, e]));
  }

  // ── Registry discovery (single source of truth) ─────────────────────────────

  /** The full frozen 43-ID baseline in stable sort order (NN-CHANNEL-004/011). */
  listBaseline(): readonly ChannelBaselineEntry[] {
    return [...this.baseline.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  /** Whether a channel id belongs to the baseline at all. */
  has(channelId: string): boolean {
    return this.baseline.has(channelId);
  }

  /** Whether a channel is a qualified REAL adapter (may connect). */
  isReal(channelId: string): boolean {
    return this.baseline.get(channelId)?.kind === 'available';
  }

  /**
   * Derive the {@link ChannelRegistryEntry}[] that the dashboard catalog
   * consumes (NN-CHANNEL-011). This is the ONE derivation every entry point
   * uses; a runtime registration is reflected here without editing any
   * independent whitelist.
   */
  toCatalogEntries(): readonly ChannelRegistryEntry[] {
    return this.listBaseline().map((e) => ({
      channelId: e.channelId,
      displayName: e.displayName,
      implementationStatus: e.kind,
      sortOrder: e.sortOrder,
    }));
  }

  /**
   * Register (qualify) a REAL adapter's versioned contract descriptor
   * (NN-CHANNEL-001). Refuses a descriptor for a catalog-only id (`FORBIDDEN`)
   * and a descriptor whose contract major is unknown (`INCOMPATIBLE`). Only a
   * registered descriptor enables `connect`.
   */
  registerAdapter(
    descriptor: AdapterContractDescriptor,
  ): { readonly ok: true } | { readonly ok: false; readonly error: ErrorEnvelope } {
    if (!this.has(descriptor.channelId)) {
      return { ok: false, error: channelError('VALIDATION', `unknown channel '${descriptor.channelId}'`, 'channel.register') };
    }
    if (!this.isReal(descriptor.channelId)) {
      return { ok: false, error: channelError('FORBIDDEN', `channel '${descriptor.channelId}' is catalog-only and cannot register a live adapter`, 'channel.register') };
    }
    if (descriptor.contractVersion !== CONTRACT_WRITE_VERSION) {
      return { ok: false, error: channelError('INCOMPATIBLE', `adapter contract version ${descriptor.contractVersion} is unsupported`, 'channel.register') };
    }
    this.descriptors.set(descriptor.channelId, descriptor);
    return { ok: true };
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** The current committed connection record, or a disconnected default. */
  getConnection(channelId: string): ChannelConnectionRecord {
    const row = this.db
      .prepare('SELECT * FROM channel_connections WHERE channel_id = ?')
      .get(channelId) as ConnectionRow | undefined;
    if (!row) return { channelId, status: 'disconnected', attempts: 0 };
    return {
      channelId: row.channel_id,
      status: row.status,
      attempts: row.attempts,
      ...(row.error_json ? { error: JSON.parse(row.error_json) as ErrorEnvelope } : {}),
    };
  }

  /** Whether a channel currently reports the committed `connected` status. */
  isConnected(channelId: string): boolean {
    return this.getConnection(channelId).status === 'connected';
  }

  /** Every non-disconnected connection record (for the panel / stopAll). */
  listConnections(): readonly ChannelConnectionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM channel_connections WHERE status != 'disconnected'")
      .all() as ConnectionRow[];
    return rows.map((row) => ({
      channelId: row.channel_id,
      status: row.status,
      attempts: row.attempts,
      ...(row.error_json ? { error: JSON.parse(row.error_json) as ErrorEnvelope } : {}),
    }));
  }

  /** The committed per-chat session record, or undefined (NN-CHANNEL-009). */
  getSession(channelId: string, chatId: string): ChannelSessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM channel_sessions WHERE session_key = ?')
      .get(sessionKey(channelId, chatId)) as SessionRow | undefined;
    return row
      ? { channelId: row.channel_id, chatId: row.chat_id, messageCount: row.message_count }
      : undefined;
  }

  // ── Connect (NN-CHANNEL-003/006/007) ───────────────────────────────────────

  /**
   * Connect a channel (NN-CHANNEL-003). Fail-closed order:
   *
   *   1. an unknown or catalog-only id returns typed `UNAVAILABLE` WITHOUT
   *      touching any SDK and never reports connected (NN-CHANNEL-003);
   *   2. config is schema-validated by the descriptor; an invalid config is a
   *      TERMINAL failure that STOPS retry (NN-CHANNEL-006/007);
   *   3. a REAL connect attempt is made; success commits `connected` through the
   *      outbox authority (a committed fact); a failure commits `error` and
   *      returns a {@link ReconnectDecision} — an auth failure STOPS retry, a
   *      transient failure backs off (NN-CHANNEL-007).
   *
   * All error surfaces are redacted (NN-CHANNEL-006 / NN-SEC-006).
   */
  async connect(
    channelId: string,
    config: unknown,
    scope: ScopeDescriptor,
    correlationId: string,
  ): Promise<ConnectOutcome> {
    // (1) catalog-only / unknown → typed UNAVAILABLE, no false connected state.
    const entry = this.baseline.get(channelId);
    if (!entry || entry.kind !== 'available') {
      const err = channelError('UNAVAILABLE', `channel '${channelId}' is catalog-only and not available to connect`, 'channel.connect', correlationId);
      this.commitStatus(channelId, scope, correlationId, { status: 'disconnected', attempts: 0, error: err, event: 'channel.connect.unavailable' });
      return { kind: 'unavailable', error: err };
    }
    const descriptor = this.descriptors.get(channelId);
    if (!descriptor) {
      const err = channelError('UNAVAILABLE', `channel '${channelId}' has no qualified adapter registered`, 'channel.connect', correlationId);
      return { kind: 'unavailable', error: err };
    }

    const prior = this.getConnection(channelId).attempts;

    // (2) config validation — a TERMINAL failure (never retried).
    const configCheck = descriptor.validateConfig(config);
    if (!configCheck.ok) {
      const err = channelError('VALIDATION', redactString(configCheck.message, secretsOf(config)), 'channel.connect', correlationId);
      this.commitStatus(channelId, scope, correlationId, { status: 'error', attempts: prior, error: err, event: 'channel.connect.failed' });
      return { kind: 'failed', error: err, reconnect: planReconnect(configCheck.code, prior) };
    }

    // (3) REAL connect attempt.
    this.commitStatus(channelId, scope, correlationId, { status: 'connecting', attempts: prior, event: 'channel.connect.connecting' });
    let attempt: { readonly ok: true } | { readonly ok: false; readonly code: ChannelFailureCode; readonly message: string };
    try {
      attempt = await descriptor.attemptConnect(config);
    } catch (e) {
      attempt = { ok: false, code: 'PROVIDER_ERROR', message: e instanceof Error ? e.message : 'provider error' };
    }

    if (attempt.ok) {
      this.commitStatus(channelId, scope, correlationId, { status: 'connected', attempts: 0, event: 'channel.connect.connected' });
      return { kind: 'connected', record: this.getConnection(channelId) };
    }

    const decision = planReconnect(attempt.code, prior);
    const nextAttempts = decision.action === 'retry' ? decision.attempt : prior;
    const err = channelError(
      attempt.code === 'AUTH_FAILED' ? 'UNAUTHORIZED' : 'UNAVAILABLE',
      redactString(attempt.message, secretsOf(config)),
      'channel.connect',
      correlationId,
    );
    this.commitStatus(channelId, scope, correlationId, { status: 'error', attempts: nextAttempts, error: err, event: 'channel.connect.failed' });
    return { kind: 'failed', error: err, reconnect: decision };
  }

  /**
   * Disconnect a channel explicitly (NN-CHANNEL-007/008). Cancels any pending
   * reconnect intent (attempts reset to 0), releases the listener reservation,
   * and commits `disconnected`. Idempotent.
   */
  disconnect(channelId: string, scope: ScopeDescriptor, correlationId: string): ChannelConnectionRecord {
    this.listeners.release(channelId);
    this.commitStatus(channelId, scope, correlationId, { status: 'disconnected', attempts: 0, event: 'channel.disconnect' });
    return this.getConnection(channelId);
  }

  /**
   * Remote kill — disconnect ALL channels concurrently and report per-channel
   * outcomes (NN-CHANNEL-008/012). One channel's disconnect failure never
   * blocks the others; each disconnect is isolated. Returns a per-channel map.
   */
  async stopAll(
    scope: ScopeDescriptor,
    correlationId: string,
  ): Promise<ReadonlyMap<string, { readonly ok: boolean; readonly error?: ErrorEnvelope }>> {
    const live = this.listConnections().map((c) => c.channelId);
    const results = new Map<string, { readonly ok: boolean; readonly error?: ErrorEnvelope }>();
    await Promise.all(
      live.map(async (id) => {
        try {
          this.disconnect(id, scope, correlationId);
          results.set(id, { ok: true });
        } catch (e) {
          results.set(id, { ok: false, error: channelError('INTERNAL', e instanceof Error ? e.message : 'disconnect failed', 'channel.stopAll', correlationId) });
        }
      }),
    );
    return results;
  }

  // ── Listener reservation passthrough (NN-CHANNEL-006/008) ───────────────────

  /** Reserve a loopback listener port exclusively for a channel (no port theft). */
  reserveListener(channelId: string, port: number, host?: string) {
    if (!this.isReal(channelId)) {
      return { ok: false as const, error: channelError('FORBIDDEN', `catalog-only channel '${channelId}' cannot reserve a listener`, 'channel.listener.reserve') };
    }
    return this.listeners.reserve(channelId, port, host);
  }

  /** The channel holding a loopback port, if any. */
  listenerHolder(port: number, host?: string): string | undefined {
    return this.listeners.holderOf(port, host);
  }

  // ── Per-chat session + message delivery (NN-CHANNEL-002/009/010) ────────────

  /**
   * Record an inbound/outbound message into its per-chat session and commit an
   * ordered delivery event through the outbox authority (NN-CHANNEL-002/009,
   * NN-EVENT-002). Fail-closed:
   *
   *   - the channel must be a committed `connected` REAL channel or the send is
   *     refused `UNAVAILABLE` (no delivery on an unconnected/catalog channel);
   *   - the message must validate (NN-CHANNEL-002) or emission is refused;
   *   - the session is keyed by (channelId, chatId) in its OWN outbox scope, so
   *     it can never fall into a global session and one chat never sees another
   *     chat's history (NN-CHANNEL-009).
   */
  deliver(
    msg: NormalizedMessage,
    baseScope: ScopeDescriptor,
  ): ChannelSessionRecord | { readonly error: ErrorEnvelope } {
    if (!this.isConnected(msg.channelId)) {
      return { error: channelError('UNAVAILABLE', `channel '${msg.channelId}' is not connected; cannot deliver`, 'channel.deliver', msg.correlationId) };
    }
    const valid = validateNormalizedMessage(msg);
    if (!valid.ok) return { error: valid.error };

    const scope = perChatScope(baseScope, msg.chatId);
    const key = sessionKey(msg.channelId, msg.chatId);
    const existing = this.getSession(msg.channelId, msg.chatId);
    const nextCount = (existing?.messageCount ?? 0) + 1;
    const at = new Date().toISOString();

    applyAuthorityMutation(this.db, {
      authority: CHANNEL_OWNER,
      commandId: makeOpaqueId('cmd', `deliver-${key}-${nextCount}`),
      idempotencyKey: `deliver:${key}:${msg.correlationId}`,
      requestDigest: computeDigest({ channelId: msg.channelId, chatId: msg.chatId, sender: msg.sender, content: msg.content }),
      correlationId: msg.correlationId,
      scope,
      mutate: (tx) => {
        tx.prepare(
          `INSERT INTO channel_sessions (session_key, channel_id, chat_id, message_count, created_at, last_activity_at)
             VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET message_count = ?, last_activity_at = ?`,
        ).run(key, msg.channelId, msg.chatId, nextCount, existing ? existing.messageCount : nextCount, at, nextCount, at);
        return { resultRef: key };
      },
      events: [
        {
          eventType: 'channel.message.delivered',
          aggregateType: 'channel-session',
          aggregateId: key,
          payloadSchemaName: 'ChannelMessageDelivered',
          payloadSchemaVersion: 1,
          // Redact any secret-shaped fields from provider metadata before it
          // becomes an observable event (NN-CHANNEL-006 / NN-SEC-006).
          payload: {
            channelId: msg.channelId,
            chatId: msg.chatId,
            contentType: msg.contentType,
            providerMetadata: redactSecrets(msg.providerMetadata),
          },
          redaction: 'internal',
        },
      ],
    });
    return this.getSession(msg.channelId, msg.chatId)!;
  }

  // ── Internal committed status transition ────────────────────────────────────

  private commitStatus(
    channelId: string,
    scope: ScopeDescriptor,
    correlationId: string,
    change: {
      readonly status: ChannelConnectionStatus;
      readonly attempts: number;
      readonly error?: ErrorEnvelope;
      readonly event: string;
    },
  ): void {
    const at = new Date().toISOString();
    applyAuthorityMutation(this.db, {
      authority: CHANNEL_OWNER,
      commandId: makeOpaqueId('cmd', `chan-${change.status}-${channelId}-${change.attempts}-${at}`),
      idempotencyKey: `chan-status:${channelId}:${change.status}:${change.attempts}:${correlationId}`,
      requestDigest: computeDigest({ channelId, status: change.status, attempts: change.attempts }),
      correlationId,
      scope,
      mutate: (tx) => {
        tx.prepare(
          `INSERT INTO channel_connections (channel_id, status, attempts, error_json, updated_at)
             VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(channel_id) DO UPDATE SET status = ?, attempts = ?, error_json = ?, updated_at = ?`,
        ).run(
          channelId,
          change.status,
          change.attempts,
          change.error ? JSON.stringify(change.error) : null,
          at,
          change.status,
          change.attempts,
          change.error ? JSON.stringify(change.error) : null,
          at,
        );
        return { resultRef: channelId };
      },
      events: [
        {
          eventType: change.event,
          aggregateType: 'channel-connection',
          aggregateId: channelId,
          payloadSchemaName: 'ChannelStatusChanged',
          payloadSchemaVersion: 1,
          payload: { channelId, status: change.status, attempts: change.attempts },
          redaction: 'internal',
        },
      ],
    });
  }

  /** Read the ordered outbox events for a per-chat session scope (test/inspection). */
  readSessionOutbox(baseScope: ScopeDescriptor, chatId: string) {
    return readOutboxForScope(this.db, perChatScope(baseScope, chatId));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 8. Scope + key helpers
// ════════════════════════════════════════════════════════════════════════════

/** Composite session key `${channelId}::${chatId}` (NN-CHANNEL-009 isolation). */
export function sessionKey(channelId: string, chatId: string): string {
  return `${channelId}::${chatId}`;
}

/**
 * Derive the per-chat outbox scope from a base scope by binding `sessionId` to
 * the chat id (NN-CHANNEL-009). Two different chats therefore occupy two
 * different scopes and their event sequences never share a counter — there is
 * no single global session.
 */
export function perChatScope(baseScope: ScopeDescriptor, chatId: string): ScopeDescriptor {
  return { ...baseScope, sessionId: makeOpaqueId('chat', chatId) };
}

/** Collect the string secret values from a config object for log scrubbing. */
function secretsOf(config: unknown): readonly string[] {
  if (!config || typeof config !== 'object') return [];
  const secrets: string[] = [];
  const pattern = /token|password|secret|key/i;
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (pattern.test(k) && typeof v === 'string') secrets.push(v);
  }
  return secrets;
}
