/**
 * Schema Upcasters for Session Log
 *
 * Provides a registry of schema version upcasters that transform older
 * event versions to the current schema version during replay.
 *
 * Requirements: 3.3, 34.4
 */

import type { SessionEventV1 } from '../contracts/event.js';
import type { SchemaUpcaster, UpcasterRegistry } from './types.js';

/**
 * Default UpcasterRegistry implementation.
 *
 * Stores upcasters keyed by (fromVersion, toVersion) pairs and chains
 * them for multi-step version upgrades during replay.
 */
export class DefaultUpcasterRegistry implements UpcasterRegistry {
  private readonly upcasters = new Map<string, SchemaUpcaster>();

  private static key(from: number, to: number): string {
    return `${from}->${to}`;
  }

  /**
   * Register an upcaster for a specific version transition.
   */
  register(fromVersion: number, toVersion: number, upcaster: SchemaUpcaster): void {
    if (fromVersion >= toVersion) {
      throw new Error(`Upcaster must go from lower to higher version: ${fromVersion} -> ${toVersion}`);
    }
    this.upcasters.set(DefaultUpcasterRegistry.key(fromVersion, toVersion), upcaster);
  }

  /**
   * Check if an upcaster exists for a specific version transition.
   */
  hasUpcaster(fromVersion: number, toVersion: number): boolean {
    return this.upcasters.has(DefaultUpcasterRegistry.key(fromVersion, toVersion));
  }

  /**
   * Upcast an event to the target version.
   *
   * If direct upcaster exists, uses it.
   * Otherwise attempts chaining through intermediate versions.
   * Returns the event unchanged if already at target version.
   */
  upcast(event: SessionEventV1, targetVersion: number): SessionEventV1 {
    if (event.schemaVersion === targetVersion) {
      return event;
    }

    if (event.schemaVersion > targetVersion) {
      throw new Error(
        `Cannot downcast event from version ${event.schemaVersion} to ${targetVersion}`
      );
    }

    // Try direct upcaster
    const directKey = DefaultUpcasterRegistry.key(event.schemaVersion, targetVersion);
    const directUpcaster = this.upcasters.get(directKey);
    if (directUpcaster) {
      return directUpcaster(event);
    }

    // Try chaining through intermediate versions
    let current = event;
    for (let v = current.schemaVersion; v < targetVersion; v++) {
      const stepKey = DefaultUpcasterRegistry.key(v, v + 1);
      const stepUpcaster = this.upcasters.get(stepKey);
      if (!stepUpcaster) {
        throw new Error(
          `No upcaster chain available from version ${event.schemaVersion} to ${targetVersion} (missing ${v} -> ${v + 1})`
        );
      }
      current = stepUpcaster(current);
    }

    return current;
  }
}
