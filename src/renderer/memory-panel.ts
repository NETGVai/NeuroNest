/**
 * MemoryPanel — displays stored facts with timestamps and relevance scores.
 *
 * Supports inline fact deletion via `memory-forget` channel.
 * Shows fact count and quota usage.
 *
 * Requirements: 4.4, 4.8
 */

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function eapi(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

interface MemoryFact {
  id: string;
  userId: string;
  category: 'profile' | 'preference' | 'knowledge';
  key: string;
  value: string;
  relevanceScore: number;
  createdAt: string | Date;
  updatedAt: string | Date;
}

const CATEGORY_ICONS: Record<string, string> = {
  profile: '👤',
  preference: '⚙️',
  knowledge: '📚',
};

const MAX_QUOTA = 10_000;

// ─── MemoryPanel ────────────────────────────────────────────────

export class MemoryPanel {
  private container: HTMLElement;
  private factsContainer: HTMLElement | null = null;
  private quotaEl: HTMLElement | null = null;
  private userId: string;

  constructor(container: HTMLElement, userId: string = 'default') {
    this.container = container;
    this.userId = userId;
  }

  /** Render the panel and load facts. */
  render(): void {
    this.container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    header.innerHTML = '<h3 style="margin:0;">🧠 Long-Term Memory</h3>';

    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = 'Refresh';
    refreshBtn.style.cssText = 'font-size:11px;padding:4px 10px;border:1px solid var(--border-color);background:var(--bg-input);color:var(--text-secondary);border-radius:6px;cursor:pointer;';
    refreshBtn.addEventListener('click', () => this.loadFacts());
    header.appendChild(refreshBtn);
    this.container.appendChild(header);

    // Quota bar
    this.quotaEl = document.createElement('div');
    this.quotaEl.style.cssText = 'margin-bottom:12px;font-size:11px;color:var(--text-dim);';
    this.container.appendChild(this.quotaEl);

    // Facts list
    this.factsContainer = document.createElement('div');
    this.factsContainer.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:400px;overflow-y:auto;';
    this.container.appendChild(this.factsContainer);

    this.loadFacts();
  }

  /** Load facts from the main process. */
  async loadFacts(): Promise<void> {
    if (!this.factsContainer) return;
    this.factsContainer.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-dim);font-size:12px;">Loading…</div>';

    try {
      const facts = await eapi().invoke('memory-list', this.userId) as MemoryFact[];

      if (!Array.isArray(facts) || facts.length === 0) {
        this.showEmptyState();
        this.updateQuota(0);
        return;
      }

      this.renderFacts(facts);
      this.updateQuota(facts.length);
    } catch (err: unknown) {
      this.showError(err instanceof Error ? err.message : String(err));
    }
  }

  // ─── Rendering ──────────────────────────────────────────────

  private renderFacts(facts: MemoryFact[]): void {
    if (!this.factsContainer) return;
    this.factsContainer.innerHTML = '';

    for (const fact of facts) {
      this.factsContainer.appendChild(this.createFactRow(fact));
    }
  }

  private createFactRow(fact: MemoryFact): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-input);';

    // Category icon
    const icon = document.createElement('span');
    icon.style.cssText = 'font-size:14px;flex-shrink:0;margin-top:1px;';
    icon.textContent = CATEGORY_ICONS[fact.category] ?? '📝';
    row.appendChild(icon);

    // Content
    const content = document.createElement('div');
    content.style.cssText = 'flex:1;min-width:0;';

    const keyEl = document.createElement('div');
    keyEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--text-primary);';
    keyEl.textContent = fact.key;
    content.appendChild(keyEl);

    const valueEl = document.createElement('div');
    valueEl.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:2px;word-break:break-word;';
    valueEl.textContent = fact.value;
    content.appendChild(valueEl);

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:4px;';
    meta.textContent = `${formatDate(fact.createdAt)} · relevance: ${fact.relevanceScore.toFixed(2)}`;
    content.appendChild(meta);

    row.appendChild(content);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', `Delete fact: ${fact.key}`);
    deleteBtn.textContent = '✕';
    deleteBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:14px;padding:2px 4px;border-radius:4px;';
    deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.color = 'var(--red,#ef4444)'; });
    deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.color = 'var(--text-dim)'; });
    deleteBtn.addEventListener('click', () => this.deleteFact(fact));
    row.appendChild(deleteBtn);

    return row;
  }

  private async deleteFact(fact: MemoryFact): Promise<void> {
    try {
      await eapi().invoke('memory-forget', this.userId, fact.key);
      await this.loadFacts();
    } catch (err: unknown) {
      console.error('[MemoryPanel] Failed to delete fact:', err);
    }
  }

  private updateQuota(count: number): void {
    if (!this.quotaEl) return;
    const pct = ((count / MAX_QUOTA) * 100).toFixed(1);
    this.quotaEl.textContent = `${count.toLocaleString()} / ${MAX_QUOTA.toLocaleString()} facts (${pct}% used)`;
  }

  private showEmptyState(): void {
    if (!this.factsContainer) return;
    this.factsContainer.innerHTML =
      '<div style="text-align:center;padding:24px;color:var(--text-dim);font-size:12px;">' +
      'No facts stored yet. Use <code>/remember &lt;fact&gt;</code> to add one.</div>';
  }

  private showError(message: string): void {
    if (!this.factsContainer) return;
    this.factsContainer.innerHTML =
      `<div style="padding:12px;background:var(--red-container,rgba(248,113,113,0.12));border:1px solid var(--red);border-radius:8px;font-size:12px;color:var(--red);">` +
      `Error: ${escHtml(message)}</div>`;
  }

  destroy(): void {}
}

// ─── Convenience export ─────────────────────────────────────────

export function renderMemoryPanel(container: HTMLElement, userId?: string): MemoryPanel {
  const panel = new MemoryPanel(container, userId);
  panel.render();
  return panel;
}
