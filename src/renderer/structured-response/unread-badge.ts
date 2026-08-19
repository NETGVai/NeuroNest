/**
 * Unread Badge Component
 *
 * A floating indicator showing the exact unread node count and a
 * keyboard-operable follow-latest button. Displays only when the reader
 * is away from the bottom and new content has arrived.
 *
 * The badge is accessible: it has a descriptive aria-label, acts as a button,
 * and is keyboard-activatable with Enter/Space. It does not derive unread
 * from mounted rows — only from canonical projection counts.
 *
 * Requirements: 19.2–19.3, 21.11
 */

import type { UnreadBadgeState, ReaderOwnershipController } from './reader-ownership-controller';

// ─── CSS Classes ────────────────────────────────────────────────

export const UNREAD_BADGE_CSS_CLASS = 'nn-unread-badge';
export const UNREAD_BADGE_COUNT_CSS_CLASS = 'nn-unread-badge__count';
export const UNREAD_BADGE_LABEL_CSS_CLASS = 'nn-unread-badge__label';

// ─── Component ──────────────────────────────────────────────────

/**
 * Handle returned by createUnreadBadge for lifecycle management.
 */
export interface UnreadBadgeHandle {
  /** The root DOM element of the badge. */
  element: HTMLElement;
  /** Update the badge state (called by ReaderOwnershipController listener). */
  update(state: UnreadBadgeState): void;
  /** Dispose the badge and clean up. */
  dispose(): void;
}

/**
 * Options for creating the unread badge.
 */
export interface UnreadBadgeOptions {
  /** Callback invoked when the user activates the follow-latest action. */
  onFollowLatest: () => void;
}

/**
 * Create an unread badge element that can be positioned within the
 * structured chat shell (typically floating above the composer slot).
 */
export function createUnreadBadge(options: UnreadBadgeOptions): UnreadBadgeHandle {
  const { onFollowLatest } = options;

  // Root badge element: a keyboard-operable button
  const badge = document.createElement('button');
  badge.className = UNREAD_BADGE_CSS_CLASS;
  badge.setAttribute('type', 'button');
  badge.setAttribute('aria-live', 'polite');
  badge.setAttribute('aria-atomic', 'true');
  badge.style.display = 'none'; // Hidden by default
  badge.style.position = 'sticky';
  badge.style.bottom = '0';
  badge.style.alignSelf = 'center';
  badge.style.zIndex = '10';
  badge.style.cursor = 'pointer';

  // Count indicator
  const countSpan = document.createElement('span');
  countSpan.className = UNREAD_BADGE_COUNT_CSS_CLASS;
  countSpan.textContent = '0';
  badge.appendChild(countSpan);

  // Label
  const labelSpan = document.createElement('span');
  labelSpan.className = UNREAD_BADGE_LABEL_CSS_CLASS;
  labelSpan.textContent = ' new — jump to latest';
  badge.appendChild(labelSpan);

  // Click/keyboard activation handler
  const handleActivate = (e: Event) => {
    e.preventDefault();
    onFollowLatest();
  };

  badge.addEventListener('click', handleActivate);
  badge.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      handleActivate(e);
    }
  });

  let disposed = false;

  const handle: UnreadBadgeHandle = {
    element: badge,

    update(state: UnreadBadgeState): void {
      if (disposed) return;

      if (!state.visible) {
        badge.style.display = 'none';
        badge.setAttribute('aria-label', '');
        return;
      }

      badge.style.display = '';
      countSpan.textContent = String(state.unreadCount);
      labelSpan.textContent = state.unreadCount === 1
        ? ' new message — jump to latest'
        : ' new messages — jump to latest';
      badge.setAttribute('aria-label', state.ariaLabel);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      badge.removeEventListener('click', handleActivate);
      badge.remove();
    },
  };

  return handle;
}

/**
 * Wire an unread badge to a ReaderOwnershipController.
 * Returns a dispose function for cleanup.
 */
export function wireUnreadBadge(
  controller: ReaderOwnershipController,
  badge: UnreadBadgeHandle,
): () => void {
  const listener = (state: UnreadBadgeState) => {
    badge.update(state);
  };

  controller.addListener(listener);

  // Set initial state
  badge.update(controller.getUnreadBadgeState());

  return () => {
    controller.removeListener(listener);
  };
}
