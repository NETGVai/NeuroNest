/**
 * Integrity Hash Computation for Session Log
 *
 * Computes SHA-256 integrity hashes over the canonical event fields:
 * (sessionId, branchId, sequence, eventType, payload, previousIntegrityHash)
 *
 * The hash chain guarantees append-only immutability and allows verification
 * of event sequence integrity at any point.
 *
 * Requirements: 3.5–3.7, 28.4–28.6
 */

import crypto from 'node:crypto';

/**
 * Input fields for integrity hash computation.
 */
export interface IntegrityHashInput {
  sessionId: string;
  branchId: string;
  sequence: number;
  eventType: string;
  payload: string;
  previousIntegrityHash: string | null;
}

/**
 * Compute the SHA-256 integrity hash for a session event.
 *
 * The hash is computed over a deterministic canonical representation:
 * SHA-256(sessionId | branchId | sequence | eventType | payload | previousIntegrityHash)
 *
 * Uses pipe (|) as field separator with the literal string "null" for absent previous hash.
 */
export function computeIntegrityHash(input: IntegrityHashInput): string {
  const canonical = [
    input.sessionId,
    input.branchId,
    String(input.sequence),
    input.eventType,
    input.payload,
    input.previousIntegrityHash ?? 'null',
  ].join('|');

  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify a chain of integrity hashes.
 *
 * Returns the index of the first fault (0-based from the provided events array),
 * or -1 if the entire chain is valid.
 *
 * @param events - Array of events with their fields to verify
 * @param expectedFirstPrevHash - The expected previousIntegrityHash of the first event
 */
export function verifyIntegrityChain(
  events: Array<{
    sessionId: string;
    branchId: string;
    sequence: number;
    eventType: string;
    payload: string;
    previousIntegrityHash: string | null;
    integrityHash: string;
  }>,
  expectedFirstPrevHash: string | null = null
): { valid: boolean; faultIndex: number; faultReason?: string } {
  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Verify previousIntegrityHash linkage
    if (i === 0) {
      if (event.previousIntegrityHash !== expectedFirstPrevHash) {
        return {
          valid: false,
          faultIndex: i,
          faultReason: `Expected previousIntegrityHash "${expectedFirstPrevHash}" but got "${event.previousIntegrityHash}"`,
        };
      }
    } else {
      const prevEvent = events[i - 1];
      if (event.previousIntegrityHash !== prevEvent.integrityHash) {
        return {
          valid: false,
          faultIndex: i,
          faultReason: `previousIntegrityHash does not match prior event's integrityHash`,
        };
      }
    }

    // Verify the hash itself
    const computed = computeIntegrityHash({
      sessionId: event.sessionId,
      branchId: event.branchId,
      sequence: event.sequence,
      eventType: event.eventType,
      payload: event.payload,
      previousIntegrityHash: event.previousIntegrityHash,
    });

    if (computed !== event.integrityHash) {
      return {
        valid: false,
        faultIndex: i,
        faultReason: `Integrity hash mismatch: computed "${computed}" but stored "${event.integrityHash}"`,
      };
    }
  }

  return { valid: true, faultIndex: -1 };
}
