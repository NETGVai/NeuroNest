/**
 * Verification Agent — Interfaces for automated verification of system behavior.
 *
 * Interprets natural language verification descriptions, executes verification steps,
 * and reports structured verdicts (PASS, FAIL, INCONCLUSIVE) with supporting evidence.
 *
 * Requirements: 12.1–12.9
 */

// ─── Types ──────────────────────────────────────────────────────

/** Verification verdict */
export type VerificationVerdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

/** Verification step result */
export interface VerificationStep {
  stepNumber: number;
  description: string;
  action: string;
  expected: string;
  observed: string;
  passed: boolean;
}

/** Complete verification result */
export interface VerificationResult {
  requestId: string;
  verdict: VerificationVerdict;
  steps: VerificationStep[];
  summary: string;
  duration: number;
  evidence: {
    failedStep?: VerificationStep;
    unverifiableAspects?: string[];
    reason?: string;
  };
}

/** Verification request */
export interface VerificationRequest {
  description: string;
  scope: 'code-level' | 'system-level' | 'both';
  targetPaths?: string[];
  timeoutMs?: number;
}

/** Verification Agent interface */
export interface IVerificationAgent {
  verify(request: VerificationRequest): Promise<VerificationResult>;
  getResults(since?: string): VerificationResult[];
}
