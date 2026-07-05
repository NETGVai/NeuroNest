/**
 * LoopSpec Editor State Management.
 *
 * Pure functions for managing editor state, validation, and
 * mapping Loop Doctor findings to form fields.
 *
 * Validates: Requirements 18.5
 */

import type { LoopSpec, DoctorFinding } from '../../../loop-engine/index';
import type {
  LoopSpecEditorState,
  LoopSpecFieldId,
  FieldValidationError,
  MappedDoctorFinding,
  VerifyCheckFormEntry,
} from './types';

// ─── State Initialization ───────────────────────────────────────

/** Create the initial editor state from a LoopSpec or empty form. */
export function createEditorState(spec: LoopSpec | null): LoopSpecEditorState {
  return {
    values: spec ? { ...spec } : {},
    validationErrors: [],
    doctorFindings: [],
    isDirty: false,
    isValidating: false,
  };
}

// ─── Field Mapping ──────────────────────────────────────────────

/**
 * Map a DoctorFinding.field string to the closest LoopSpecFieldId.
 *
 * Doctor findings reference fields like 'verify', 'stop.maxPasses',
 * 'stop.approvalBoundaries'. This maps them to form field identifiers.
 */
export function mapDoctorFieldToFormField(doctorField: string): LoopSpecFieldId {
  const mapping: Record<string, LoopSpecFieldId> = {
    verify: 'verify',
    'stop.maxPasses': 'stop.maxPasses',
    'stop.maxCostUsd': 'stop.maxCostUsd',
    'stop.maxWallClockMin': 'stop.maxWallClockMin',
    'stop.noProgressPasses': 'stop.noProgressPasses',
    'stop.approvalBoundaries': 'stop.approvalBoundaries',
    'scope.allowedPaths': 'scope.allowedPaths',
    'scope.allowedTools': 'scope.allowedTools',
    'scope.securityPolicy': 'scope.securityPolicy',
    name: 'name',
    goal: 'goal',
    passAction: 'passAction',
    feedback: 'feedback',
  };

  return mapping[doctorField] ?? 'verify';
}

/**
 * Map an array of DoctorFinding to MappedDoctorFinding with field associations.
 */
export function mapDoctorFindings(findings: DoctorFinding[]): MappedDoctorFinding[] {
  return findings.map((finding) => ({
    field: mapDoctorFieldToFormField(finding.field),
    finding,
  }));
}

// ─── State Updates ──────────────────────────────────────────────

/** Update a field value in the editor state and mark dirty. */
export function updateFieldValue(
  state: LoopSpecEditorState,
  field: LoopSpecFieldId,
  value: unknown,
): LoopSpecEditorState {
  const newValues = { ...state.values };

  if (field.startsWith('stop.')) {
    const stopField = field.replace('stop.', '') as keyof LoopSpec['stop'];
    newValues.stop = { ...newValues.stop, [stopField]: value } as LoopSpec['stop'];
  } else if (field.startsWith('scope.')) {
    const scopeField = field.replace('scope.', '') as keyof LoopSpec['scope'];
    newValues.scope = { ...newValues.scope, [scopeField]: value } as LoopSpec['scope'];
  } else {
    (newValues as Record<string, unknown>)[field] = value;
  }

  return {
    ...state,
    values: newValues,
    isDirty: true,
  };
}

/** Set validation errors on the state. */
export function setValidationErrors(
  state: LoopSpecEditorState,
  errors: FieldValidationError[],
): LoopSpecEditorState {
  return {
    ...state,
    validationErrors: errors,
    isValidating: false,
  };
}

/** Set doctor findings on the state. */
export function setDoctorFindings(
  state: LoopSpecEditorState,
  findings: DoctorFinding[],
): LoopSpecEditorState {
  return {
    ...state,
    doctorFindings: mapDoctorFindings(findings),
  };
}

/** Get doctor findings for a specific field. */
export function getFindingsForField(
  state: LoopSpecEditorState,
  field: LoopSpecFieldId,
): MappedDoctorFinding[] {
  return state.doctorFindings.filter((f) => f.field === field);
}

/** Get validation errors for a specific field. */
export function getErrorsForField(
  state: LoopSpecEditorState,
  field: LoopSpecFieldId,
): FieldValidationError[] {
  return state.validationErrors.filter((e) => e.field === field);
}

// ─── Validation ─────────────────────────────────────────────────

/**
 * Parse Zod validation errors into field-specific FieldValidationError items.
 *
 * Maps Zod issue paths to LoopSpecFieldId values.
 */
export function parseZodErrors(
  zodError: { issues: Array<{ path: (string | number)[]; message: string }> } | undefined,
): FieldValidationError[] {
  if (!zodError || !zodError.issues) return [];

  return zodError.issues.map((issue) => {
    const pathStr = issue.path.join('.');
    const field = mapZodPathToField(pathStr);
    return { field, message: issue.message };
  });
}

/** Map a Zod issue path string to a LoopSpecFieldId. */
function mapZodPathToField(path: string): LoopSpecFieldId {
  // Direct top-level field matches
  const directFields: LoopSpecFieldId[] = ['name', 'goal', 'passAction', 'feedback', 'verify'];
  for (const f of directFields) {
    if (path === f || path.startsWith(`${f}.`)) return f;
  }

  // Stop fields
  if (path.startsWith('stop.')) {
    const subField = path.replace('stop.', '').split('.')[0];
    const stopFieldId = `stop.${subField}` as LoopSpecFieldId;
    const validStopFields: LoopSpecFieldId[] = [
      'stop.maxPasses',
      'stop.maxCostUsd',
      'stop.maxWallClockMin',
      'stop.noProgressPasses',
      'stop.approvalBoundaries',
    ];
    if (validStopFields.includes(stopFieldId)) return stopFieldId;
    return 'stop.maxPasses'; // fallback
  }

  // Scope fields
  if (path.startsWith('scope.')) {
    const subField = path.replace('scope.', '').split('.')[0];
    const scopeFieldId = `scope.${subField}` as LoopSpecFieldId;
    const validScopeFields: LoopSpecFieldId[] = [
      'scope.allowedPaths',
      'scope.allowedTools',
      'scope.securityPolicy',
    ];
    if (validScopeFields.includes(scopeFieldId)) return scopeFieldId;
    return 'scope.allowedPaths'; // fallback
  }

  return 'name'; // fallback for unmapped paths
}

// ─── Verify Check Helpers ───────────────────────────────────────

/** Convert verify array entries to form entries with IDs. */
export function verifyChecksToFormEntries(
  checks: LoopSpec['verify'] | undefined,
): VerifyCheckFormEntry[] {
  if (!checks) return [];

  return checks.map((check, index) => ({
    id: `verify-${index}`,
    type: check.type,
    data: check,
    isLlmJudge: check.type === 'llmJudge',
  }));
}

/** Check if a form state represents a valid LoopSpec (no errors, all required fields). */
export function isFormValid(state: LoopSpecEditorState): boolean {
  return state.validationErrors.length === 0 && !state.isValidating;
}
