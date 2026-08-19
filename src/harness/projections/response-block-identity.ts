import { createHash } from 'node:crypto';
import type { ResponseBlockKind, ResponseBlockRole } from '../contracts/response-composition.js';

/**
 * Version of the canonical response-block stable-key derivation.
 *
 * Bumping this value is a contract change because projected keys are used to
 * preserve mounted surface identity across composition updates.
 */
export const RESPONSE_BLOCK_STABLE_KEY_VERSION = 1 as const;

/** Immutable business identity used to derive a response-block stable key. */
export interface ResponseBlockStableIdentityInput {
  readonly sessionId: string;
  readonly branchId: string;
  readonly compositionId: string;
  readonly entityKind: ResponseBlockKind;
  readonly entityId: string;
  readonly role: ResponseBlockRole;
}

/**
 * Derive a stable response-block key from immutable identity only.
 *
 * JSON tuple encoding prevents delimiter-boundary ambiguity while retaining a
 * deterministic, versioned SHA-256 derivation analogous to canonical timeline
 * keys. Content, status, timestamps, declared position, and revisions are not
 * accepted by this boundary and therefore cannot affect the result.
 */
export function computeResponseBlockStableKey(input: ResponseBlockStableIdentityInput): string {
  const identityTuple = JSON.stringify([
    `response-block-stable-key-v${RESPONSE_BLOCK_STABLE_KEY_VERSION}`,
    input.sessionId,
    input.branchId,
    input.compositionId,
    input.entityKind,
    input.entityId,
    input.role,
  ]);

  return createHash('sha256').update(identityTuple).digest('hex').slice(0, 32);
}
