/**
 * SettingsManager — Application settings, provider management, config import/export.
 *
 * Stub implementation with in-memory state. Manages provider configs,
 * API keys, default models, global preferences, and config import/export.
 *
 * Requirements: 14.1–14.5, 14.8
 */

import type {
  AppConfig,
  AppTheme,
  ModelConfig,
  TaskCategory,
  ProviderConfig,
  DockerSettings,
  FeatureFlags,
} from '../shared/types.js';
import { getProviderCatalogEntry } from '../pipeline/provider-catalog.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SettingsChangeEvent {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: Date;
}

/**
 * Optional persistence hook invoked after a configuration mutation that needs
 * to be durable (e.g. `setProfessionalMode`, `setProxyAuthToken`). The current
 * config is passed in. If the function rejects, the caller will roll back the
 * in-memory mutation and rethrow.
 */
export type SettingsPersistFn = (config: Readonly<AppConfig>) => Promise<void>;

// ─── Default config ─────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  theme: 'system',
  fontSize: 14,
  defaultModels: {
    'code-generation': { providerId: 'anthropic', model: 'claude-sonnet-4-20250514' },
    'code-review': { providerId: 'anthropic', model: 'claude-sonnet-4-20250514' },
    'planning': { providerId: 'openai', model: 'gpt-4o' },
    'chat': { providerId: 'anthropic', model: 'claude-sonnet-4-20250514' },
  },
  dockerSettings: {
    socketPath: '/var/run/docker.sock',
    maxContainers: 10,
  },
  featureFlags: {
    hyperAgents: true,
    agentSwarm: true,
    cao: true,
    promptOptimizer: true,
  },
  // ─── Professional Mode (LLM Proxy) ──────────────────────────
  professionalMode: false,
  proxyEndpoint: 'https://llm.neuronest.cc/v1',
  lowBalanceThresholdUsd: 1.0,
};

// ─── SettingsManager ────────────────────────────────────────────

export class SettingsManager {
  private config: AppConfig;
  private providers = new Map<string, ProviderConfig>();
  private changeListeners: Array<(event: SettingsChangeEvent) => void> = [];
  private persistFn: SettingsPersistFn | undefined;

  constructor(initialConfig?: Partial<AppConfig>, persist?: SettingsPersistFn) {
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
    this.persistFn = persist;
  }

  /**
   * Install or replace the persistence hook. Useful when the persistence layer
   * is constructed after the manager (e.g. wiring during app bootstrap).
   */
  setPersistFn(persist: SettingsPersistFn | undefined): void {
    this.persistFn = persist;
  }

  /**
   * Get the full config.
   */
  getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * Get theme.
   * Requirements: 14.2
   */
  getTheme(): AppTheme {
    return this.config.theme;
  }

  /**
   * Set theme — applied immediately.
   * Requirements: 14.2, 14.8
   */
  setTheme(theme: AppTheme): void {
    const old = this.config.theme;
    this.config.theme = theme;
    this.emitChange('theme', old, theme);
  }

  /**
   * Get font size.
   */
  getFontSize(): number {
    return this.config.fontSize;
  }

  /**
   * Set font size — applied immediately.
   * Requirements: 14.2, 14.8
   */
  setFontSize(size: number): void {
    const old = this.config.fontSize;
    this.config.fontSize = size;
    this.emitChange('fontSize', old, size);
  }

  /**
   * Get default model for a task category.
   * Requirements: 14.1
   */
  getDefaultModel(category: TaskCategory): ModelConfig {
    return { ...this.config.defaultModels[category] };
  }

  /**
   * Set default model for a task category.
   * Requirements: 14.1, 14.8
   */
  setDefaultModel(category: TaskCategory, model: ModelConfig): void {
    const old = this.config.defaultModels[category];
    this.config.defaultModels[category] = model;
    this.emitChange(`defaultModels.${category}`, old, model);
  }

  /**
   * Get Docker settings.
   * Requirements: 14.3
   */
  getDockerSettings(): DockerSettings {
    return { ...this.config.dockerSettings };
  }

  /**
   * Set Docker settings.
   * Requirements: 14.3, 14.8
   */
  setDockerSettings(settings: DockerSettings): void {
    const old = this.config.dockerSettings;
    this.config.dockerSettings = settings;
    this.emitChange('dockerSettings', old, settings);
  }

  /**
   * Get feature flags.
   * Requirements: 14.1
   */
  getFeatureFlags(): FeatureFlags {
    return { ...this.config.featureFlags };
  }

  /**
   * Set feature flags.
   * Requirements: 14.8
   */
  setFeatureFlags(flags: Partial<FeatureFlags>): void {
    const old = { ...this.config.featureFlags };
    this.config.featureFlags = { ...this.config.featureFlags, ...flags };
    this.emitChange('featureFlags', old, this.config.featureFlags);
  }

  /**
   * Add a provider config.
   *
   * Validation rules for the API key field (`apiKeyRef`):
   * - Local providers (`isLocal: true` in the catalog, e.g. `ollama`,
   *   `llamacpp`, `openmythos`) never require an API key in either mode.
   * - When professional mode is enabled, non-local providers MAY be added
   *   without an `apiKeyRef`. To avoid pre-allocating an API key slot, any
   *   `apiKeyRef` field is stripped from the stored config in this case
   *   (Requirement 2.6).
   * - When professional mode is disabled, non-local providers MUST be
   *   added with a non-empty `apiKeyRef`; otherwise an error is thrown.
   *
   * Requirements: 14.1, 2.2, 2.6
   */
  addProvider(provider: ProviderConfig): void {
    const catalog = getProviderCatalogEntry(provider.type);
    const isLocal = catalog?.isLocal === true;
    const proMode = this.config.professionalMode;

    let toStore: ProviderConfig = provider;

    if (!isLocal) {
      if (proMode) {
        // Professional mode: do not pre-allocate an API key slot for
        // newly-added non-local providers. Any provided apiKeyRef is
        // dropped so toggling professional mode off later does not
        // resurrect a placeholder reference.
        if ('apiKeyRef' in provider) {
          const { apiKeyRef: _drop, ...rest } = provider;
          toStore = rest as ProviderConfig;
        }
      } else {
        // Direct mode: non-local providers must have an API key reference.
        if (!provider.apiKeyRef || provider.apiKeyRef.length === 0) {
          throw new Error(
            `provider '${provider.id}' (${provider.type}) requires an API key`,
          );
        }
      }
    }

    this.providers.set(toStore.id, toStore);
    this.emitChange('providers', null, toStore);
  }

  /**
   * Remove a provider config.
   *
   * While professional mode is enabled, removing a stored provider would
   * also remove its API key reference, which Requirement 2.6 forbids: the
   * Settings_Manager must preserve previously stored API keys across
   * professional mode toggles. The exact error message is part of the
   * public contract and must not be altered.
   *
   * Requirements: 2.6
   */
  removeProvider(providerId: string): void {
    if (this.config.professionalMode) {
      throw new Error('cannot remove API key while professional mode is enabled');
    }
    const old = this.providers.get(providerId);
    this.providers.delete(providerId);
    this.emitChange('providers', old, null);
  }

  /**
   * List all providers.
   */
  listProviders(): ProviderConfig[] {
    return Array.from(this.providers.values());
  }

  /**
   * Export config as JSON (excluding API keys).
   * Requirements: 14.5
   */
  exportConfig(): string {
    const exportable = {
      ...this.config,
      providers: Array.from(this.providers.values()).map((p) => ({
        ...p,
        apiKeyRef: undefined, // Exclude API key references
      })),
    };
    return JSON.stringify(exportable, null, 2);
  }

  /**
   * Import config from JSON.
   * Requirements: 14.5
   */
  importConfig(json: string): void {
    const parsed = JSON.parse(json);
    if (parsed.theme) this.setTheme(parsed.theme);
    if (parsed.fontSize) this.setFontSize(parsed.fontSize);
    if (parsed.defaultModels) {
      for (const [category, model] of Object.entries(parsed.defaultModels)) {
        this.setDefaultModel(category as TaskCategory, model as ModelConfig);
      }
    }
    if (parsed.dockerSettings) this.setDockerSettings(parsed.dockerSettings);
    if (parsed.featureFlags) this.setFeatureFlags(parsed.featureFlags);
  }

  /**
   * Register a change listener.
   * Requirements: 14.8
   */
  onChange(callback: (event: SettingsChangeEvent) => void): void {
    this.changeListeners.push(callback);
  }

  // ─── Professional Mode (LLM Proxy) ─────────────────────────

  /**
   * Whether professional mode is currently enabled.
   * Requirements: 1.1
   */
  isProfessionalMode(): boolean {
    return this.config.professionalMode;
  }

  /**
   * Toggle professional mode with persistence and rollback semantics.
   *
   * - No-op (no event, no persistence) when the value is unchanged.
   * - On change, attempts persistence (if a `persist` hook is configured).
   *   If persistence throws, the in-memory value is rolled back and the error
   *   is rethrown without emitting an event.
   * - On success, a `SettingsChangeEvent` with `key: 'professionalMode'` is
   *   emitted within 200 ms of the value change, carrying the old and new
   *   values.
   *
   * Requirements: 1.1, 1.5, 1.7
   */
  async setProfessionalMode(enabled: boolean): Promise<void> {
    const old = this.config.professionalMode;
    if (enabled === old) {
      return; // strict equality — no-op, no event
    }
    this.config.professionalMode = enabled;
    if (this.persistFn) {
      try {
        await this.persistFn(this.config);
      } catch (err) {
        this.config.professionalMode = old;
        throw err;
      }
    }
    this.emitChange('professionalMode', old, enabled);
  }

  /**
   * Get the configured proxy auth bearer token (undefined if not set).
   * Requirements: 1.1
   */
  getProxyAuthToken(): string | undefined {
    return this.config.proxyAuthToken;
  }

  /**
   * Set or clear the proxy auth bearer token. Mirrors `setProfessionalMode`'s
   * persistence + rollback semantics so the UI never sees an event for a
   * value that wasn't actually persisted.
   *
   * Requirements: 1.1
   */
  async setProxyAuthToken(token: string | undefined): Promise<void> {
    const old = this.config.proxyAuthToken;
    if (token === old) {
      return;
    }
    if (token === undefined) {
      delete this.config.proxyAuthToken;
    } else {
      this.config.proxyAuthToken = token;
    }
    if (this.persistFn) {
      try {
        await this.persistFn(this.config);
      } catch (err) {
        if (old === undefined) {
          delete this.config.proxyAuthToken;
        } else {
          this.config.proxyAuthToken = old;
        }
        throw err;
      }
    }
    this.emitChange('proxyAuthToken', old, token);
  }

  /**
   * Get the configured proxy endpoint base URL.
   * Requirements: 1.1
   */
  getProxyEndpoint(): string {
    return this.config.proxyEndpoint;
  }

  /**
   * Set the proxy endpoint base URL (advanced override). Mirrors the
   * persistence + rollback semantics of `setProfessionalMode` so the UI
   * never sees an event for a value that wasn't actually persisted.
   *
   * The new endpoint must be a non-empty string per `AppConfigSchema`.
   *
   * Requirements: 1.1
   */
  async setProxyEndpoint(endpoint: string): Promise<void> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new Error('proxyEndpoint must be a non-empty string');
    }
    const old = this.config.proxyEndpoint;
    if (endpoint === old) {
      return;
    }
    this.config.proxyEndpoint = endpoint;
    if (this.persistFn) {
      try {
        await this.persistFn(this.config);
      } catch (err) {
        this.config.proxyEndpoint = old;
        throw err;
      }
    }
    this.emitChange('proxyEndpoint', old, endpoint);
  }

  /**
   * Get the low-balance warning threshold in USD.
   * Requirements: 8.4
   */
  getLowBalanceThreshold(): number {
    return this.config.lowBalanceThresholdUsd;
  }

  // ── Private helpers ─────────────────────────────────────────

  private emitChange(key: string, oldValue: unknown, newValue: unknown): void {
    const event: SettingsChangeEvent = { key, oldValue, newValue, timestamp: new Date() };
    for (const cb of this.changeListeners) {
      cb(event);
    }
  }
}
