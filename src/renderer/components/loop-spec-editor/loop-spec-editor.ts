/**
 * LoopSpec Editor — Form-driven LoopSpec editing component.
 *
 * Renders a form interface for editing LoopSpec fields with:
 * - Inline Loop Doctor findings adjacent to relevant fields
 * - Real-time Zod validation on field change
 * - Soft verification (llmJudge) amber badge indicator
 *
 * Validates: Requirements 18.5
 */

import type { LoopSpec, DoctorFinding } from '../../../loop-engine/index';
import { validateLoopSpec } from '../../../loop-engine/schema/loop-spec';
import type {
  LoopSpecEditorConfig,
  LoopSpecEditorState,
  LoopSpecFieldId,
  MappedDoctorFinding,
  FieldValidationError,
} from './types';
import {
  createEditorState,
  updateFieldValue,
  setValidationErrors,
  setDoctorFindings,
  getFindingsForField,
  getErrorsForField,
  parseZodErrors,
  verifyChecksToFormEntries,
  isFormValid,
} from './loop-spec-editor-state';

// ─── LoopSpec Editor Component ──────────────────────────────────

export class LoopSpecEditor {
  private state: LoopSpecEditorState;
  private container: HTMLElement;
  private config: LoopSpecEditorConfig;
  private fieldElements: Map<LoopSpecFieldId, HTMLElement> = new Map();

  constructor(container: HTMLElement, config: LoopSpecEditorConfig) {
    this.container = container;
    this.config = config;
    this.state = createEditorState(config.initialSpec);
    this.render();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /** Get current editor state. */
  getState(): LoopSpecEditorState {
    return this.state;
  }

  /** Update the spec values externally (e.g., from IPC response). */
  setSpec(spec: LoopSpec): void {
    this.state = createEditorState(spec);
    this.render();
  }

  /** Update Loop Doctor findings and refresh field annotations. */
  setDoctorFindings(findings: DoctorFinding[]): void {
    this.state = setDoctorFindings(this.state, findings);
    this.renderFindingsAnnotations();
    this.config.onDoctorFindingsChange?.(this.state.doctorFindings);
  }

  /** Check if the form is valid and ready to save. */
  isValid(): boolean {
    return isFormValid(this.state);
  }

  /** Destroy the component and clean up event listeners. */
  destroy(): void {
    this.container.innerHTML = '';
    this.fieldElements.clear();
  }

  // ─── Private Render Methods ─────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';
    this.fieldElements.clear();
    this.container.className = 'loop-spec-editor';

    const form = document.createElement('form');
    form.setAttribute('aria-label', 'LoopSpec Editor');
    form.addEventListener('submit', (e) => e.preventDefault());

    // Section: Basic Info
    form.appendChild(this.createSection('Basic Information', [
      this.createTextField('name', 'Name', 'Loop name (1-128 chars)', 128),
      this.createTextField('goal', 'Goal', 'What this loop achieves (1-1024 chars)', 1024),
      this.createTextField('passAction', 'Pass Action', 'Action per pass (max 512 chars)', 512),
      this.createTextAreaField('feedback', 'Feedback Strategy', 'How to adjust between passes', 2048),
    ]));

    // Section: Verification
    form.appendChild(this.createSection('Verification', [
      this.createVerifyArrayField(),
    ]));

    // Section: Stop Conditions
    form.appendChild(this.createSection('Stop Conditions', [
      this.createNumberField('stop.maxPasses', 'Max Passes', 1, 50),
      this.createNumberField('stop.maxCostUsd', 'Max Cost (USD)', 0.01, 10000),
      this.createNumberField('stop.maxWallClockMin', 'Max Wall Clock (min)', 0.1, 1440),
      this.createNumberField('stop.noProgressPasses', 'No Progress Passes', 1, 50),
      this.createTextField('stop.approvalBoundaries', 'Approval Boundaries', 'Comma-separated pass numbers', 256),
    ]));

    // Section: Scope
    form.appendChild(this.createSection('Scope Constraints', [
      this.createTextAreaField('scope.allowedPaths', 'Allowed Paths', 'One glob pattern per line', 4096),
      this.createTextAreaField('scope.allowedTools', 'Allowed Tools', 'One tool ID per line', 2048),
      this.createSelectField('scope.securityPolicy', 'Security Policy', [
        { value: 'standard', label: 'Standard' },
        { value: 'strict', label: 'Strict' },
        { value: 'enterprise', label: 'Enterprise' },
      ]),
    ]));

    // Save button
    if (!this.config.readOnly) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.textContent = 'Save LoopSpec';
      saveBtn.className = 'loop-spec-editor__save-btn';
      saveBtn.setAttribute('aria-label', 'Save LoopSpec');
      saveBtn.addEventListener('click', () => this.handleSave());
      form.appendChild(saveBtn);
    }

    this.container.appendChild(form);
    this.renderFindingsAnnotations();
  }

  private createSection(title: string, fields: HTMLElement[]): HTMLElement {
    const section = document.createElement('fieldset');
    section.className = 'loop-spec-editor__section';

    const legend = document.createElement('legend');
    legend.textContent = title;
    section.appendChild(legend);

    for (const field of fields) {
      section.appendChild(field);
    }
    return section;
  }

  private createTextField(
    fieldId: LoopSpecFieldId,
    label: string,
    placeholder: string,
    maxLength: number,
  ): HTMLElement {
    const wrapper = this.createFieldWrapper(fieldId, label);
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.maxLength = maxLength;
    input.disabled = this.config.readOnly ?? false;
    input.setAttribute('aria-label', label);

    const currentValue = this.getFieldValue(fieldId);
    if (currentValue !== undefined) {
      input.value = Array.isArray(currentValue) ? currentValue.join(', ') : String(currentValue);
    }

    input.addEventListener('input', () => {
      this.handleFieldChange(fieldId, input.value);
    });

    wrapper.appendChild(input);
    return wrapper;
  }

  private createTextAreaField(
    fieldId: LoopSpecFieldId,
    label: string,
    placeholder: string,
    maxLength: number,
  ): HTMLElement {
    const wrapper = this.createFieldWrapper(fieldId, label);
    const textarea = document.createElement('textarea');
    textarea.placeholder = placeholder;
    textarea.maxLength = maxLength;
    textarea.rows = 3;
    textarea.disabled = this.config.readOnly ?? false;
    textarea.setAttribute('aria-label', label);

    const currentValue = this.getFieldValue(fieldId);
    if (currentValue !== undefined) {
      textarea.value = Array.isArray(currentValue) ? currentValue.join('\n') : String(currentValue);
    }

    textarea.addEventListener('input', () => {
      this.handleFieldChange(fieldId, textarea.value);
    });

    wrapper.appendChild(textarea);
    return wrapper;
  }

  private createNumberField(
    fieldId: LoopSpecFieldId,
    label: string,
    min: number,
    max: number,
  ): HTMLElement {
    const wrapper = this.createFieldWrapper(fieldId, label);
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = min < 1 ? '0.01' : '1';
    input.disabled = this.config.readOnly ?? false;
    input.setAttribute('aria-label', label);

    const currentValue = this.getFieldValue(fieldId);
    if (currentValue !== undefined) {
      input.value = String(currentValue);
    }

    input.addEventListener('input', () => {
      const numValue = parseFloat(input.value);
      this.handleFieldChange(fieldId, isNaN(numValue) ? undefined : numValue);
    });

    wrapper.appendChild(input);
    return wrapper;
  }

  private createSelectField(
    fieldId: LoopSpecFieldId,
    label: string,
    options: Array<{ value: string; label: string }>,
  ): HTMLElement {
    const wrapper = this.createFieldWrapper(fieldId, label);
    const select = document.createElement('select');
    select.disabled = this.config.readOnly ?? false;
    select.setAttribute('aria-label', label);

    for (const opt of options) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    }

    const currentValue = this.getFieldValue(fieldId);
    if (currentValue !== undefined) {
      select.value = String(currentValue);
    }

    select.addEventListener('change', () => {
      this.handleFieldChange(fieldId, select.value);
    });

    wrapper.appendChild(select);
    return wrapper;
  }

  private createVerifyArrayField(): HTMLElement {
    const wrapper = this.createFieldWrapper('verify', 'Verify Checks');
    const entries = verifyChecksToFormEntries(this.state.values.verify);

    const list = document.createElement('div');
    list.className = 'loop-spec-editor__verify-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Verification checks');

    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'loop-spec-editor__verify-item';
      item.setAttribute('role', 'listitem');

      const typeLabel = document.createElement('span');
      typeLabel.className = 'loop-spec-editor__verify-type';
      typeLabel.textContent = entry.type;
      item.appendChild(typeLabel);

      // Amber badge for llmJudge (soft verification)
      if (entry.isLlmJudge) {
        const badge = document.createElement('span');
        badge.className = 'loop-spec-editor__soft-verify-badge';
        badge.textContent = '⚠ soft verification';
        badge.setAttribute('aria-label', 'Soft verification: uses LLM judge (non-deterministic)');
        badge.title = 'Non-deterministic LLM judge evaluation';
        item.appendChild(badge);
      }

      const summary = document.createElement('span');
      summary.className = 'loop-spec-editor__verify-summary';
      summary.textContent = this.summarizeVerifyCheck(entry.data);
      item.appendChild(summary);

      list.appendChild(item);
    }

    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'loop-spec-editor__verify-empty';
      empty.textContent = 'No verification checks defined. At least one is required.';
      list.appendChild(empty);
    }

    wrapper.appendChild(list);
    return wrapper;
  }

  private createFieldWrapper(fieldId: LoopSpecFieldId, label: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'loop-spec-editor__field';
    wrapper.dataset.fieldId = fieldId;

    const labelEl = document.createElement('label');
    labelEl.textContent = label;
    labelEl.className = 'loop-spec-editor__label';
    wrapper.appendChild(labelEl);

    // Placeholder for findings/errors annotations
    const annotations = document.createElement('div');
    annotations.className = 'loop-spec-editor__annotations';
    annotations.dataset.annotationsFor = fieldId;
    wrapper.appendChild(annotations);

    this.fieldElements.set(fieldId, wrapper);
    return wrapper;
  }

  // ─── Findings & Error Annotations ──────────────────────────────

  private renderFindingsAnnotations(): void {
    for (const [fieldId, element] of this.fieldElements) {
      const annotationsEl = element.querySelector(
        `[data-annotations-for="${fieldId}"]`,
      );
      if (!annotationsEl) continue;

      annotationsEl.innerHTML = '';

      // Render doctor findings
      const findings = getFindingsForField(this.state, fieldId);
      for (const mapped of findings) {
        const findingEl = document.createElement('div');
        findingEl.className = `loop-spec-editor__finding loop-spec-editor__finding--${mapped.finding.severity}`;
        findingEl.setAttribute('role', 'alert');

        const icon = mapped.finding.severity === 'error' ? '🔴' : '⚠️';
        findingEl.textContent = `${icon} ${mapped.finding.message}`;
        annotationsEl.appendChild(findingEl);
      }

      // Render validation errors
      const errors = getErrorsForField(this.state, fieldId);
      for (const error of errors) {
        const errorEl = document.createElement('div');
        errorEl.className = 'loop-spec-editor__validation-error';
        errorEl.setAttribute('role', 'alert');
        errorEl.textContent = `❌ ${error.message}`;
        annotationsEl.appendChild(errorEl);
      }
    }
  }

  // ─── Event Handlers ─────────────────────────────────────────────

  private handleFieldChange(fieldId: LoopSpecFieldId, value: unknown): void {
    this.state = updateFieldValue(this.state, fieldId, value);
    this.validateOnChange();
  }

  private validateOnChange(): void {
    this.state = { ...this.state, isValidating: true };

    const result = validateLoopSpec(this.state.values);
    const errors = result.success ? [] : parseZodErrors(
      result.error ? { issues: result.error.issues.map(i => ({ path: i.path.map(String), message: i.message })) } : undefined
    );

    this.state = setValidationErrors(this.state, errors);
    this.renderFindingsAnnotations();
    this.config.onValidationChange?.(this.state.validationErrors);
  }

  private handleSave(): void {
    this.validateOnChange();

    if (!isFormValid(this.state)) return;

    const result = validateLoopSpec(this.state.values);
    if (result.success && result.data) {
      this.state = { ...this.state, isDirty: false };
      this.config.onSave?.(result.data);
    }
  }

  // ─── Utility ────────────────────────────────────────────────────

  private getFieldValue(fieldId: LoopSpecFieldId): unknown {
    if (fieldId.startsWith('stop.')) {
      const subField = fieldId.replace('stop.', '');
      return this.state.values.stop
        ? (this.state.values.stop as unknown as Record<string, unknown>)[subField]
        : undefined;
    }
    if (fieldId.startsWith('scope.')) {
      const subField = fieldId.replace('scope.', '');
      return this.state.values.scope
        ? (this.state.values.scope as unknown as Record<string, unknown>)[subField]
        : undefined;
    }
    return (this.state.values as Record<string, unknown>)[fieldId];
  }

  private summarizeVerifyCheck(data: Partial<import('../../../loop-engine/index').VerifyCheck>): string {
    switch (data.type) {
      case 'command':
        return `Command: ${(data as { command?: string }).command ?? '(undefined)'}`;
      case 'metric':
        return `Metric: ${(data as { metricName?: string }).metricName ?? '?'} ${(data as { comparator?: string }).comparator ?? ''} ${(data as { target?: number }).target ?? ''}`;
      case 'file':
        return `File: ${(data as { filePath?: string }).filePath ?? '?'} (${(data as { assertion?: string }).assertion ?? ''})`;
      case 'llmJudge':
        return `LLM Judge: threshold ${(data as { threshold?: number }).threshold ?? '?'}`;
      default:
        return '(unknown type)';
    }
  }
}
