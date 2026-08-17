/**
 * Namespace Adapter — Filters and validates that only `neuronest.session.v1.*`
 * surfaces are registered and exposed by the session server.
 *
 * This adapter enforces namespace isolation between the session and runtime
 * MCP processes. Any tool, resource, or prompt that does not match the
 * session namespace prefix is rejected.
 *
 * Requirements: 30.1, 30.3, 32.1–32.2
 */

import {
  SESSION_NAMESPACE_PREFIX,
  SESSION_SURFACE_CATEGORIES,
  type SessionSurfaceCategory,
} from './types.js';

// ─── Surface Registration ───────────────────────────────────────

export interface SurfaceDescriptor {
  /** Full qualified name, e.g. 'neuronest.session.v1.projection.timeline' */
  name: string;
  /** Description of the surface */
  description?: string;
  /** Type of surface */
  kind: 'tool' | 'resource' | 'prompt';
  /** Input schema (JSON Schema) */
  inputSchema?: Record<string, unknown>;
}

export interface NamespaceValidationResult {
  valid: boolean;
  reason?: string;
  category?: SessionSurfaceCategory;
  method?: string;
}

// ─── NamespaceAdapter ───────────────────────────────────────────

export class NamespaceAdapter {
  private readonly registeredSurfaces: Map<string, SurfaceDescriptor> = new Map();

  /**
   * Validate that a surface name belongs to the session namespace.
   *
   * Valid format: `neuronest.session.v1.<category>.<method>`
   */
  validateSurfaceName(name: string): NamespaceValidationResult {
    if (!name.startsWith(`${SESSION_NAMESPACE_PREFIX}.`)) {
      return {
        valid: false,
        reason: `Surface '${name}' does not match namespace prefix '${SESSION_NAMESPACE_PREFIX}.*'`,
      };
    }

    const suffix = name.slice(SESSION_NAMESPACE_PREFIX.length + 1);
    const parts = suffix.split('.');

    if (parts.length < 1 || !parts[0]) {
      return {
        valid: false,
        reason: `Surface '${name}' has no category after namespace prefix`,
      };
    }

    const category = parts[0] as string;
    if (!SESSION_SURFACE_CATEGORIES.includes(category as SessionSurfaceCategory)) {
      return {
        valid: false,
        reason: `Surface category '${category}' is not a valid session surface category. Valid: ${SESSION_SURFACE_CATEGORIES.join(', ')}`,
      };
    }

    const method = parts.slice(1).join('.');

    const result: NamespaceValidationResult = {
      valid: true,
      category: category as SessionSurfaceCategory,
    };
    if (method) {
      result.method = method;
    }
    return result;
  }

  /**
   * Register a surface descriptor after namespace validation.
   * Returns true if registered, false if rejected.
   */
  register(descriptor: SurfaceDescriptor): NamespaceValidationResult {
    const validation = this.validateSurfaceName(descriptor.name);
    if (!validation.valid) {
      return validation;
    }

    this.registeredSurfaces.set(descriptor.name, descriptor);
    return validation;
  }

  /**
   * Check if a method name is exposed by this server.
   */
  isExposed(name: string): boolean {
    return this.registeredSurfaces.has(name);
  }

  /**
   * Get all registered surface descriptors.
   */
  getRegisteredSurfaces(): ReadonlyMap<string, SurfaceDescriptor> {
    return this.registeredSurfaces;
  }

  /**
   * Get surfaces filtered by category.
   */
  getSurfacesByCategory(category: SessionSurfaceCategory): SurfaceDescriptor[] {
    const result: SurfaceDescriptor[] = [];
    for (const [name, descriptor] of this.registeredSurfaces) {
      if (name.startsWith(`${SESSION_NAMESPACE_PREFIX}.${category}`)) {
        result.push(descriptor);
      }
    }
    return result;
  }

  /**
   * Filter a list of method names to only those that belong to this namespace.
   * Non-session methods are excluded.
   */
  filterToNamespace(methods: string[]): string[] {
    return methods.filter(m => this.validateSurfaceName(m).valid);
  }

  /**
   * Clear all registered surfaces (used during shutdown/reset).
   */
  clear(): void {
    this.registeredSurfaces.clear();
  }
}
