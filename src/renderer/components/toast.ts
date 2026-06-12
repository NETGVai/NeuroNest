/**
 * Notification toast component.
 * Provides a lightweight, accessible notification system using vanilla DOM.
 * Toasts appear in a fixed container and auto-dismiss after a configurable duration.
 */

/** Toast notification level for styling. */
export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** Configuration for showing a toast. */
export interface ToastConfig {
  message: string;
  level?: ToastLevel;
  /** Duration in ms before auto-dismiss. 0 for persistent. */
  duration?: number;
  /** Optional action button. */
  action?: { label: string; onClick: () => void };
}

/** Style map for toast levels. */
const LEVEL_STYLES: Record<ToastLevel, { bg: string; border: string; icon: string }> = {
  info: {
    bg: 'var(--toast-info-bg, #1e3a5f)',
    border: 'var(--toast-info-border, #0078d4)',
    icon: 'ℹ️',
  },
  success: {
    bg: 'var(--toast-success-bg, #1e3f1e)',
    border: 'var(--toast-success-border, #4caf50)',
    icon: '✓',
  },
  warning: {
    bg: 'var(--toast-warning-bg, #3f3a1e)',
    border: 'var(--toast-warning-border, #ff9800)',
    icon: '⚠',
  },
  error: {
    bg: 'var(--toast-error-bg, #3f1e1e)',
    border: 'var(--toast-error-border, #f44336)',
    icon: '✕',
  },
};

/** Default auto-dismiss duration in ms. */
const DEFAULT_DURATION = 4000;

/** Maximum number of visible toasts at once. */
const MAX_VISIBLE_TOASTS = 5;

/** Container element for all toasts. Created lazily. */
let toastContainer: HTMLElement | null = null;

/** Queue of active toast elements for cleanup. */
const activeToasts: HTMLElement[] = [];

/**
 * Ensure the toast container exists in the DOM.
 */
function ensureContainer(): HTMLElement {
  if (toastContainer && document.body.contains(toastContainer)) {
    return toastContainer;
  }

  toastContainer = document.createElement('div');
  toastContainer.className = 'toast-container';
  toastContainer.setAttribute('role', 'status');
  toastContainer.setAttribute('aria-live', 'polite');
  toastContainer.setAttribute('aria-atomic', 'false');
  Object.assign(toastContainer.style, {
    position: 'fixed',
    bottom: '16px',
    right: '16px',
    zIndex: '10000',
    display: 'flex',
    flexDirection: 'column-reverse',
    gap: '8px',
    maxWidth: '360px',
    pointerEvents: 'none',
  });
  document.body.appendChild(toastContainer);

  return toastContainer;
}

/**
 * Show a toast notification.
 * Returns a dismiss function to programmatically remove the toast.
 */
export function showToast(config: ToastConfig): () => void {
  const { message, level = 'info', duration = DEFAULT_DURATION, action } = config;
  const container = ensureContainer();
  const styles = LEVEL_STYLES[level];

  // Remove oldest toast if at limit
  if (activeToasts.length >= MAX_VISIBLE_TOASTS) {
    const oldest = activeToasts.shift();
    oldest?.remove();
  }

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast--${level}`;
  toast.setAttribute('role', 'alert');
  Object.assign(toast.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 14px',
    borderRadius: '6px',
    backgroundColor: styles.bg,
    borderLeft: `3px solid ${styles.border}`,
    color: 'var(--text-primary, #e0e0e0)',
    fontSize: '13px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    pointerEvents: 'auto',
    opacity: '0',
    transform: 'translateY(8px)',
    transition: 'opacity 0.2s, transform 0.2s',
  });

  // Icon
  const icon = document.createElement('span');
  icon.textContent = styles.icon;
  icon.setAttribute('aria-hidden', 'true');
  Object.assign(icon.style, { fontSize: '14px', flexShrink: '0' });
  toast.appendChild(icon);

  // Message
  const msg = document.createElement('span');
  msg.textContent = message;
  Object.assign(msg.style, { flex: '1', lineHeight: '1.4' });
  toast.appendChild(msg);

  // Action button (if provided)
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.setAttribute('aria-label', action.label);
    Object.assign(btn.style, {
      background: 'none',
      border: 'none',
      color: styles.border,
      cursor: 'pointer',
      fontSize: '12px',
      fontWeight: '600',
      padding: '2px 4px',
      whiteSpace: 'nowrap',
    });
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    toast.appendChild(btn);
  }

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Dismiss notification');
  Object.assign(closeBtn.style, {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary, #999)',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: '1',
    padding: '0 2px',
    flexShrink: '0',
  });
  closeBtn.addEventListener('click', dismiss);
  toast.appendChild(closeBtn);

  // Add to DOM
  container.appendChild(toast);
  activeToasts.push(toast);

  // Animate in
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  // Auto-dismiss timer
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  if (duration > 0) {
    timeoutId = setTimeout(dismiss, duration);
  }

  /** Dismiss this toast. */
  function dismiss(): void {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';

    setTimeout(() => {
      toast.remove();
      const idx = activeToasts.indexOf(toast);
      if (idx !== -1) activeToasts.splice(idx, 1);
    }, 200);
  }

  return dismiss;
}

/**
 * Dismiss all active toasts.
 */
export function dismissAllToasts(): void {
  for (const toast of [...activeToasts]) {
    toast.remove();
  }
  activeToasts.length = 0;
}
