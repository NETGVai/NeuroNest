/**
 * Settings panel module.
 * Implements the PanelModule interface for the application router.
 * Coordinates settings form rendering and IPC service communication.
 */

import type { PanelModule } from '../../types';
import type { SettingsServiceEvent, SettingsValues } from './types';
import { SettingsForm } from './settings-form';
import { SettingsService } from './settings-service';

export type { SettingField, SettingGroup, SettingsSchema, SettingsValues } from './types';

/**
 * Settings panel implementing the PanelModule lifecycle.
 * Loads settings from the main process and renders an editable form.
 */
class SettingsPanel implements PanelModule {
  private container: HTMLElement | null = null;
  private settingsForm: SettingsForm;
  private settingsService: SettingsService;
  private unsubscribeService: (() => void) | null = null;
  private header: HTMLElement | null = null;
  private formContainer: HTMLElement | null = null;
  private currentValues: SettingsValues = {};
  private loaded = false;

  constructor() {
    this.settingsForm = new SettingsForm();
    this.settingsService = new SettingsService();
  }

  /** Mount the settings panel into the given container element. */
  mount(container: HTMLElement): void {
    this.container = container;

    // Apply panel-level styles
    Object.assign(container.style, {
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    });

    // Create header
    this.header = this.createHeader();
    container.appendChild(this.header);

    // Create scrollable form container
    this.formContainer = document.createElement('div');
    Object.assign(this.formContainer.style, {
      flex: '1',
      overflowY: 'auto',
    });
    container.appendChild(this.formContainer);

    // Mount settings form
    this.settingsForm.mount(this.formContainer);

    // Wire up change callback
    this.settingsForm.setOnChange(async (key, value) => {
      this.currentValues[key] = value;
      await this.settingsService.saveSetting({ key, value });
    });

    // Start service and subscribe to external changes
    this.settingsService.start();
    this.unsubscribeService = this.settingsService.subscribe(this.handleServiceEvent);

    // Load settings
    this.loadSettings();
  }

  /** Unmount the settings panel and clean up resources. */
  unmount(): void {
    if (this.unsubscribeService) {
      this.unsubscribeService();
      this.unsubscribeService = null;
    }
    this.settingsService.stop();
    this.settingsForm.unmount();

    if (this.container) {
      this.container.innerHTML = '';
    }
    this.container = null;
    this.header = null;
    this.formContainer = null;
    this.currentValues = {};
    this.loaded = false;
  }

  /** Called when the panel receives focus. */
  onFocus(): void {
    // Reload settings on focus to pick up external changes
    if (this.loaded) {
      this.loadSettings();
    }
  }

  /** Called when the panel loses focus. */
  onBlur(): void {
    // No special cleanup needed.
  }

  /** Handle service events (external settings changes). */
  private handleServiceEvent = (event: SettingsServiceEvent): void => {
    switch (event.type) {
      case 'setting-changed':
        this.currentValues[event.key] = event.value;
        this.settingsForm.updateValue(event.key, event.value);
        break;
      default:
        break;
    }
  };

  /** Load all settings from the main process. */
  private async loadSettings(): Promise<void> {
    const response = await this.settingsService.loadSettings();

    if (response.success) {
      this.currentValues = response.values;
      this.settingsForm.render(response.schema, response.values);
      this.loaded = true;
    } else {
      this.showError(response.error ?? 'Failed to load settings');
    }
  }

  /** Display an error message in the panel. */
  private showError(message: string): void {
    if (!this.formContainer) return;
    this.formContainer.innerHTML = '';
    const errorEl = document.createElement('div');
    Object.assign(errorEl.style, {
      padding: '16px',
      color: 'var(--error-color, #f44)',
      fontSize: '13px',
    });
    errorEl.textContent = message;
    errorEl.setAttribute('role', 'alert');
    this.formContainer.appendChild(errorEl);
  }

  /** Create the settings panel header. */
  private createHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'settings-panel__header';
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      padding: '12px 16px',
      borderBottom: '1px solid var(--border-color, #333)',
      backgroundColor: 'var(--panel-header-bg, #252526)',
    });

    const title = document.createElement('h2');
    title.textContent = 'Settings';
    Object.assign(title.style, {
      margin: '0',
      fontSize: '16px',
      fontWeight: '600',
      color: 'var(--text-primary, #e0e0e0)',
      flex: '1',
    });
    header.appendChild(title);

    return header;
  }
}

/** Create and export the settings panel module singleton. */
export function createSettingsPanel(): PanelModule {
  return new SettingsPanel();
}

/** Default export: a ready-to-use settings panel instance. */
export const settingsPanel: PanelModule = createSettingsPanel();
