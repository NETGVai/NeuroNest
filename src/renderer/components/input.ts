/**
 * Reusable input component.
 * Vanilla DOM input with validation, label, and accessibility support.
 */

/** Input type options. */
export type InputType = 'text' | 'number' | 'password' | 'email' | 'search';

/** Configuration for creating an input field. */
export interface InputConfig {
  id?: string;
  type?: InputType;
  label?: string;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  required?: boolean;
  ariaLabel?: string;
  className?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
}

/**
 * Creates an input field wrapper with optional label.
 * Returns the container element with the input accessible via querySelector.
 */
export function createInput(config: InputConfig): HTMLElement {
  const {
    id,
    type = 'text',
    label,
    placeholder,
    value = '',
    disabled = false,
    required = false,
    ariaLabel,
    className,
    maxLength,
    min,
    max,
    onChange,
    onSubmit,
  } = config;

  const container = document.createElement('div');
  container.className = className ?? 'input-field';
  Object.assign(container.style, {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  });

  const inputId = id ?? `input-${Math.random().toString(36).slice(2, 9)}`;

  // Label
  if (label) {
    const labelEl = document.createElement('label');
    labelEl.htmlFor = inputId;
    labelEl.textContent = label;
    Object.assign(labelEl.style, {
      fontSize: '13px',
      fontWeight: '500',
      color: 'var(--text-primary, #e0e0e0)',
    });
    container.appendChild(labelEl);
  }

  // Input element
  const input = document.createElement('input');
  input.id = inputId;
  input.type = type;
  input.value = value;
  input.disabled = disabled;
  input.required = required;
  if (placeholder) input.placeholder = placeholder;
  if (ariaLabel) input.setAttribute('aria-label', ariaLabel);
  if (maxLength !== undefined) input.maxLength = maxLength;
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);

  Object.assign(input.style, {
    padding: '6px 8px',
    borderRadius: '4px',
    border: '1px solid var(--border-color, #555)',
    backgroundColor: 'var(--input-bg, #2d2d2d)',
    color: 'var(--text-primary, #e0e0e0)',
    fontSize: '13px',
    fontFamily: 'inherit',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  });

  // Focus styling
  input.addEventListener('focus', () => {
    input.style.borderColor = 'var(--focus-border, #0078d4)';
  });
  input.addEventListener('blur', () => {
    input.style.borderColor = 'var(--border-color, #555)';
  });

  // Change handler
  if (onChange) {
    input.addEventListener('input', () => {
      onChange(input.value);
    });
  }

  // Submit handler (Enter key)
  if (onSubmit) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onSubmit(input.value);
      }
    });
  }

  container.appendChild(input);

  return container;
}

/**
 * Gets the input element from a container created by createInput.
 */
export function getInputElement(container: HTMLElement): HTMLInputElement | null {
  return container.querySelector('input');
}

/**
 * Sets the value of an input field.
 */
export function setInputValue(container: HTMLElement, value: string): void {
  const input = getInputElement(container);
  if (input) input.value = value;
}

/**
 * Gets the current value of an input field.
 */
export function getInputValue(container: HTMLElement): string {
  return getInputElement(container)?.value ?? '';
}

/**
 * Sets the disabled state of an input field.
 */
export function setInputDisabled(container: HTMLElement, disabled: boolean): void {
  const input = getInputElement(container);
  if (input) input.disabled = disabled;
}
