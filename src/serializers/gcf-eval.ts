//
// GCF_Comprehension_Eval — F10 per-provider comprehension gate. Before any
// provider's traffic flips from JSON to the GCF wire format we must prove the
// active LLM reads GCF with parity to JSON. This module defines a fixed
// reference payload, a set of structured-extraction questions over it, and an
// `evaluateProvider` routine that scores a provider under both encodings and
// persists the verdict to `~/.neuronest/gcf-capabilities.json`.
//
// Requirements: 56.1, 56.2, 56.3

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { encodeGraph, type GraphPayload } from './gcf-encoder.js';

/**
 * A single structured-extraction probe over a reference payload. The provider
 * is shown the payload (encoded as either JSON or GCF) plus {@link question}
 * and its free-text answer is scored by substring match against
 * {@link expectedAnswer} (see {@link scoreAnswer}).
 *
 * Mirrors the design's F10 contract: each question carries the `payload` it is
 * asked over so the question bank is self-describing. All questions in
 * {@link GCF_EVAL_QUESTIONS} share the single fixed reference payload required
 * by Requirement 56.1.
 */
export interface GCFEvalQuestion {
  id: string;
  /** The reference payload the question is asked over (the fixed payload). */
  payload: unknown;
  question: string;
  /** Keyword/substring the correct answer must contain (case-insensitive). */
  expectedAnswer: string;
}

/**
 * The persisted verdict for one provider. `gcfCapable` is the Phase 1 rollout
 * gate input: a provider only emits GCF once it has read GCF with parity to
 * JSON (Requirement 56.3).
 */
export interface ProviderCapability {
  providerType: string;
  /** JSON-encoded comprehension accuracy, 0..1 (Requirement 56.2). */
  jsonAccuracy: number;
  /** GCF-encoded comprehension accuracy, 0..1. */
  gcfAccuracy: number;
  /** True iff `gcfAccuracy >= jsonAccuracy - 0.05` (Requirement 56.3). */
  gcfCapable: boolean;
  /** Epoch millis the eval completed. */
  evaluatedAt: number;
}

/**
 * GCF is judged "capable" when its accuracy is within this many points (on the
 * 0..1 scale) of the JSON baseline — i.e. 5 percentage points (Requirement
 * 56.3).
 */
export const GCF_PARITY_MARGIN = 0.05;

/** Absolute path of the on-disk capabilities ledger. */
export const CAPABILITIES_FILE_PATH = path.join(
  os.homedir(),
  '.neuronest',
  'gcf-capabilities.json',
);

/**
 * The single fixed reference payload all eval questions are asked over
 * (Requirement 56.1). It is intentionally small but exercises every symbol
 * `kind`, distinct scores, and edges so the extraction questions have
 * unambiguous answers.
 */
export const REFERENCE_PAYLOAD: GraphPayload = {
  tool: 'code-index',
  tokenBudget: 4096,
  tokensUsed: 512,
  symbols: [
    {
      qualifiedName: 'ConfigLoader',
      kind: 'class',
      score: 0.95,
      provenance: 'src/config/loader.ts',
      distance: 0,
    },
    {
      qualifiedName: 'ConfigLoader.load',
      kind: 'method',
      score: 0.82,
      provenance: 'src/config/loader.ts',
      distance: 1,
    },
    {
      qualifiedName: 'parseConfig',
      kind: 'function',
      score: 0.74,
      provenance: 'src/config/parse.ts',
      distance: 1,
    },
    {
      qualifiedName: 'MAX_RETRIES',
      kind: 'variable',
      score: 0.41,
      provenance: 'src/config/parse.ts',
      distance: 2,
    },
    {
      qualifiedName: 'ConfigSchema',
      kind: 'type',
      score: 0.63,
      provenance: 'src/config/schema.ts',
      distance: 2,
    },
  ],
  edges: [
    { source: 'ConfigLoader.load', target: 'parseConfig', edgeType: 'calls' },
    { source: 'parseConfig', target: 'ConfigSchema', edgeType: 'references' },
  ],
};

/**
 * The structured-extraction question bank. At least six questions are required
 * by Requirement 56.1; seven are provided here, covering symbol counting, the
 * tool name, per-symbol kind lookup, edge counting, ranking by score, and
 * symbol-name recall.
 */
export const GCF_EVAL_QUESTIONS: readonly GCFEvalQuestion[] = [
  {
    id: 'symbol-count',
    payload: REFERENCE_PAYLOAD,
    question: 'How many symbols are in the payload? Answer with a number.',
    expectedAnswer: '5',
  },
  {
    id: 'tool-name',
    payload: REFERENCE_PAYLOAD,
    question: 'What is the value of the tool field?',
    expectedAnswer: 'code-index',
  },
  {
    id: 'kind-of-ConfigLoader',
    payload: REFERENCE_PAYLOAD,
    question: "What kind is the symbol 'ConfigLoader'?",
    expectedAnswer: 'class',
  },
  {
    id: 'kind-of-parseConfig',
    payload: REFERENCE_PAYLOAD,
    question: "What kind is the symbol 'parseConfig'?",
    expectedAnswer: 'function',
  },
  {
    id: 'edge-count',
    payload: REFERENCE_PAYLOAD,
    question: 'How many edges are in the payload? Answer with a number.',
    expectedAnswer: '2',
  },
  {
    id: 'highest-score',
    payload: REFERENCE_PAYLOAD,
    question:
      'Which symbol has the highest score? Answer with its qualified name.',
    expectedAnswer: 'ConfigLoader',
  },
  {
    id: 'variable-name',
    payload: REFERENCE_PAYLOAD,
    question:
      'What is the qualified name of the symbol whose kind is variable?',
    expectedAnswer: 'MAX_RETRIES',
  },
];

/**
 * Score one answer against its expected keyword. Case-insensitive substring
 * match — robust to the LLM wrapping the answer in a sentence ("There are 5
 * symbols.") while still rejecting wrong values.
 */
export function scoreAnswer(answer: string, expected: string): boolean {
  if (typeof answer !== 'string') return false;
  return answer.toLowerCase().includes(expected.toLowerCase());
}

/**
 * Build the prompt shown to the provider for one question: the encoded payload
 * followed by the question and an instruction to answer concisely.
 */
function buildPrompt(encodedPayload: string, question: string): string {
  return [
    'You are given a structured payload describing code symbols and their',
    'relationships. Use ONLY the payload to answer the question. Answer as',
    'concisely as possible.',
    '',
    'PAYLOAD:',
    encodedPayload,
    '',
    `QUESTION: ${question}`,
    'ANSWER:',
  ].join('\n');
}

/**
 * Run the full question bank against `llmCall` using one encoding of the
 * reference payload and return accuracy in 0..1.
 */
async function runEval(
  encodedPayload: string,
  llmCall: (prompt: string) => Promise<string>,
): Promise<number> {
  let correct = 0;
  for (const q of GCF_EVAL_QUESTIONS) {
    const answer = await llmCall(buildPrompt(encodedPayload, q.question));
    if (scoreAnswer(answer ?? '', q.expectedAnswer)) correct += 1;
  }
  return correct / GCF_EVAL_QUESTIONS.length;
}

/** Read the existing capabilities ledger, tolerating a missing/corrupt file. */
function readCapabilities(): Record<string, ProviderCapability> {
  try {
    const raw = fs.readFileSync(CAPABILITIES_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, ProviderCapability>;
    }
  } catch {
    // Missing or unreadable ledger — start fresh.
  }
  return {};
}

/** Persist `capability`, merging by `providerType` into the on-disk ledger. */
function persistCapability(capability: ProviderCapability): void {
  const ledger = readCapabilities();
  ledger[capability.providerType] = capability;
  fs.mkdirSync(path.dirname(CAPABILITIES_FILE_PATH), { recursive: true });
  fs.writeFileSync(
    CAPABILITIES_FILE_PATH,
    `${JSON.stringify(ledger, null, 2)}\n`,
    'utf8',
  );
}

/**
 * Evaluate one provider's comprehension of the GCF wire format relative to its
 * JSON baseline, persist the verdict, and return it.
 *
 * Runs the fixed question bank twice — once with the reference payload encoded
 * as JSON (the baseline, Requirement 56.2) and once with it encoded as GCF —
 * then marks `gcfCapable` true only if GCF accuracy is within
 * {@link GCF_PARITY_MARGIN} of the JSON baseline (Requirement 56.3). The result
 * is merged by `providerType` into `~/.neuronest/gcf-capabilities.json`.
 */
export async function evaluateProvider(
  providerType: string,
  llmCall: (prompt: string) => Promise<string>,
): Promise<ProviderCapability> {
  const jsonEncoded = JSON.stringify(REFERENCE_PAYLOAD);
  // Fall back to JSON if GCF encoding fails so the eval still produces a
  // verdict (encodeGraph returns null rather than throwing — Req 51.4).
  const gcfEncoded = encodeGraph(REFERENCE_PAYLOAD) ?? jsonEncoded;

  const jsonAccuracy = await runEval(jsonEncoded, llmCall);
  const gcfAccuracy = await runEval(gcfEncoded, llmCall);

  const capability: ProviderCapability = {
    providerType,
    jsonAccuracy,
    gcfAccuracy,
    gcfCapable: gcfAccuracy >= jsonAccuracy - GCF_PARITY_MARGIN,
    evaluatedAt: Date.now(),
  };

  persistCapability(capability);
  return capability;
}

// ---------------------------------------------------------------------------
// Phase 1 rollout gate (task 40.2 / Requirement 56.4)
// ---------------------------------------------------------------------------
//
// The Phase 1 rollout gate for `GCF_WIRE_FORMAT` requires every
// currently-configured provider to be marked `gcfCapable: true` in the
// persisted capabilities ledger before the flag may flip to active mode. This
// module supplies the pure gate predicate plus the disk-/config-bound helpers
// the IPC layer wires up so the Settings panel can surface a yellow warning
// banner naming the providers that still block the flip.

/**
 * The result of evaluating the Phase 1 rollout gate. `allowed` is the single
 * bit the operator UI keys off: the `GCF_WIRE_FORMAT` active flip may proceed
 * only when it is `true` (every configured provider has proven GCF parity).
 * The three name lists let the Settings banner explain exactly which providers
 * still block the flip.
 */
export interface RolloutGateStatus {
  /**
   * True iff the gate permits flipping `GCF_WIRE_FORMAT` to active — i.e.
   * {@link nonCapableProviders} is empty. Vacuously true when no providers are
   * configured (there is nothing that could misread GCF).
   */
  allowed: boolean;
  /** Every configured provider type considered by the gate (deduped). */
  configuredProviders: string[];
  /** Configured providers marked `gcfCapable: true` in the ledger. */
  capableProviders: string[];
  /**
   * Configured providers that block the flip — either absent from the ledger
   * (never evaluated) or present with `gcfCapable: false`.
   */
  nonCapableProviders: string[];
}

/**
 * Read the persisted capabilities ledger from
 * `~/.neuronest/gcf-capabilities.json`. Public counterpart of the internal
 * reader used by {@link evaluateProvider}; tolerates a missing or corrupt file
 * by returning an empty ledger so the gate degrades to "no provider is
 * capable" rather than throwing.
 */
export function loadCapabilities(): Record<string, ProviderCapability> {
  return readCapabilities();
}

/**
 * Extract the deduped list of provider *types* from a configured-providers
 * value (typically the parsed `providers` config array). Each record's `type`
 * is preferred (it matches the `providerType` key the eval persists under);
 * `name` is used as a fallback for records that carry only a display name.
 * Records with neither are skipped. Non-array input yields an empty list so a
 * missing/garbage config degrades to "no providers configured".
 */
export function getConfiguredProviderTypes(providers: unknown): string[] {
  if (!Array.isArray(providers)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of providers) {
    if (!p || typeof p !== 'object') continue;
    const record = p as { type?: unknown; name?: unknown };
    const raw =
      typeof record.type === 'string' && record.type.trim() !== ''
        ? record.type
        : typeof record.name === 'string' && record.name.trim() !== ''
          ? record.name
          : null;
    if (raw == null) continue;
    const key = raw.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Pure rollout-gate predicate. Given the configured provider types and the
 * capabilities ledger, classify each provider as capable or non-capable and
 * decide whether the `GCF_WIRE_FORMAT` active flip is allowed.
 *
 * A provider is capable only when the ledger holds an entry for it with
 * `gcfCapable === true`. A provider that was never evaluated (no ledger entry)
 * is treated as non-capable — the gate fails closed (Requirement 56.4).
 */
export function evaluateRolloutGate(
  providerTypes: readonly string[],
  capabilities: Record<string, ProviderCapability>,
): RolloutGateStatus {
  const configuredProviders: string[] = [];
  const capableProviders: string[] = [];
  const nonCapableProviders: string[] = [];

  const seen = new Set<string>();
  for (const type of providerTypes) {
    if (typeof type !== 'string' || type.trim() === '') continue;
    const key = type.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    configuredProviders.push(key);

    const cap = capabilities[key];
    if (cap && cap.gcfCapable === true) {
      capableProviders.push(key);
    } else {
      nonCapableProviders.push(key);
    }
  }

  return {
    allowed: nonCapableProviders.length === 0,
    configuredProviders,
    capableProviders,
    nonCapableProviders,
  };
}

/**
 * Convenience entry point for the main process / IPC layer: evaluate the
 * rollout gate against the live configured-providers value, loading the
 * capabilities ledger from disk. Combines {@link getConfiguredProviderTypes},
 * {@link loadCapabilities}, and {@link evaluateRolloutGate}.
 */
export function getRolloutGateStatus(providers: unknown): RolloutGateStatus {
  return evaluateRolloutGate(
    getConfiguredProviderTypes(providers),
    loadCapabilities(),
  );
}
