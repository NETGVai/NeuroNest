import { PluginManifestSchema } from '../shared/schemas.js';
import type { PluginManifest } from '../shared/types.js';

/**
 * Serializes a PluginManifest to a JSON string.
 * Validates: Requirement 17.10
 */
export function serializePluginManifest(manifest: PluginManifest): string {
  return JSON.stringify(manifest);
}

/**
 * Parses a JSON string into a validated PluginManifest.
 * Throws on invalid input.
 * Validates: Requirement 17.10, 17.11
 */
export function parsePluginManifest(json: string): PluginManifest {
  const raw = JSON.parse(json);
  return PluginManifestSchema.parse(raw);
}
