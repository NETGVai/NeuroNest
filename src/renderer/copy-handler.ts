/**
 * CopyHandler — event-delegated copy button handling for code blocks.
 *
 * Uses a single click listener on the chat area container to handle
 * all `.code-copy-btn` clicks via event delegation.
 */

const COPY_ICON = '📋';
const SUCCESS_ICON = '✅';
const REVERT_DELAY_MS = 2000;

/**
 * Initialize copy button handling via event delegation on the given chat area element.
 * Listens for clicks on `.code-copy-btn` elements within the container.
 */
export function initCopyHandler(chatArea: HTMLElement): void {
  chatArea.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as HTMLElement;

    // Walk up from the click target to find a .code-copy-btn
    const btn = target.closest('.code-copy-btn') as HTMLElement | null;
    if (!btn) return;

    // Find the parent .code-block-wrapper, then locate the <pre> inside it
    const wrapper = btn.closest('.code-block-wrapper');
    if (!wrapper) return;

    const pre = wrapper.querySelector('pre');
    if (!pre) return;

    const codeText = pre.textContent || '';
    const iconSpan = btn.querySelector('.copy-icon') as HTMLElement | null;

    navigator.clipboard.writeText(codeText).then(
      () => {
        // Success: swap icon to ✅ for 2 seconds, then revert
        if (iconSpan) {
          iconSpan.textContent = SUCCESS_ICON;
          setTimeout(() => {
            iconSpan.textContent = COPY_ICON;
          }, REVERT_DELAY_MS);
        }
      },
      () => {
        // Failure: revert immediately (no success indicator)
        if (iconSpan) {
          iconSpan.textContent = COPY_ICON;
        }
      },
    );
  });
}
