/**
 * Settings panel type definitions.
 * Defines typed boundaries for the settings module.
 */

/** A unique key identifying a setting. */
export type SettingKey = string;

/** Supported value types for settings. */
export type SettingValue = string | number | boolean;

/** Describes a single setting field for form rendering. */
export interface SettingField {
  key: SettingKey;
  label: string;
  description?: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  defaultValue: SettingValue;
  /** Available options for 'select' type fields. */
  options?: { label: string; value: string }[];
  /** Validation constraints. */
  min?: number;
  max?: number;
  placeholder?: string;
}

/** A group of related settings. */
export interface SettingGroup {
  id: string;
  title: string;
  description?: string;
  fields: SettingField[];
}

/** The full settings schema used to render the form. */
export interface SettingsSchema {
  groups: SettingGroup[];
}

/** Current settings values keyed by setting key. */
export type SettingsValues = Record<SettingKey, SettingValue>;

/** Request to load all settings from the main process. */
export interface LoadSettingsRequest {
  /** If provided, load only settings for this group. */
  groupId?: string;
}

/** Response containing current settings values. */
export interface LoadSettingsResponse {
  success: boolean;
  values: SettingsValues;
  schema: SettingsSchema;
  error?: string;
}

/** Request to save a setting value. */
export interface SaveSettingRequest {
  key: SettingKey;
  value: SettingValue;
}

/** Response after saving a setting. */
export interface SaveSettingResponse {
  success: boolean;
  error?: string;
}

/** Events emitted by the settings service. */
export type SettingsServiceEvent =
  | { type: 'setting-changed'; key: SettingKey; value: SettingValue }
  | { type: 'settings-loaded'; values: SettingsValues }
  | { type: 'settings-error'; error: string };

/** Listener for settings service events. */
export type SettingsServiceListener = (event: SettingsServiceEvent) => void;
