/**
 * Namespace Adapter — Filters and validates that only `neuronest.runtime.v1.*`
 * surfaces are registered and exposed by the runtime server.
 *
 * This adapter enforces namespace isolation between the session and runtime
 * MCP processes. Any tool, resource, or prompt that does not match the
 * runtime namespace prefix is rejected.
 *
 * The runtime server owns: capability, prompt, turn, queue, tool, provider,
 * collaboration, orchestration, profile, execution, credential, adapter,
 * introspection, and diagnostic surfaces.
 *
 * It does NOT own canonical session projection — that belongs to the session server.
 *
 * Requirements: 25.1, 30.2, 30.4, 32.1, 32.3
 */

import {
  RUNTIME_NAMESPACE_PREFIX,
  RUNTIME_SURFACE_CATEGORIES,
  type RuntimeSurfaceCategory,
} from './types.js';

// ─── Surface Registration ───────────────────────────────────────

export interface SurfaceDescriptor {
  /** Full qualified name, e.g. 'neuronest.runtime.v1.tool.execute' */
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
  category?: RuntimeSurfaceCategory;
  method?: string;
}

// ─── Session namespace prefix for rejection ─────────────────────

const SESSION_NAMESPACE_PREFIX = 'neuronest.session.v1' as const;

// ─── RuntimeNamespaceAdapter ────────────────────────────────────

export class RuntimeNamespaceAdapter {
  private readonly registeredSurfaces: Map<string, SurfaceDescriptor> = new Map();

  /**
   * Validate that a surface name belongs to the runtime namespace.
   *
   * Valid format: `neuronest.runtime.v1.<category>.<method>`
   *
   * Rejects session namespace methods explicitly to ensure this process
   * does not own canonical session projection.
   */
  validateSurfaceName(name: string): NamespaceValidationResult {
    // Explicitly reject session namespace
    if (name.startsWith(`${SESSION_NAMESPACE_PREFIX}.`)) {
      return {
        valid: false,
        reason: `Surface '${name}' belongs to the session namespace and is not supported by this server. Session projection ownership is outside this process.`,
      };
    }

    if (!name.startsWith(`${RUNTIME_NAMESPACE_PREFIX}.`)) {
      return {
        valid: false,
        reason: `Surface '${name}' does not match namespace prefix '${RUNTIME_NAMESPACE_PREFIX}.*'`,
      };
    }

    const suffix = name.slice(RUNTIME_NAMESPACE_PREFIX.length + 1);
    const parts = suffix.split('.');

    if (parts.length < 1 || !parts[0]) {
      return {
        valid: false,
        reason: `Surface '${name}' has no category after namespace prefix`,
      };
    }

    const category = parts[0] as string;
    if (!RUNTIME_SURFACE_CATEGORIES.includes(category as RuntimeSurfaceCategory)) {
      return {
        valid: false,
        reason: `Surface category '${category}' is not a valid runtime surface category. Valid: ${RUNTIME_SURFACE_CATEGORIES.join(', ')}`,
      };
    }

    const method = parts.slice(1).join('.');

    return {
      valid: true,
      category: category as RuntimeSurfaceCategory,
      method: method || undefined,
    };
  }

  /**
   * Register a surface descriptor after namespace validation.
   * Returns the validation result. Only valid surfaces are stored.
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
  getSurfacesByCategory(category: RuntimeSurfaceCategory): SurfaceDescriptor[] {
    const result: SurfaceDescriptor[] = [];
    for (const [name, descriptor] of this.registeredSurfaces) {
      if (name.startsWith(`${RUNTIME_NAMESPACE_PREFIX}.${category}`)) {
        result.push(descriptor);
      }
    }
    return result;
  }

  /**
   * Filter a list of method names to only those that belong to this namespace.
   * Non-runtime methods are excluded.
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

  /**
   * Returns true if the given method belongs to the session namespace.
   * Used to provide clear error messages about session projection ownership.
   */
  isSessionNamespace(name: string): boolean {
    return name.startsWith(`${SESSION_NAMESPACE_PREFIX}.`);
  }
}
