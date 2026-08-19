/**
 * Versioned Response Block / Render Intent compatibility.
 *
 * A response block's validated kind always selects its primary surface. A
 * RenderIntentV1 may only refine that surface when this closed, versioned
 * matrix explicitly permits the pair. Display metadata is never considered.
 *
 * Requirements: 2.3-2.5, 7.5, 10.8, 12.3, 22.1
 */

import { parseRenderIntent } from '../contracts/render-intent';
import type { RenderIntentV1 } from '../contracts/render-intent';
import {
  RESPONSE_CONTRACT_VERSION,
  ResponseBlockV1Schema,
  type ResponseBlockKind,
} from '../contracts/response-composition';

export const RESPONSE_COMPATIBILITY_CONTRACT_VERSION = RESPONSE_CONTRACT_VERSION;

export type ResponseIntentKind = RenderIntentV1['kind'];

/** Exhaustive V1 intent-kind set used by fixtures and matrix audits. */
const V1_INTENT_KIND_SET = {
  generic: true,
  read: true,
  search: true,
  diff: true,
  terminal: true,
  web: true,
  image: true,
  table: true,
  tree: true,
  artifact: true,
} as const satisfies Readonly<Record<ResponseIntentKind, true>>;

export const RESPONSE_INTENT_KINDS_V1: readonly ResponseIntentKind[] = Object.freeze(
  Object.keys(V1_INTENT_KIND_SET) as ResponseIntentKind[],
);

/**
 * Closed V1 allowlist. Empty rows are intentional: those block surfaces do
 * not accept RenderIntent refinements in V1. Tool activity supports every V1
 * intent, but its block kind remains the selected primary surface.
 */
const V1_COMPATIBILITY = {
  narrative: [],
  reasoning: [],
  turn_status: [],
  tool_activity: RESPONSE_INTENT_KINDS_V1,
  task_progress: [],
  decision: [],
  recommendation: [],
  context: ['read', 'web'],
  code: ['read', 'artifact'],
  diff: ['diff'],
  structured_data: ['table', 'tree'],
  insight: ['table'],
  attachment: ['image', 'artifact'],
  error: [],
  follow_up_actions: [],
} as const satisfies Readonly<Record<ResponseBlockKind, readonly ResponseIntentKind[]>>;

export const RESPONSE_COMPATIBILITY_MATRIX_V1: Readonly<
  Record<ResponseBlockKind, readonly ResponseIntentKind[]>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(V1_COMPATIBILITY).map(([kind, intents]) => [kind, Object.freeze([...intents])]),
  ) as Record<ResponseBlockKind, readonly ResponseIntentKind[]>,
);

export interface ResponseCompatibilityMatrix {
  isCompatible(
    blockKind: ResponseBlockKind,
    intentKind: ResponseIntentKind,
    contractVersion: number,
  ): boolean;
}

/**
 * Fast boolean lookup for callers that already hold validated block and
 * intent discriminators. Unknown versions always fail closed.
 */
export const responseCompatibilityMatrix: ResponseCompatibilityMatrix = Object.freeze({
  isCompatible(
    blockKind: ResponseBlockKind,
    intentKind: ResponseIntentKind,
    contractVersion: number,
  ): boolean {
    if (contractVersion !== RESPONSE_COMPATIBILITY_CONTRACT_VERSION) {
      return false;
    }

    const allowed = RESPONSE_COMPATIBILITY_MATRIX_V1[blockKind];
    return Array.isArray(allowed) && (allowed as readonly ResponseIntentKind[]).includes(intentKind);
  },
});

export type ResponseCompatibilityFailureReason =
  | 'invalid_block'
  | 'invalid_block_kind'
  | 'unsupported_contract_version'
  | 'invalid_render_intent'
  | 'absent_mapping'
  | 'conflicting_mapping';

export type ResponseCompatibilityDecision =
  | {
      compatible: true;
      contractVersion: 1;
      surfaceKind: ResponseBlockKind;
      refinement: RenderIntentV1;
    }
  | {
      compatible: false;
      contractVersion: number;
      surfaceKind?: ResponseBlockKind;
      reason: ResponseCompatibilityFailureReason;
    };

function isResponseBlockKind(value: unknown): value is ResponseBlockKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(RESPONSE_COMPATIBILITY_MATRIX_V1, value)
  );
}

function parseRenderIntentSafely(rawIntent: unknown): ReturnType<typeof parseRenderIntent> | undefined {
  try {
    return parseRenderIntent(rawIntent);
  } catch {
    return undefined;
  }
}

/**
 * Boundary decision for a raw intent. The block discriminator is validated
 * before parseRenderIntent is invoked, so malformed or unknown blocks cannot
 * use intent data to influence surface selection.
 */
export function evaluateResponseCompatibility(
  blockKind: unknown,
  rawIntent: unknown,
  contractVersion: number,
): ResponseCompatibilityDecision {
  if (!isResponseBlockKind(blockKind)) {
    return {
      compatible: false,
      contractVersion,
      reason: 'invalid_block_kind',
    };
  }

  if (contractVersion !== RESPONSE_COMPATIBILITY_CONTRACT_VERSION) {
    return {
      compatible: false,
      contractVersion,
      surfaceKind: blockKind,
      reason: 'unsupported_contract_version',
    };
  }

  const parsed = parseRenderIntentSafely(rawIntent);
  if (parsed === undefined || !parsed.ok) {
    return {
      compatible: false,
      contractVersion,
      surfaceKind: blockKind,
      reason: 'invalid_render_intent',
    };
  }

  if (
    responseCompatibilityMatrix.isCompatible(
      blockKind,
      parsed.intent.kind,
      contractVersion,
    )
  ) {
    return {
      compatible: true,
      contractVersion: RESPONSE_COMPATIBILITY_CONTRACT_VERSION,
      surfaceKind: blockKind,
      refinement: parsed.intent,
    };
  }

  return {
    compatible: false,
    contractVersion,
    surfaceKind: blockKind,
    reason:
      RESPONSE_COMPATIBILITY_MATRIX_V1[blockKind].length === 0
        ? 'absent_mapping'
        : 'conflicting_mapping',
  };
}

/**
 * Result of selecting semantics from an untrusted response block. A valid
 * block without a render intent selects its primary surface with no
 * refinement. Any block or intent failure remains inert for the caller.
 */
export type ResponseBlockCompatibilityDecision =
  | {
      compatible: true;
      contractVersion: 1;
      surfaceKind: ResponseBlockKind;
      refinement?: RenderIntentV1;
    }
  | {
      compatible: false;
      contractVersion: number | null;
      surfaceKind?: ResponseBlockKind;
      reason: ResponseCompatibilityFailureReason;
    };

function readOwnField(record: Record<string, unknown>, key: string): unknown {
  try {
    return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate an entire response block before consulting its render intent.
 * This is the raw renderer boundary: callers must not extract display text,
 * filenames, tool names, emoji, or prose to choose a surface.
 */
export function evaluateResponseBlockCompatibility(
  rawBlock: unknown,
): ResponseBlockCompatibilityDecision {
  if (typeof rawBlock !== 'object' || rawBlock === null || Array.isArray(rawBlock)) {
    return {
      compatible: false,
      contractVersion: null,
      reason: 'invalid_block',
    };
  }

  const record = rawBlock as Record<string, unknown>;
  const rawVersion = readOwnField(record, 'schemaVersion');
  const rawKind = readOwnField(record, 'kind');
  const blockKind = isResponseBlockKind(rawKind) ? rawKind : undefined;

  if (typeof rawVersion === 'number' && rawVersion !== RESPONSE_COMPATIBILITY_CONTRACT_VERSION) {
    return {
      compatible: false,
      contractVersion: rawVersion,
      ...(blockKind === undefined ? {} : { surfaceKind: blockKind }),
      reason: 'unsupported_contract_version',
    };
  }

  if (blockKind === undefined) {
    return {
      compatible: false,
      contractVersion: typeof rawVersion === 'number' ? rawVersion : null,
      reason: 'invalid_block_kind',
    };
  }

  let parsedBlock: ReturnType<typeof ResponseBlockV1Schema.safeParse>;
  try {
    parsedBlock = ResponseBlockV1Schema.safeParse(rawBlock);
  } catch {
    return {
      compatible: false,
      contractVersion: typeof rawVersion === 'number' ? rawVersion : null,
      surfaceKind: blockKind,
      reason: 'invalid_block',
    };
  }

  if (!parsedBlock.success) {
    return {
      compatible: false,
      contractVersion: typeof rawVersion === 'number' ? rawVersion : null,
      surfaceKind: blockKind,
      reason: 'invalid_block',
    };
  }

  const block = parsedBlock.data;
  if (block.renderIntent === undefined) {
    return {
      compatible: true,
      contractVersion: RESPONSE_COMPATIBILITY_CONTRACT_VERSION,
      surfaceKind: block.kind,
    };
  }

  return evaluateResponseCompatibility(
    block.kind,
    block.renderIntent,
    RESPONSE_COMPATIBILITY_CONTRACT_VERSION,
  );
}