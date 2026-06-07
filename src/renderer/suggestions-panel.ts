/**
 * SuggestionsPanel — displays 2–5 follow-up suggestion cards after task completion.
 *
 * Listens to the `suggestions-ready` channel for incoming suggestions.
 * Each suggestion is clickable, pre-filling the user's input field with the action text.
 * Diagnostic suggestions are styled distinctly when the task errored.
 *
 * Requirements: 8.4, 8.6, 8.7
 */

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

interface Suggestion {
  id: string;
  text: string;
  action: string;
  category: 'domain' | 'diagnostic';
}

// ─── SuggestionsPanel ───────────────────────────────────────────

export class SuggestionsPanel {
  private container: HTMLElement;
  private cardsContainer: HTMLElement | null = null;
  private suggestionsHandler: ((...args: unknown[]) => void) | null = null;
  private onActionSelect: ((action: string) => void) | null = null;

  constructor(container: HTMLElement, onActionSelect?: (action: string) => void) {
    this.container = container;
    this.onActionSelect = onActionSelect ?? null;
  }

  /** Render the panel shell and start listening for suggestions. */
  render(): void {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    header.innerHTML = '<h4 style="margin:0;font-size:13px;color:var(--text-secondary);">💡 Suggestions</h4>';
    this.container.appendChild(header);

    // Cards container
    this.cardsContainer = document.createElement('div');
    this.cardsContainer.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
    this.container.appendChild(this.cardsContainer);

    this.showEmptyState();

    // Listen for suggestions from main process
    this.cleanupListener();
    this.suggestionsHandler = (...args: unknown[]) => {
      const suggestions = args[0] as Suggestion[];
      if (Array.isArray(suggestions) && suggestions.length > 0) {
        this.renderSuggestions(suggestions);
      }
    };
    eapi().on('suggestions-ready', this.suggestionsHandler);
  }

  /** Manually set suggestions (for testing or direct invocation). */
  setSuggestions(suggestions: Suggestion[]): void {
    this.renderSuggestions(suggestions);
  }

  // ─── Rendering ──────────────────────────────────────────────

  private renderSuggestions(suggestions: Suggestion[]): void {
    if (!this.cardsContainer) return;
    this.cardsContainer.innerHTML = '';

    for (const suggestion of suggestions) {
      const card = this.createSuggestionCard(suggestion);
      this.cardsContainer.appendChild(card);
    }
  }

  private createSuggestionCard(suggestion: Suggestion): HTMLElement {
    const isDiagnostic = suggestion.category === 'diagnostic';

    const card = document.createElement('button');
    card.type = 'button';
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Suggestion: ${suggestion.text}`);
    card.style.cssText = [
      'display:block',
      'width:100%',
      'text-align:left',
      'padding:10px 14px',
      'border-radius:8px',
      'cursor:pointer',
      'font-size:12px',
      'line-height:1.4',
      'transition:background 0.15s',
      `border:1px solid ${isDiagnostic ? 'var(--yellow,#f59e0b)' : 'var(--border-color)'}`,
      `background:${isDiagnostic ? 'var(--yellow-container,rgba(245,158,11,0.08))' : 'var(--bg-input)'}`,
      `color:${isDiagnostic ? 'var(--yellow,#f59e0b)' : 'var(--text-primary)'}`,
    ].join(';');

    // Icon prefix
    const icon = isDiagnostic ? '🔧 ' : '→ ';
    card.textContent = icon + suggestion.text;

    card.addEventListener('mouseenter', () => {
      card.style.background = isDiagnostic
        ? 'var(--yellow-container,rgba(245,158,11,0.15))'
        : 'var(--bg-hover,rgba(255,255,255,0.05))';
    });
    card.addEventListener('mouseleave', () => {
      card.style.background = isDiagnostic
        ? 'var(--yellow-container,rgba(245,158,11,0.08))'
        : 'var(--bg-input)';
    });

    card.addEventListener('click', () => {
      this.onActionSelect?.(suggestion.action);
    });

    return card;
  }

  private showEmptyState(): void {
    if (!this.cardsContainer) return;
    this.cardsContainer.innerHTML =
      '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:12px;">' +
      'Suggestions will appear after task completion.</div>';
  }

  private cleanupListener(): void {
    if (this.suggestionsHandler) {
      eapi().removeListener('suggestions-ready', this.suggestionsHandler);
      this.suggestionsHandler = null;
    }
  }

  /** Clean up listeners when panel is destroyed. */
  destroy(): void {
    this.cleanupListener();
  }
}

// ─── Convenience export ─────────────────────────────────────────

export function renderSuggestionsPanel(
  container: HTMLElement,
  onActionSelect?: (action: string) => void,
): SuggestionsPanel {
  const panel = new SuggestionsPanel(container, onActionSelect);
  panel.render();
  return panel;
}
