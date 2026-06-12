/**
 * Reusable button component.
 * Vanilla DOM button with configurable variants, sizes, and accessibility support.
 */

/** Button variant for visual styling. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Button size. */
export type ButtonSize = 'small' | 'medium' | 'large';

/** Configuration for creating a button. */
export interface ButtonConfig {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  icon?: string;
  ariaLabel?: string;
  className?: string;
  onClick?: (event: MouseEvent) => void;
}

/** Style map for button variants. */
const VARIANT_STYLES: Record<ButtonVariant, Record<string, string>> = {
  primary: {
    backgroundColor: 'var(--button-primary-bg, #0078d4)',
    color: 'var(--button-primary-fg, #ffffff)',
    border: 'none',
  },
  secondary: {
    backgroundColor: 'var(--button-secondary-bg, #3c3c3c)',
    color: 'var(--button-secondary-fg, #e0e0e0)',
    border: '1px solid var(--border-color, #555)',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--text-primary, #e0e0e0)',
    border: 'none',
  },
  danger: {
    backgroundColor: 'var(--button-danger-bg, #d32f2f)',
    color: 'var(--button-danger-fg, #ffffff)',
    border: 'none',
  },
};

/** Padding for button sizes. */
const SIZE_STYLES: Record<ButtonSize, Record<string, string>> = {
  small: { padding: '4px 8px', fontSize: '12px' },
  medium: { padding: '6px 12px', fontSize: '13px' },
  large: { padding: '8px 16px', fontSize: '14px' },
};

/**
 * Creates a button DOM element with the given configuration.
 */
export function createButton(config: ButtonConfig): HTMLButtonElement {
  const {
    label,
    variant = 'secondary',
    size = 'medium',
    disabled = false,
    icon,
    ariaLabel,
    className,
    onClick,
  } = config;

  const button = document.createElement('button');
  button.type = 'button';
  button.disabled = disabled;
  if (className) button.className = className;
  button.setAttribute('aria-label', ariaLabel ?? label);

  // Apply base styles
  Object.assign(button.style, {
    borderRadius: '4px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: 'inherit',
    lineHeight: '1.4',
    transition: 'opacity 0.15s',
    opacity: disabled ? '0.5' : '1',
    ...VARIANT_STYLES[variant],
    ...SIZE_STYLES[size],
  });

  // Icon
  if (icon) {
    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    iconSpan.setAttribute('aria-hidden', 'true');
    button.appendChild(iconSpan);
  }

  // Label text
  const textSpan = document.createElement('span');
  textSpan.textContent = label;
  button.appendChild(textSpan);

  // Click handler
  if (onClick) {
    button.addEventListener('click', onClick);
  }

  return button;
}

/**
 * Updates an existing button's disabled state.
 */
export function setButtonDisabled(button: HTMLButtonElement, disabled: boolean): void {
  button.disabled = disabled;
  button.style.opacity = disabled ? '0.5' : '1';
  button.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

/**
 * Updates an existing button's label text.
 */
export function setButtonLabel(button: HTMLButtonElement, label: string): void {
  const textSpan = button.querySelector('span:last-child');
  if (textSpan) {
    textSpan.textContent = label;
  }
}
