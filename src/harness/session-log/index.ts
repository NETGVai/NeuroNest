/**
 * Session Log Module
 *
 * Provides the append-only Session_Log, integrity hash computation,
 * schema upcasters, and related types for durable session event storage.
 *
 * Requirements: 3.1–3.7, 15.7–15.8, 28.4–28.6, 34.4, 44.2–44.3, 44.13
 */

export { SessionLog } from './session-log.js';
export { computeIntegrityHash, verifyIntegrityChain } from './integrity.js';
export { DefaultUpcasterRegistry } from './upcasters.js';
export {
  appendAcceptedChatLifecycleEvents,
  appendAcceptedChatStreamEvents,
  appendNormalizedChatEvent,
  appendNormalizedChatEvents,
  mapNormalizedChatEvent,
  upcastNormalizedChatEvent,
} from './normalized-events.js';
export type {
  AcceptedChatLifecycleEventV1,
  AcceptedChatStreamEventV1Like,
  AppendAcceptedChatLifecycleOptions,
  ChatLifecycleObserverErrorPolicy,
  CommittedChatLifecycleObserver,
  DurableChatLifecycleAppendResult,
  NormalizedAppendContext,
  NormalizedChatEventInput,
  NormalizedChatEventV0,
  NormalizedChatEventV1,
  NormalizedSessionEventTypeV1,
} from './normalized-events.js';
export type {
  IntegrityHashInput,
} from './integrity.js';
export type {
  AppendEventCommand,
  AtomicEventBatchCommand,
  ForkSessionCommand,
  SessionRangeQuery,
  AppendReceipt,
  ForkReceipt,
  IntegrityReport,
  ReplayCheckpoint,
  SchemaUpcaster,
  UpcasterRegistry,
} from './types.js';
