/**
 * PowersManagementPanel — Renderer component for managing installed powers.
 *
 * Provides:
 * - Display of installed powers with activation status
 * - Activate/deactivate powers on demand
 * - Marketplace placeholder for discovering new powers
 *
 * Uses IPC channels:
 * - `powers:list` — fetch all installed powers with activation status
 * - `powers:activate` — manually activate a power by name
 * - `powers:deactivate` — deactivate a power by name
 *
 * Requirements: 19.5
 */

// ─── Electron API accessor ──────────────────────────────────────

function eapi(): {
  send(channel: string, ...args: unknown[]): void;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  removeListener(channel: string, cb: (...args: unknown[]) => void): void;
} {
  return (window as any).electronAPI;
}

// ─── Types ──────────────────────────────────────────────────────

export interface PowerEntry {
  name: string;
  description: string;
  keywords: string[];
  activated: boolean;
  hasMcpServers: boolean;
  hasGuides: boolean;
}

export interface PowersManagementState {
  powers: PowerEntry[];
  loading: boolean;
  error: string | null;
  showMarketplace: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────

function escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── PowersManagementPanel ──────────────────────────────────────

export class PowersManagementPanel {
  private container: HTMLElement;
  private state: PowersManagementState;

  constructor(container: HTMLElement) {
    this.container = container;
    this.state = {
      powers: [],
      loading: true,
      error: null,
      showMarketplace: false,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────

  /**
   * Initialize the panel and load installed powers.
   */
  async init(): Promise<void> {
    this.render();
    await this.loadPowers();
  }

  /**
   * Reload the powers list from the backend.
   */
  async loadPowers(): Promise<void> {
    this.state.loading = true;
    this.state.error = null;
    this.render();

    try {
      const result = (await eapi().invoke('powers:list')) as {
        success: boolean;
        powers?: PowerEntry[];
        error?: string;
      };

      if (result.success && result.powers) {
        this.state.powers = result.powers;
      } else {
        this.state.error = result.error || 'Failed to load powers';
      }
    } catch (err: any) {
      this.state.error = err.message || 'Failed to load powers';
    } finally {
      this.state.loading = false;
      this.render();
    }
  }

  /**
   * Activate a power by name.
   */
  async activatePower(powerName: string): Promise<void> {
    try {
      const result = (await eapi().invoke('powers:activate', { name: powerName })) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        const power = this.state.powers.find((p) => p.name === powerName);
        if (power) {
          power.activated = true;
        }
      } else {
        this.state.error = result.error || `Failed to activate power: ${powerName}`;
      }
    } catch (err: any) {
      this.state.error = err.message || `Failed to activate power: ${powerName}`;
    }

    this.render();
  }

  /**
   * Deactivate a power by name.
   */
  async deactivatePower(powerName: string): Promise<void> {
    try {
      const result = (await eapi().invoke('powers:deactivate', { name: powerName })) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        const power = this.state.powers.find((p) => p.name === powerName);
        if (power) {
          power.activated = false;
        }
      } else {
        this.state.error = result.error || `Failed to deactivate power: ${powerName}`;
      }
    } catch (err: any) {
      this.state.error = err.message || `Failed to deactivate power: ${powerName}`;
    }

    this.render();
  }

  /**
   * Toggle the marketplace placeholder view.
   */
  toggleMarketplace(): void {
    this.state.showMarketplace = !this.state.showMarketplace;
    this.render();
  }

  /**
   * Get current state (for testing).
   */
  getState(): PowersManagementState {
    return { ...this.state, powers: [...this.state.powers] };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    this.container.innerHTML = '';
  }

  // ─── Rendering ──────────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'powers-management-panel';
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Powers Management');

    // Header
    wrapper.appendChild(this.renderHeader());

    // Error message
    if (this.state.error) {
      wrapper.appendChild(this.renderError());
    }

    // Marketplace placeholder
    if (this.state.showMarketplace) {
      wrapper.appendChild(this.renderMarketplace());
    } else {
      // Powers list or loading/empty state
      wrapper.appendChild(this.renderBody());
    }

    this.container.appendChild(wrapper);
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'powers-panel-header';

    const titleSection = document.createElement('div');
    titleSection.className = 'powers-panel-title-section';

    const icon = document.createElement('span');
    icon.className = 'powers-panel-icon';
    icon.textContent = '⚡';
    titleSection.appendChild(icon);

    const title = document.createElement('h3');
    title.className = 'powers-panel-title';
    title.textContent = 'Powers';
    titleSection.appendChild(title);

    const count = document.createElement('span');
    count.className = 'powers-panel-count';
    count.textContent = `(${this.state.powers.length})`;
    titleSection.appendChild(count);

    header.appendChild(titleSection);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'powers-panel-actions';

    const marketplaceBtn = document.createElement('button');
    marketplaceBtn.className = 'powers-marketplace-btn';
    marketplaceBtn.textContent = this.state.showMarketplace ? '← Back' : '🛒 Marketplace';
    marketplaceBtn.setAttribute('aria-label', this.state.showMarketplace ? 'Back to installed powers' : 'Browse power marketplace');
    marketplaceBtn.addEventListener('click', () => this.toggleMarketplace());
    actions.appendChild(marketplaceBtn);

    header.appendChild(actions);

    return header;
  }

  private renderError(): HTMLElement {
    const errorEl = document.createElement('div');
    errorEl.className = 'powers-error';
    errorEl.setAttribute('role', 'alert');
    errorEl.textContent = this.state.error || 'An error occurred';
    return errorEl;
  }

  private renderBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'powers-body';

    if (this.state.loading) {
      const loading = document.createElement('div');
      loading.className = 'powers-loading';
      loading.textContent = 'Loading powers...';
      body.appendChild(loading);
      return body;
    }

    if (this.state.powers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'powers-empty-state';
      empty.innerHTML =
        '<p>No powers installed.</p>' +
        '<p>Powers provide domain-specific knowledge and tools that activate based on conversation context.</p>';
      body.appendChild(empty);
      return body;
    }

    // Powers list
    const list = document.createElement('div');
    list.className = 'powers-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Installed powers');

    for (const power of this.state.powers) {
      list.appendChild(this.renderPowerRow(power));
    }

    body.appendChild(list);
    return body;
  }

  private renderPowerRow(power: PowerEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = `powers-list-item ${power.activated ? 'powers-activated' : ''}`;
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `Power: ${power.name}`);
    row.setAttribute('data-power-name', power.name);

    // Info section
    const info = document.createElement('div');
    info.className = 'powers-item-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'powers-item-name';
    nameEl.textContent = power.name;
    info.appendChild(nameEl);

    const descEl = document.createElement('div');
    descEl.className = 'powers-item-description';
    descEl.textContent = power.description;
    info.appendChild(descEl);

    // Keywords
    const keywordsEl = document.createElement('div');
    keywordsEl.className = 'powers-item-keywords';
    for (const kw of power.keywords.slice(0, 5)) {
      const tag = document.createElement('span');
      tag.className = 'powers-keyword-tag';
      tag.textContent = kw;
      keywordsEl.appendChild(tag);
    }
    if (power.keywords.length > 5) {
      const more = document.createElement('span');
      more.className = 'powers-keyword-more';
      more.textContent = `+${power.keywords.length - 5} more`;
      keywordsEl.appendChild(more);
    }
    info.appendChild(keywordsEl);

    // Capabilities badges
    const badges = document.createElement('div');
    badges.className = 'powers-item-badges';
    if (power.hasMcpServers) {
      const mcpBadge = document.createElement('span');
      mcpBadge.className = 'powers-badge powers-badge-mcp';
      mcpBadge.textContent = 'MCP Tools';
      badges.appendChild(mcpBadge);
    }
    if (power.hasGuides) {
      const guideBadge = document.createElement('span');
      guideBadge.className = 'powers-badge powers-badge-guides';
      guideBadge.textContent = 'Guides';
      badges.appendChild(guideBadge);
    }
    info.appendChild(badges);

    row.appendChild(info);

    // Status badge
    const statusBadge = document.createElement('span');
    statusBadge.className = `powers-status-badge ${power.activated ? 'powers-status-active' : 'powers-status-inactive'}`;
    statusBadge.textContent = power.activated ? 'Active' : 'Inactive';
    row.appendChild(statusBadge);

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'powers-toggle-btn';
    toggleBtn.textContent = power.activated ? 'Deactivate' : 'Activate';
    toggleBtn.setAttribute('aria-label', `${power.activated ? 'Deactivate' : 'Activate'} ${power.name}`);
    toggleBtn.addEventListener('click', () => {
      if (power.activated) {
        this.deactivatePower(power.name);
      } else {
        this.activatePower(power.name);
      }
    });
    row.appendChild(toggleBtn);

    return row;
  }

  private renderMarketplace(): HTMLElement {
    const marketplace = document.createElement('div');
    marketplace.className = 'powers-marketplace';
    marketplace.setAttribute('role', 'region');
    marketplace.setAttribute('aria-label', 'Power Marketplace');

    const placeholder = document.createElement('div');
    placeholder.className = 'powers-marketplace-placeholder';

    const icon = document.createElement('div');
    icon.className = 'powers-marketplace-icon';
    icon.textContent = '🛒';
    placeholder.appendChild(icon);

    const title = document.createElement('h4');
    title.className = 'powers-marketplace-title';
    title.textContent = 'Power Marketplace';
    placeholder.appendChild(title);

    const desc = document.createElement('p');
    desc.className = 'powers-marketplace-description';
    desc.textContent = 'Discover and install domain-specific powers to enhance your agent with specialized knowledge, tools, and workflows.';
    placeholder.appendChild(desc);

    const comingSoon = document.createElement('div');
    comingSoon.className = 'powers-marketplace-coming-soon';
    comingSoon.textContent = 'Coming Soon';
    placeholder.appendChild(comingSoon);

    const hint = document.createElement('p');
    hint.className = 'powers-marketplace-hint';
    hint.textContent = 'For now, install powers manually by adding packages to .neuronest/powers/ in your project.';
    placeholder.appendChild(hint);

    marketplace.appendChild(placeholder);
    return marketplace;
  }
}

// ─── Factory ────────────────────────────────────────────────────

/**
 * Create and initialize a PowersManagementPanel in the given container.
 */
export function createPowersManagementPanel(container: HTMLElement): PowersManagementPanel {
  const panel = new PowersManagementPanel(container);
  panel.init();
  return panel;
}
