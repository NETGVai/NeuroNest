/**
 * Harness Health Diagnostic Widget — Renderer Component.
 *
 * Displays presence/absence of 7 harness components with:
 * - Status indicators (present/absent)
 * - Degradation messages for missing components
 * - One-click scaffolding in recommended order
 * - Real-time updates as files change
 *
 * Validates: Requirements 30.1, 30.2, 30.3, 30.4
 */

import type {
  HarnessComponentId,
  HarnessComponentStatus,
  HarnessHealthState,
  HarnessHealthConfig,
} from './types';
import {
  computeHarnessHealthState,
  getScaffoldActions,
  getNextScaffoldComponent,
  updateComponentStatus,
  setScaffolding,
  getHealthScore,
} from './harness-health-state';

// ─── Harness Health Widget ──────────────────────────────────────

export class HarnessHealthWidget {
  private state: HarnessHealthState;
  private container: HTMLElement;
  private config: HarnessHealthConfig;

  constructor(container: HTMLElement, config: HarnessHealthConfig) {
    this.container = container;
    this.config = config;
    // Start with empty — caller should call updateFileStatus()
    this.state = computeHarnessHealthState(new Set());
    this.render();
  }

  // ─── Public API ─────────────────────────────────────────────────

  /** Get current widget state. */
  getState(): HarnessHealthState {
    return this.state;
  }

  /** Update component status from a set of present files. */
  updateFileStatus(presentFiles: Set<string>): void {
    this.state = computeHarnessHealthState(presentFiles);
    this.render();
    this.config.onStatusChange?.(this.state);
  }

  /** Mark a specific component as present or absent (real-time update). */
  setComponentStatus(componentId: HarnessComponentId, status: 'present' | 'absent'): void {
    this.state = updateComponentStatus(this.state, componentId, status);
    this.render();
    this.config.onStatusChange?.(this.state);
  }

  /** Destroy the widget and clean up. */
  destroy(): void {
    this.container.innerHTML = '';
  }

  // ─── Private Render ─────────────────────────────────────────────

  private render(): void {
    this.container.innerHTML = '';
    this.container.className = 'harness-health-widget';

    // Header with health score
    this.container.appendChild(this.renderHeader());

    // Component list
    this.container.appendChild(this.renderComponentList());

    // Scaffold actions
    const scaffoldSection = this.renderScaffoldSection();
    if (scaffoldSection) {
      this.container.appendChild(scaffoldSection);
    }
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'harness-health-widget__header';

    const title = document.createElement('h3');
    title.textContent = 'Harness Health';
    title.className = 'harness-health-widget__title';
    header.appendChild(title);

    const score = document.createElement('span');
    score.className = 'harness-health-widget__score';
    const healthScore = getHealthScore(this.state);
    score.textContent = `${this.state.presentCount}/${this.state.components.length} components`;
    score.setAttribute('aria-label', `Health score: ${healthScore}%`);
    header.appendChild(score);

    return header;
  }

  private renderComponentList(): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'harness-health-widget__list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Harness component status');

    for (const component of this.state.components) {
      list.appendChild(this.renderComponentItem(component));
    }

    return list;
  }

  private renderComponentItem(component: HarnessComponentStatus): HTMLElement {
    const item = document.createElement('li');
    item.className = `harness-health-widget__item harness-health-widget__item--${component.status}`;
    item.setAttribute('role', 'listitem');
    item.dataset.componentId = component.id;

    // Status indicator
    const indicator = document.createElement('span');
    indicator.className = 'harness-health-widget__status-indicator';
    indicator.textContent = component.status === 'present' ? '✅' : '❌';
    indicator.setAttribute(
      'aria-label',
      `${component.label}: ${component.status}`,
    );
    item.appendChild(indicator);

    // Label
    const label = document.createElement('span');
    label.className = 'harness-health-widget__component-label';
    label.textContent = component.label;
    item.appendChild(label);

    // Degradation message for absent components
    if (component.status === 'absent') {
      const degradation = document.createElement('p');
      degradation.className = 'harness-health-widget__degradation';
      degradation.textContent = component.degradationMessage;
      degradation.setAttribute('role', 'alert');
      item.appendChild(degradation);
    }

    return item;
  }

  private renderScaffoldSection(): HTMLElement | null {
    const actions = getScaffoldActions(this.state);
    if (actions.length === 0) return null;

    const section = document.createElement('div');
    section.className = 'harness-health-widget__scaffold-section';

    const heading = document.createElement('h4');
    heading.textContent = 'Recommended Setup';
    heading.className = 'harness-health-widget__scaffold-heading';
    section.appendChild(heading);

    // Next recommended component
    const next = getNextScaffoldComponent(this.state);
    if (next) {
      const nextInfo = document.createElement('p');
      nextInfo.className = 'harness-health-widget__scaffold-next';
      nextInfo.textContent = `Next: ${next.label}`;
      section.appendChild(nextInfo);
    }

    // One-click scaffold button
    const scaffoldBtn = document.createElement('button');
    scaffoldBtn.type = 'button';
    scaffoldBtn.className = 'harness-health-widget__scaffold-btn';
    scaffoldBtn.textContent = this.state.isScaffolding
      ? 'Scaffolding...'
      : `Scaffold Next (${next?.label ?? 'none'})`;
    scaffoldBtn.disabled = this.state.isScaffolding || !next;
    scaffoldBtn.setAttribute('aria-label', `Scaffold ${next?.label ?? 'next component'}`);
    scaffoldBtn.addEventListener('click', () => {
      if (next) {
        this.handleScaffold(next.id);
      }
    });
    section.appendChild(scaffoldBtn);

    // Scaffold order list
    const orderList = document.createElement('ol');
    orderList.className = 'harness-health-widget__scaffold-order';
    orderList.setAttribute('aria-label', 'Recommended scaffolding order');
    for (const action of actions) {
      const li = document.createElement('li');
      li.textContent = action.label;
      li.className = 'harness-health-widget__scaffold-order-item';
      orderList.appendChild(li);
    }
    section.appendChild(orderList);

    return section;
  }

  // ─── Event Handlers ─────────────────────────────────────────────

  private handleScaffold(componentId: HarnessComponentId): void {
    this.state = setScaffolding(this.state, true);
    this.render();
    this.config.onScaffold?.(componentId);
  }
}
