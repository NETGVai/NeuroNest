/**
 * Types for the Loop Spec Editor renderer component.
 */

import type { LoopSpec, DoctorFinding } from '../../../loop-engine/index';

// ─── Validation Error ───────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
}

// ─── Mapped Doctor Finding ──────────────────────────────────────

export interface MappedDoctorFinding {
  field: string;
  finding: DoctorFinding;
}

// ─── Editor State ───────────────────────────────────────────────

export interface LoopSpecEditorState {
  values: Partial<LoopSpec>;
  validationErrors: ValidationError[];
  doctorFindings: MappedDoctorFinding[];
  isDirty: boolean;
  isValidating: boolean;
}

// ─── Verify Form Entry ──────────────────────────────────────────

export interface VerifyFormEntry {
  id: string;
  type: string;
  isLlmJudge: boolean;
  [key: string]: unknown;
}
