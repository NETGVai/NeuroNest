/**
 * Workspaces Panel — hub for accessing all registered workspace panels.
 *
 * Renders a grid of clickable cards, one per registered panel from the
 * PanelRegistry. Clicking a card mounts and displays that workspace panel
 * in the content area below the navigation grid.
 *
 * This gives users a visible, clickable UI to access:
 * - Automation Workspace (Loops, Pipelines, Scheduler, Missions, PCV, Headless)
 * - Drift & Intelligence (Drift, Semantic, Indexing, LSP, Prompt, Vision, Commit)
 * - Extensions & Skills (MCP, Skill Packs, Agent Skills, Powers)
 * - Quality & Security (Architecture, Artifacts, Benchmarks, Review, Security, Lint/Test)
 * - Management (Memory, Steering, Hooks, Backends, Sharing, Specs, Wiki, etc.)
 * - Agent Dashboard (Session fleet management)
 * - Cross-Session Memory (Learn, search, reinforce, forget)
 * - And all other registered panels
 */

import type { PanelModule } from '../types';

export function createWorkspacesPanel(): PanelModule {
  let container: HTMLElement | null = null;
  let activePanelContainer: HTMLElement | null = null;

  return {
    mount(el: HTMLElement) {
      container = el;
      render();
    },
    unmount() {
      if (container) container.innerHTML = '';
      container = null;
      activePanelContainer = null;
    },
  };

  function render() {
    if (!container) return;
    container.innerHTML = '';
    container.style.cssText = 'height:100%;display:flex;flex-direction:column;overflow:hidden;';

    // Navigation header
    const header = document.createElement('div');
    header.style.cssText = 'padding:16px 20px 12px;border-bottom:1px solid var(--border-color,#2d2d2d);flex-shrink:0;';
    header.innerHTML = '<h2 style="margin:0;font-size:18px;color:var(--text-primary,#cdd6f4);">Workspaces</h2>' +
      '<p style="margin:4px 0 0;font-size:12px;color:var(--text-secondary,#a6adc8);">Click a workspace to open it</p>';
    container.appendChild(header);

    // Grid of workspace cards
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:16px 20px;overflow-y:auto;flex:1;';

    const panels = getRegisteredPanels();
    for (const panel of panels) {
      grid.appendChild(createCard(panel));
    }

    container.appendChild(grid);

    // Panel content area (below grid, takes remaining space)
    activePanelContainer = document.createElement('div');
    activePanelContainer.style.cssText = 'flex:1;overflow-y:auto;display:none;border-top:1px solid var(--border-color,#2d2d2d);';
    container.appendChild(activePanelContainer);
  }

  function createCard(panel: { id: string; label: string; icon: string; group: string }): HTMLElement {
    const card = document.createElement('button');
    card.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;' +
      'padding:16px 12px;border-radius:8px;border:1px solid var(--border-color,#45475a);' +
      'background:var(--surface-secondary,#313244);cursor:pointer;transition:all 0.15s;' +
      'min-height:100px;';
    card.setAttribute('aria-label', 'Open ' + panel.label);
    card.title = panel.label;

    card.innerHTML =
      '<span style="font-size:24px;">' + panel.icon + '</span>' +
      '<span style="font-size:11px;font-weight:600;color:var(--text-primary,#cdd6f4);text-align:center;">' + escHtml(panel.label) + '</span>' +
      '<span style="font-size:9px;color:var(--text-muted,#6c7086);text-transform:uppercase;letter-spacing:0.5px;">' + escHtml(panel.group) + '</span>';

    card.addEventListener('mouseenter', () => {
      card.style.borderColor = 'var(--accent-color,#89b4fa)';
      card.style.background = 'var(--surface-tertiary,#45475a)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.borderColor = 'var(--border-color,#45475a)';
      card.style.background = 'var(--surface-secondary,#313244)';
    });

    card.addEventListener('click', () => openPanel(panel.id));
    return card;
  }

  function openPanel(panelId: string) {
    if (!container || !activePanelContainer) return;

    // Hide grid, show panel content
    const grid = container.querySelector('div:nth-child(2)') as HTMLElement;
    if (grid) grid.style.display = 'none';
    activePanelContainer.style.display = 'block';
    activePanelContainer.innerHTML = '';

    // Add back button
    const backBar = document.createElement('div');
    backBar.style.cssText = 'padding:8px 16px;border-bottom:1px solid var(--border-color,#2d2d2d);';
    const backBtn = document.createElement('button');
    backBtn.style.cssText =
      'font-size:12px;padding:4px 10px;border-radius:4px;border:1px solid var(--border-color,#45475a);' +
      'background:transparent;color:var(--text-secondary,#a6adc8);cursor:pointer;';
    backBtn.textContent = '\u2190 Back to Workspaces';
    backBtn.addEventListener('click', () => {
      if (grid) grid.style.display = 'grid';
      activePanelContainer!.style.display = 'none';
      activePanelContainer!.innerHTML = '';
    });
    backBar.appendChild(backBtn);
    activePanelContainer.appendChild(backBar);

    // Panel render container
    const panelEl = document.createElement('div');
    panelEl.style.cssText = 'height:calc(100% - 40px);overflow-y:auto;';
    activePanelContainer.appendChild(panelEl);

    // Load the panel via PanelRegistry
    const registry = (window as any).getPanelRegistry ? (window as any).getPanelRegistry() : null;
    if (registry) {
      registry.mount(panelId, panelEl).catch(() => {
        panelEl.innerHTML = '<div style="padding:20px;color:var(--text-secondary,#a6adc8);">Failed to load panel.</div>';
      });
    } else {
      panelEl.innerHTML = '<div style="padding:20px;color:var(--text-secondary,#a6adc8);">Panel registry not available.</div>';
    }
  }

  function getRegisteredPanels(): Array<{ id: string; label: string; icon: string; group: string }> {
    const registry = (window as any).getPanelRegistry ? (window as any).getPanelRegistry() : null;
    if (!registry || !registry._definitions) return getDefaultPanels();

    const panels: Array<{ id: string; label: string; icon: string; group: string }> = [];
    for (const id of Object.keys(registry._definitions)) {
      const def = registry._definitions[id];
      panels.push({
        id: def.id,
        label: def.label || def.id,
        icon: def.icon || '📋',
        group: def.group || 'tools',
      });
    }
    return panels.length > 0 ? panels : getDefaultPanels();
  }

  function getDefaultPanels(): Array<{ id: string; label: string; icon: string; group: string }> {
    return [
      { id: 'automation-workspace', label: 'Automation', icon: '🔄', group: 'automation' },
      { id: 'drift-intelligence-workspace', label: 'Drift & Intelligence', icon: '🎯', group: 'tools' },
      { id: 'extensions-workspace', label: 'Extensions & Skills', icon: '🔌', group: 'extensions' },
      { id: 'quality-review-security-workspace', label: 'Quality & Security', icon: '🔒', group: 'quality' },
      { id: 'management-surfaces', label: 'Management', icon: '⚙', group: 'settings' },
      { id: 'agent-dashboard-v2', label: 'Agent Dashboard', icon: '👥', group: 'tools' },
      { id: 'cross-session-memory', label: 'Cross-Session Memory', icon: '🧠', group: 'settings' },
      { id: 'interactive-terminal', label: 'Interactive Terminal', icon: '⌨', group: 'tools' },
      { id: 'network-activity', label: 'Network Activity', icon: '🌐', group: 'tools' },
      { id: 'cost-controls', label: 'Cost Controls', icon: '💰', group: 'settings' },
      { id: 'analytics-dashboard', label: 'Analytics Dashboard', icon: '📊', group: 'settings' },
      { id: 'marketplace', label: 'MCP Marketplace', icon: '🛒', group: 'extensions' },
      { id: 'worktree-manager', label: 'Worktree Manager', icon: '🌳', group: 'tools' },
    ];
  }

  function escHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
}
