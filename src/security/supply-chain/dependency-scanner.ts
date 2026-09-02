/**
 * Resource-bounded dependency / compliance scanner (NN-SEC-013, D-16.7,
 * V-SEC-001/scanner-resource-bounds).
 *
 * FUT-PKG-04-SECURITY/T-008. Diagnostics MUST run within bounded resources
 * (NN-SEC-013): "scan within bounded resources, skip and label oversized/
 * unavailable inputs, cite rule/source evidence". A scan that WOULD exceed its
 * time or memory budget aborts with a typed `UNAVAILABLE`/`TIMEOUT` result —
 * it never hangs and never returns a fabricated "clean" verdict.
 *
 * The bounding is done by a deterministic *work accounting* model rather than
 * real wall-clock timers so the behavior is fully testable and identical on
 * every platform: each unit scanned costs a known amount, and each input has a
 * declared size. Before scanning an input the scanner asks "would this exceed
 * the remaining budget?" and, if so, aborts. This mirrors a real cooperative
 * cancellation loop that checks a deadline / heap-usage sample between units.
 *
 * The scanner distinguishes BLOCKING findings from ADVISORY findings and
 * labels every skipped input; it is the evidence source the supply-chain gate
 * consumes.
 *
 * Requirements: NN-SEC-013, NN-SEC-012, NN-INV-001, NN-INV-011, NN-INV-014.
 * Design anchors: D-16 (D-16.7), D-19, D-24.
 */

import {
  CONTRACT_WRITE_VERSION,
  isOpaqueId,
  type ErrorEnvelope,
} from '../../shared/contract-primitives';
import type { FindingSeverity } from './supply-chain-gate';

const SCANNER_OWNER = 'authority-supply-chain-scanner';

// ─── Resource bounds ──────────────────────────────────────────────────────────

/**
 * The bounds a scan runs under. All values are positive integers. A scan that
 * would exceed any bound aborts as `UNAVAILABLE` (over-size) or `TIMEOUT`
 * (over-budget) rather than continuing (NN-SEC-013).
 */
export interface ScannerBounds {
  /** Maximum total work units the scan may consume before aborting. */
  readonly maxWorkUnits: number;
  /** Maximum size (bytes) of a single input; larger inputs are skipped. */
  readonly maxInputBytes: number;
  /** Maximum number of inputs examined before aborting. */
  readonly maxInputs: number;
}

/** Safe, conservative default bounds. */
export function defaultScannerBounds(overrides?: Partial<ScannerBounds>): ScannerBounds {
  return {
    maxWorkUnits: overrides?.maxWorkUnits ?? 100_000,
    maxInputBytes: overrides?.maxInputBytes ?? 5_000_000,
    maxInputs: overrides?.maxInputs ?? 10_000,
  };
}

/** A unit of scannable input (a file, dependency entry, or manifest section). */
export interface ScanInput {
  readonly id: string;
  /** Declared size in bytes; drives both skip and work accounting. */
  readonly sizeBytes: number;
  /** The bytes to inspect for canary/rule matches (already read by adapter). */
  readonly content: string;
}

// ─── Findings and results ──────────────────────────────────────────────────────

/** A finding produced by scanning one input. */
export interface ScanFinding {
  readonly inputId: string;
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  /** Whether the finding blocks (blocking vs advisory, NN-SEC-013). */
  readonly blocking: boolean;
  readonly detail: string;
}

/** A skipped input with the reason it was labeled skipped (NN-SEC-013). */
export interface SkippedInput {
  readonly inputId: string;
  readonly reason: 'oversized' | 'unavailable';
}

/** A rule the scanner applies. `test` must be pure and bounded. */
export interface ScanRule {
  readonly ruleId: string;
  readonly severity: FindingSeverity;
  readonly blocking: boolean;
  /** Approximate cost, in work units, to run this rule against one input. */
  readonly costPerInput: number;
  /** Pure matcher over an input's content. */
  readonly test: (content: string) => boolean;
  readonly detail: string;
}

/**
 * The result of a scan. Either a completed scan (possibly with skipped inputs
 * that are explicitly labeled) or a typed abort. A completed scan NEVER hides
 * that it skipped work: `skipped` and `partial` make partiality observable
 * (NN-INV-011). An aborted scan carries a typed error and NO findings verdict.
 */
export type ScanResult =
  | {
      readonly outcome: 'complete';
      readonly findings: readonly ScanFinding[];
      readonly skipped: readonly SkippedInput[];
      /** True when at least one input was skipped/oversized. */
      readonly partial: boolean;
      readonly workUnitsUsed: number;
      readonly inputsScanned: number;
    }
  | {
      readonly outcome: 'aborted';
      readonly error: ErrorEnvelope;
      /** Findings gathered before the abort (never a clean verdict). */
      readonly findings: readonly ScanFinding[];
      readonly workUnitsUsed: number;
      readonly inputsScanned: number;
    };

function scannerError(
  code: ErrorEnvelope['code'],
  message: string,
  correlationId?: string,
): ErrorEnvelope {
  return {
    schemaVersion: CONTRACT_WRITE_VERSION,
    code,
    message,
    owner: SCANNER_OWNER,
    operation: 'scan-dependencies',
    correlationId: isOpaqueId(correlationId) ? correlationId : 'corr-unset',
    retryable: code === 'TIMEOUT',
    remediation:
      'Reduce the scan scope or raise the configured resource bounds; a scan ' +
      'that would exceed its bounds aborts as unavailable and never returns a ' +
      'clean verdict.',
    redaction: 'internal',
  };
}

/**
 * Run a resource-bounded scan. The scanner walks each input in order and, for
 * each, checks BEFORE doing the work whether it would exceed the remaining
 * budget:
 *
 *   - If we have already examined `maxInputs`, abort (`TIMEOUT`).
 *   - If the input is larger than `maxInputBytes`, skip and label it
 *     `oversized` (NN-SEC-013) — this is not an abort.
 *   - If running the applicable rules would push `workUnitsUsed` over
 *     `maxWorkUnits`, abort (`TIMEOUT`) rather than run past the bound.
 *
 * On abort the scanner returns the findings gathered so far AND the typed
 * error; a caller MUST treat an aborted scan as "not clean" (NN-INV-001).
 */
export function scanDependencies(
  inputs: readonly ScanInput[],
  rules: readonly ScanRule[],
  bounds: ScannerBounds,
  correlationId?: string,
): ScanResult {
  const findings: ScanFinding[] = [];
  const skipped: SkippedInput[] = [];
  let workUnitsUsed = 0;
  let inputsScanned = 0;

  const ruleCost = rules.reduce((sum, r) => sum + r.costPerInput, 0);

  for (const input of inputs) {
    // Bound: number of inputs examined.
    if (inputsScanned >= bounds.maxInputs) {
      return {
        outcome: 'aborted',
        error: scannerError(
          'TIMEOUT',
          'scan aborted: input count bound exceeded',
          correlationId,
        ),
        findings,
        workUnitsUsed,
        inputsScanned,
      };
    }

    // Skip (not abort): an oversized input is labeled and passed over.
    if (
      !Number.isFinite(input.sizeBytes) ||
      input.sizeBytes < 0 ||
      input.sizeBytes > bounds.maxInputBytes
    ) {
      skipped.push({ inputId: input.id, reason: 'oversized' });
      continue;
    }

    // Bound: would running the rules over this input exceed the work budget?
    // Check BEFORE doing the work so we never run past the bound (no hang).
    if (workUnitsUsed + ruleCost > bounds.maxWorkUnits) {
      return {
        outcome: 'aborted',
        error: scannerError(
          'TIMEOUT',
          'scan aborted: work-unit budget would be exceeded',
          correlationId,
        ),
        findings,
        workUnitsUsed,
        inputsScanned,
      };
    }

    for (const rule of rules) {
      workUnitsUsed += rule.costPerInput;
      if (rule.test(input.content)) {
        findings.push({
          inputId: input.id,
          ruleId: rule.ruleId,
          severity: rule.severity,
          blocking: rule.blocking,
          detail: rule.detail,
        });
      }
    }
    inputsScanned += 1;
  }

  return {
    outcome: 'complete',
    findings,
    skipped,
    partial: skipped.length > 0,
    workUnitsUsed,
    inputsScanned,
  };
}

/**
 * Whether a completed or aborted scan authorizes treating the target as clean.
 * ONLY a completed, non-partial scan with no blocking findings is clean. An
 * abort or a partial scan is never clean (NN-INV-001 fail closed).
 */
export function scanAuthorizesClean(result: ScanResult): boolean {
  if (result.outcome !== 'complete') return false;
  if (result.partial) return false;
  return !result.findings.some((f) => f.blocking);
}
