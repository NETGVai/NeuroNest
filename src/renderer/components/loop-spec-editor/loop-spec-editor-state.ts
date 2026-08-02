/**
 * Pure state management logic for the LoopSpec Editor.
 * All functions are side-effect-free.
 */

import type { LoopSpec, DoctorFinding, VerifyCheck } from '../../../loop-engine/index';
import type {
  LoopSpecEditorState,
  ValidationError,
  MappedDoctorFinding,
  VerifyFormEntry,
} from './types';

// ─── Create Initial Editor State ────────────────────────────────

export function createEditorState(spec: LoopSpec | null): LoopSpecEditorState {
  return {
    values: spec ?? ({} as Partial<LoopSpec>),
    validationErrors: [],
    doctorFindings: [],
    isDirty: false,
    isValidating: false,
  };
}

// ─── Update Field Value ─────────────────────────────────────────

export function updateFieldValue(
  state: LoopSpecEditorState,
  fieldPath: string,
  value: unknown,
): LoopSpecEditorState {
  const parts = fieldPath.split('.');

  if (parts.length === 1) {
    return {
      ...state,
      values: { ...state.values, [parts[0]]: value },
      isDirty: true,
    };
  }

  if (parts.length === 2) {
    const [parent, child] = parts;
    const parentObj = (state.values as Record<string, unknown>)[parent];
    return {
      ...state,
      values: {
        ...state.values,
        [parent]: { ...(parentObj as object), [child]: value },
      },
      isDirty: true,
    };
  }

  return { ...state, isDirty: true };
}

// ─── Validation Errors ──────────────────────────────────────────

export function setValidationErrors(
  state: LoopSpecEditorState,
  errors: ValidationError[],
): LoopSpecEditorState {
  return {
    ...state,
    validationErrors: errors,
    isValidating: false,
  };
}

// ─── Doctor Findings ────────────────────────────────────────────

export function setDoctorFindings(
  state: LoopSpecEditorState,
  findings: DoctorFinding[],
): LoopSpecEditorState {
  return {
    ...state,
    doctorFindings: mapDoctorFindings(findings),
  };
}

export function getFindingsForField(
  state: LoopSpecEditorState,
  field: string,
): MappedDoctorFinding[] {
  return state.doctorFindings.filter((f) => f.field === field);
}

export function getErrorsForField(
  state: LoopSpecEditorState,
  field: string,
): ValidationError[] {
  return state.validationErrors.filter((e) => e.field === field);
}

// ─── Zod Error Parsing ──────────────────────────────────────────

export function parseZodErrors(
  zodError: { issues: Array<{ path: (string | number)[]; message: string }> } | undefined,
): ValidationError[] {
  if (!zodError) return [];

  return zodError.issues.map((issue) => {
    // Build field path: use only strings up until the first numeric index.
    // e.g. ['verify', 0, 'type'] → 'verify'
    // e.g. ['stop', 'maxPasses'] → 'stop.maxPasses'
    const parts: string[] = [];
    for (const segment of issue.path) {
      if (typeof segment === 'number') break;
      parts.push(segment);
    }
    const field = parts.length === 0 ? 'unknown' : parts.join('.');
    return { field, message: issue.message };
  });
}

// ─── Verify Checks to Form Entries ──────────────────────────────

export function verifyChecksToFormEntries(
  checks: VerifyCheck[] | undefined,
): VerifyFormEntry[] {
  if (!checks) return [];

  return checks.map((check, index) => ({
    ...check,
    id: `verify-${index}`,
    type: check.type,
    isLlmJudge: check.type === 'llmJudge',
  }));
}

// ─── Form Validation ────────────────────────────────────────────

export function isFormValid(state: LoopSpecEditorState): boolean {
  return state.validationErrors.length === 0 && !state.isValidating;
}

// ─── Doctor Field Mapping ───────────────────────────────────────

const KNOWN_FIELDS = new Set([
  'name',
  'useWhen',
  'goal',
  'passAction',
  'verify',
  'feedback',
  'stop.maxPasses',
  'stop.maxCostUsd',
  'stop.maxWallClockMin',
  'stop.noProgressPasses',
  'stop.approvalBoundaries',
  'scope.allowedPaths',
  'scope.allowedTools',
  'scope.securityPolicy',
]);

export function mapDoctorFieldToFormField(doctorField: string): string {
  if (KNOWN_FIELDS.has(doctorField)) return doctorField;
  return 'verify'; // fallback
}

export function mapDoctorFindings(findings: DoctorFinding[]): MappedDoctorFinding[] {
  return findings.map((finding) => ({
    field: mapDoctorFieldToFormField(finding.field),
    finding,
  }));
}
