/**
 * Types for LoopSpec Editor renderer component.
 *
 * Provides form-driven editing of LoopSpec definitions with inline
 * Loop Doctor finding display adjacent to relevant fields.
 *
 * Validates: Requirements 18.5
 */

import type { LoopSpec, VerifyCheck, DoctorFinding } from '../../../loop-engine/index';

// ─── Field Metadata ─────────────────────────────────────────────

/** Identifies a field in the LoopSpec form. */
export type LoopSpecFieldId =
  | 'name'
  | 'goal'
  | 'passAction'
  | 'verify'
  | 'feedback'
  | 'stop.maxPasses'
  | 'stop.maxCostUsd'
  | 'stop.maxWallClockMin'
  | 'stop.noProgressPasses'
  | 'stop.approvalBoundaries'
  | 'scope.allowedPaths'
  | 'scope.allowedTools'
  | 'scope.securityPolicy';

/** Validation error associated with a specific field. */
export interface FieldValidationError {
  field: LoopSpecFieldId;
  message: string;
}

/** A Loop Doctor finding mapped to a specific form field. */
export interface MappedDoctorFinding {
  field: LoopSpecFieldId;
  finding: DoctorFinding;
}

// ─── Editor State ───────────────────────────────────────────────

/** Internal state for the LoopSpec editor form. */
export interface LoopSpecEditorState {
  /** Current form values as a partial LoopSpec. */
  values: Partial<LoopSpec>;

  /** Validation errors per field from Zod schema validation. */
  validationErrors: FieldValidationError[];

  /** Doctor findings mapped to relevant fields. */
  doctorFindings: MappedDoctorFinding[];

  /** Whether the form has been modified since last save. */
  isDirty: boolean;

  /** Whether validation is currently running. */
  isValidating: boolean;
}

// ─── Editor Config ──────────────────────────────────────────────

/** Configuration for the LoopSpec editor component. */
export interface LoopSpecEditorConfig {
  /** Initial LoopSpec to populate the form (null for new spec). */
  initialSpec: LoopSpec | null;

  /** Callback when the spec is saved. */
  onSave?: (spec: LoopSpec) => void;

  /** Callback when validation state changes. */
  onValidationChange?: (errors: FieldValidationError[]) => void;

  /** Callback when doctor findings are updated. */
  onDoctorFindingsChange?: (findings: MappedDoctorFinding[]) => void;

  /** Whether the form is read-only. */
  readOnly?: boolean;
}

// ─── Verify Check Editor Types ──────────────────────────────────

/** Type of Verify_Check being edited. */
export type VerifyCheckType = VerifyCheck['type'];

/** Configuration for a verify check entry in the form. */
export interface VerifyCheckFormEntry {
  id: string;
  type: VerifyCheckType;
  data: Partial<VerifyCheck>;
  isLlmJudge: boolean;
}
