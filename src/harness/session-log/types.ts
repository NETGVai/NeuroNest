/**
 * Session Log Types
 *
 * Interfaces for append commands, receipts, fork commands, range queries,
 * integrity reports, and checkpoint-assisted replay.
 *
 * Requirements: 3.1–3.7, 15.7–15.8, 28.4–28.6, 34.4, 44.2–44.3, 44.13
 */

import type { ActorRef } from '../contracts/actor.js';
import type { ScopeDescriptorV1 } from '../contracts/scope.js';
import type { SessionEventV1, SessionEventPayloadV1 } from '../contracts/event.js';

// ─── Append Command ─────────────────────────────────────────────

export interface AppendEventCommand {
  sessionId: string;
  branchId?: string;
  /** Optional authority-issued durable identity. Generated when omitted. */
  eventId?: string;
  eventType: string;
  payload: SessionEventPayloadV1;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
  /** Optional source timestamp retained for imported or normalized facts. */
  occurredAt?: string;
  idempotencyKey?: string;
}

export interface AtomicEventBatchCommand {
  sessionId: string;
  branchId?: string;
  events: Array<{
    /** Optional authority-issued durable identity. Generated when omitted. */
    eventId?: string;
    eventType: string;
    payload: SessionEventPayloadV1;
    actor: ActorRef;
    scope: ScopeDescriptorV1;
    /** Optional source timestamp retained for imported or normalized facts. */
    occurredAt?: string;
    idempotencyKey?: string;
  }>;
}

// ─── Fork Command ───────────────────────────────────────────────

export interface ForkSessionCommand {
  parentSessionId: string;
  parentBranchId?: string;
  parentSequence: number;
  childSessionId: string;
  childBranchId?: string;
  actor: ActorRef;
  scope: ScopeDescriptorV1;
}

// ─── Query ──────────────────────────────────────────────────────

export interface SessionRangeQuery {
  sessionId: string;
  branchId?: string;
  fromSequence?: number;
  toSequence?: number;
}

// ─── Receipts ───────────────────────────────────────────────────

export interface AppendReceipt {
  eventId: string;
  sessionId: string;
  branchId: string;
  sequence: number;
  integrityHash: string;
  idempotencyKey?: string;
  alreadyExists: boolean;
}

export interface ForkReceipt {
  parentSessionId: string;
  parentSequence: number;
  childSessionId: string;
  childBranchId: string;
  lineageId: number;
}

// ─── Integrity ──────────────────────────────────────────────────

export interface IntegrityReport {
  sessionId: string;
  branchId: string;
  fromSequence: number;
  toSequence: number;
  totalEvents: number;
  valid: boolean;
  firstFaultSequence?: number;
  firstFaultReason?: string;
}

// ─── Checkpoint Replay ──────────────────────────────────────────

export interface ReplayCheckpoint {
  sessionId: string;
  branchId: string;
  sequence: number;
  integrityHash: string;
}

// ─── Schema Upcaster ────────────────────────────────────────────

export type SchemaUpcaster = (event: SessionEventV1) => SessionEventV1;

export interface UpcasterRegistry {
  register(fromVersion: number, toVersion: number, upcaster: SchemaUpcaster): void;
  upcast(event: SessionEventV1, targetVersion: number): SessionEventV1;
  hasUpcaster(fromVersion: number, toVersion: number): boolean;
}
