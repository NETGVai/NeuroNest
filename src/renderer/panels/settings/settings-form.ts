/**
 * Settings form renderer.
 * Renders the settings schema into a form with vanilla DOM,
 * handling validation and change callbacks.
 */

import type { SettingField, SettingGroup, SettingKey, SettingsSchema, SettingsValues, SettingValue } from './types';

/** Callback invoked when a setting value changes. */
export type SettingChangeCallback = (key: SettingKey, value: SettingValue) => void;

/**
 * Settings form component.
 * Renders all setting groups and fields, providing an accessible form UI.
 */
export class SettingsForm {
  private container: HTMLElement | null = null;
  private formElement: HTMLFormElement | null = null;
  private onChangeCallback: SettingChangeCallback | null = null;
  private currentValues: SettingsValues = {};

  /** Mount the form into a container element. */
  mount(container: HTMLElement): void {
    this.container = container;

    this.formElement = document.createElement('form');
    this.formElement.className = 'settings-form';
    Object.assign(this.formElement.style, {
      padding: '16px',
      maxWidth: '640px',
      overflowY: 'auto',
      height: '100%',
    });
    this.formElement.addEventListener('submit', (e) => e.preventDefault());

    container.appendChild(this.formElement);
  }

  /** Unmount the form and clean up. */
  unmount(): void {
    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.formElement = null;
  }

  /** Render the settings schema with current values. */
  render(schema: SettingsSchema, values: SettingsValues): void {
    this.currentValues = { ...values };

    if (!this.formElement) return;
    this.formElement.innerHTML = '';

    for (const group of schema.groups) {
      const groupEl = this.renderGroup(group);
      this.formElement.appendChild(groupEl);
    }
  }

  /** Update a single field value without full re-render. */
  updateValue(key: SettingKey, value: SettingValue): void {
    this.currentValues[key] = value;
    const input = this.formElement?.querySelector(`[data-setting-key="${key}"]`) as HTMLInputElement | HTMLSelectElement | null;
    if (input) {
      if (input.type === 'checkbox') {
        (input as HTMLInputElement).checked = value as boolean;
      } else {
        input.value = String(value);
      }
    }
  }

  /** Set callback for when a setting changes. */
  setOnChange(callback: SettingChangeCallback): void {
    this.onChangeCallback = callback;
  }

  /** Render a group of settings. */
  private renderGroup(group: SettingGroup): HTMLElement {
    const section = document.createElement('section');
    section.className = 'settings-form__group';
    Object.assign(section.style, {
      marginBottom: '24px',
    });

    // Group title
    const title = document.createElement('h3');
    title.textContent = group.title;
    Object.assign(title.style, {
      margin: '0 0 4px 0',
      fontSize: '14px',
      fontWeight: '600',
      color: 'var(--text-primary, #e0e0e0)',
    });
    section.appendChild(title);

    // Group description
    if (group.description) {
      const desc = document.createElement('p');
      desc.textContent = group.description;
      Object.assign(desc.style, {
        margin: '0 0 12px 0',
        fontSize: '12px',
        color: 'var(--text-secondary, #999)',
      });
      section.appendChild(desc);
    }

    // Fields
    for (const field of group.fields) {
      const fieldEl = this.renderField(field);
      section.appendChild(fieldEl);
    }

    return section;
  }

  /** Render a single setting field. */
  private renderField(field: SettingField): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'settings-form__field';
    Object.assign(wrapper.style, {
      marginBottom: '16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
    });

    // Label
    const label = document.createElement('label');
    label.textContent = field.label;
    label.htmlFor = `setting-${field.key}`;
    Object.assign(label.style, {
      fontSize: '13px',
      fontWeight: '500',
      color: 'var(--text-primary, #e0e0e0)',
    });
    wrapper.appendChild(label);

    // Description
    if (field.description) {
      const desc = document.createElement('span');
      desc.textContent = field.description;
      Object.assign(desc.style, {
        fontSize: '11px',
        color: 'var(--text-secondary, #999)',
      });
      wrapper.appendChild(desc);
    }

    // Input element
    const input = this.createInputForField(field);
    wrapper.appendChild(input);

    return wrapper;
  }

  /** Create the appropriate input element for a setting field type. */
  private createInputForField(field: SettingField): HTMLElement {
    const currentValue = this.currentValues[field.key] ?? field.defaultValue;

    switch (field.type) {
      case 'boolean':
        return this.createCheckbox(field, currentValue as boolean);
      case 'select':
        return this.createSelect(field, currentValue as string);
      case 'number':
        return this.createNumberInput(field, currentValue as number);
      case 'text':
      default:
        return this.createTextInput(field, currentValue as string);
    }
  }

  /** Create a checkbox input for boolean settings. */
  private createCheckbox(field: SettingField, value: boolean): HTMLElement {
    const container = document.createElement('div');
    Object.assign(container.style, { display: 'flex', alignItems: 'center', gap: '8px' });

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = `setting-${field.key}`;
    input.checked = value;
    input.setAttribute('data-setting-key', field.key);
    input.setAttribute('aria-label', field.label);

    input.addEventListener('change', () => {
      this.currentValues[field.key] = input.checked;
      this.onChangeCallback?.(field.key, input.checked);
    });

    container.appendChild(input);
    return container;
  }

  /** Create a select dropdown for choice settings. */
  private createSelect(field: SettingField, value: string): HTMLElement {
    const select = document.createElement('select');
    select.id = `setting-${field.key}`;
    select.setAttribute('data-setting-key', field.key);
    select.setAttribute('aria-label', field.label);
    Object.assign(select.style, {
      padding: '6px 8px',
      borderRadius: '4px',
      border: '1px solid var(--border-color, #555)',
      backgroundColor: 'var(--input-bg, #2d2d2d)',
      color: 'var(--text-primary, #e0e0e0)',
      fontSize: '13px',
    });

    for (const option of field.options ?? []) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.value === value) opt.selected = true;
      select.appendChild(opt);
    }

    select.addEventListener('change', () => {
      this.currentValues[field.key] = select.value;
      this.onChangeCallback?.(field.key, select.value);
    });

    return select;
  }

  /** Create a number input for numeric settings. */
  private createNumberInput(field: SettingField, value: number): HTMLElement {
    const input = document.createElement('input');
    input.type = 'number';
    input.id = `setting-${field.key}`;
    input.value = String(value);
    input.setAttribute('data-setting-key', field.key);
    input.setAttribute('aria-label', field.label);
    if (field.min !== undefined) input.min = String(field.min);
    if (field.max !== undefined) input.max = String(field.max);
    Object.assign(input.style, {
      padding: '6px 8px',
      borderRadius: '4px',
      border: '1px solid var(--border-color, #555)',
      backgroundColor: 'var(--input-bg, #2d2d2d)',
      color: 'var(--text-primary, #e0e0e0)',
      fontSize: '13px',
      width: '120px',
    });

    input.addEventListener('change', () => {
      const numVal = Number(input.value);
      if (!Number.isNaN(numVal)) {
        this.currentValues[field.key] = numVal;
        this.onChangeCallback?.(field.key, numVal);
      }
    });

    return input;
  }

  /** Create a text input for string settings. */
  private createTextInput(field: SettingField, value: string): HTMLElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `setting-${field.key}`;
    input.value = value;
    input.setAttribute('data-setting-key', field.key);
    input.setAttribute('aria-label', field.label);
    if (field.placeholder) input.placeholder = field.placeholder;
    Object.assign(input.style, {
      padding: '6px 8px',
      borderRadius: '4px',
      border: '1px solid var(--border-color, #555)',
      backgroundColor: 'var(--input-bg, #2d2d2d)',
      color: 'var(--text-primary, #e0e0e0)',
      fontSize: '13px',
      width: '100%',
      maxWidth: '400px',
    });

    input.addEventListener('change', () => {
      this.currentValues[field.key] = input.value;
      this.onChangeCallback?.(field.key, input.value);
    });

    return input;
  }
}
