import { AppConfigSchema } from '../shared/schemas.js';
import type { AppConfig } from '../shared/types.js';

/**
 * Serializes an AppConfig to a JSON string.
 * Validates: Requirement 14.5, 14.6
 */
export function serializeAppConfig(config: AppConfig): string {
  return JSON.stringify(config);
}

/**
 * Parses a JSON string into a validated AppConfig.
 * Throws on invalid input.
 * Validates: Requirement 14.5, 14.6, 14.7
 */
export function parseAppConfig(json: string): AppConfig {
  const raw = JSON.parse(json);
  return AppConfigSchema.parse(raw);
}
