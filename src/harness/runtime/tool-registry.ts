/**
 * Tool Registry — Canonical typed tool registration with render-intent validation.
 *
 * Tool_Registry defines each tool with versioned input and output schemas, owner,
 * risk class, Scope_Descriptor rules, idempotency semantics, concurrency class,
 * timeout policy, and pure Render_Intent function.
 *
 * Render_Intent is a closed versioned discriminated union validated at every boundary.
 * It cannot contain executable HTML, script, private path, secret, or unrestricted
 * locator. Renderers dispatch on intent.kind; tool names remain display metadata only.
 * Unsupported or invalid intents use the safe generic renderer.
 *
 * Requirements: 13.1, 13.8–13.9, 35.5–35.6, 37.5–37.6
 */

import {
  ToolRegistrationV1Schema,
  validateRenderIntentSafety,
  type ToolRegistrationV1,
  type ToolRegistryEntry,
  type RenderIntentFactory,
} from './tool-registry-schemas';
import {
  RenderIntentV1Schema,
  parseRenderIntent,
  type RenderIntentV1,
  type GenericIntentV1,
} from '../contracts/render-intent';
import type { ContractRef } from '../contracts/primitives';

// ─── Errors ─────────────────────────────────────────────────────

export class ToolRegistryError extends Error {
  constructor(
    message: string,
    public readonly code: ToolRegistryErrorCode,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}

export type ToolRegistryErrorCode =
  | 'INVALID_REGISTRATION'
  | 'DUPLICATE_TOOL'
  | 'TOOL_NOT_FOUND'
  | 'RENDER_INTENT_UNSAFE'
  | 'RENDER_INTENT_INVALID'
  | 'FACTORY_VALIDATION_FAILED';

// ─── Configuration ──────────────────────────────────────────────

export interface ToolRegistryConfig {
  /**
   * Whether to validate the render-intent factory at registration time
   * by calling it with a sample value. Default: true.
   */
  validateFactoryAtRegistration?: boolean;
}

// ─── Tool Registry ──────────────────────────────────────────────

/**
 * The canonical registry of typed tools, policy metadata, concurrency
 * characteristics, render intents, and lifecycle ownership.
 *
 * Requirements: 13.1, 13.8–13.9, 35.5–35.6, 37.5–37.6
 */
export class ToolRegistry {
  private readonly entries = new Map<string, ToolRegistryEntry>();
  private readonly config: Required<ToolRegistryConfig>;

  constructor(config?: ToolRegistryConfig) {
    this.config = {
      validateFactoryAtRegistration: config?.validateFactoryAtRegistration ?? true,
    };
  }

  /**
   * Register a tool with complete typed metadata and a render-intent factory.
   *
   * Validates:
   * 1. Registration metadata against ToolRegistrationV1Schema
   * 2. Render-intent factory produces a valid RenderIntentV1
   * 3. Factory output contains no executable markup, secrets, private paths,
   *    or unrestricted locators
   *
   * Requirement 13.1: Register versioned schemas, owner, risk, scope,
   * idempotency, concurrency, timeout, and pure render-intent factory.
   *
   * Throws ToolRegistryError on validation failure or duplicate registration.
   */
  register(
    registration: ToolRegistrationV1,
    renderIntentFactory: RenderIntentFactory,
  ): void {
    // 1. Validate registration metadata
    const parseResult = ToolRegistrationV1Schema.safeParse(registration);
    if (!parseResult.success) {
      throw new ToolRegistryError(
        `Invalid tool registration: ${parseResult.error.message}`,
        'INVALID_REGISTRATION',
        { issues: parseResult.error.issues },
      );
    }

    const validated = parseResult.data;
    const key = this.contractKey(validated.contract);

    // 2. Check for duplicate
    if (this.entries.has(key)) {
      throw new ToolRegistryError(
        `Tool already registered: ${key}`,
        'DUPLICATE_TOOL',
        { contract: validated.contract },
      );
    }

    // 3. Validate the render-intent factory at registration time
    if (this.config.validateFactoryAtRegistration) {
      this.validateFactory(renderIntentFactory, validated.contract);
    }

    // 4. Store the entry
    this.entries.set(key, {
      registration: validated,
      renderIntentFactory,
    });
  }

  /**
   * Unregister a tool by contract reference.
   * Returns true if the tool was removed, false if not found.
   */
  unregister(contract: ContractRef): boolean {
    return this.entries.delete(this.contractKey(contract));
  }

  /**
   * Get a tool entry by contract reference.
   * Returns undefined if not found.
   */
  get(contract: ContractRef): ToolRegistryEntry | undefined {
    return this.entries.get(this.contractKey(contract));
  }

  /**
   * Get a tool entry by tool name (first matching version).
   * Returns undefined if not found.
   */
  getByName(name: string): ToolRegistryEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.registration.contract.name === name) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * List all registered tool entries.
   */
  list(): ToolRegistryEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * List all registered tool metadata (without factories).
   */
  listMetadata(): ToolRegistrationV1[] {
    return Array.from(this.entries.values()).map((e) => e.registration);
  }

  /**
   * Check if a tool is registered.
   */
  has(contract: ContractRef): boolean {
    return this.entries.has(this.contractKey(contract));
  }

  /**
   * Get the current registration count.
   */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Produce a validated render intent for a tool result.
   *
   * Requirement 13.8: Render tool results from Render_Intent and
   * Canonical_Tool_Value without branching on tool names.
   *
   * Requirement 13.9: If input or output validation fails, return a
   * synthetic structured result paired with the immutable call identity.
   *
   * Requirement 35.5: Chat_Interface selects presentation from pure
   * Render_Intent data without branching on tool names.
   *
   * Requirement 35.6: Unsupported or invalid intents use the safe generic renderer.
   *
   * Requirement 37.5: Render_Intent identifies structured view from intent and value.
   *
   * Requirement 37.6: If structured presentation cannot be produced, render the
   * safe generic fallback without evaluating the tool name.
   */
  produceRenderIntent(contract: ContractRef, value: unknown): RenderIntentV1 {
    const entry = this.entries.get(this.contractKey(contract));
    if (!entry) {
      return this.safeGenericFallback('tool not found');
    }

    // Invoke the pure factory
    let rawIntent: RenderIntentV1;
    try {
      rawIntent = entry.renderIntentFactory(value);
    } catch {
      // Factory threw — use safe generic fallback (Req 35.6, 37.6)
      return this.safeGenericFallback('render intent factory error');
    }

    // Validate the produced intent against the schema
    const parseResult = parseRenderIntent(rawIntent);
    if (!parseResult.ok) {
      // Invalid discriminator or shape — use safe generic fallback (Req 35.6, 37.6)
      return parseResult.fallback;
    }

    // Validate safety constraints (Req 13.8, 35.5, 37.5)
    const violations = validateRenderIntentSafety(parseResult.intent);
    if (violations.length > 0) {
      return this.safeGenericFallback('render intent safety violation');
    }

    return parseResult.intent;
  }

  // ─── Private Helpers ────────────────────────────────────────────

  /**
   * Derive a stable map key from a contract reference.
   */
  private contractKey(contract: ContractRef): string {
    return `${contract.name}@${contract.version}`;
  }

  /**
   * Validate a render-intent factory by calling it with a sample value.
   * The factory must:
   * 1. Not throw
   * 2. Return a valid RenderIntentV1
   * 3. Not contain unsafe content
   */
  private validateFactory(factory: RenderIntentFactory, contract: ContractRef): void {
    let intent: RenderIntentV1;
    try {
      intent = factory(null);
    } catch (err) {
      throw new ToolRegistryError(
        `Render-intent factory threw during validation for ${contract.name}@${contract.version}: ${err instanceof Error ? err.message : String(err)}`,
        'FACTORY_VALIDATION_FAILED',
        { contract },
      );
    }

    // Validate the intent structure
    const parseResult = RenderIntentV1Schema.safeParse(intent);
    if (!parseResult.success) {
      throw new ToolRegistryError(
        `Render-intent factory produced invalid intent for ${contract.name}@${contract.version}: ${parseResult.error.message}`,
        'RENDER_INTENT_INVALID',
        { contract, issues: parseResult.error.issues },
      );
    }

    // Validate safety constraints
    const violations = validateRenderIntentSafety(parseResult.data);
    if (violations.length > 0) {
      throw new ToolRegistryError(
        `Render-intent factory produced unsafe intent for ${contract.name}@${contract.version}: ${violations.join('; ')}`,
        'RENDER_INTENT_UNSAFE',
        { contract, violations },
      );
    }
  }

  /**
   * Produce a safe generic fallback intent (Req 35.6, 37.6).
   */
  private safeGenericFallback(reason: string): GenericIntentV1 {
    return {
      kind: 'generic',
      label: reason,
      truncated: true,
    };
  }
}
