/**
 * Extension Port Adapter — Base adapter class that routes all operations through
 * their owning NeuroNest authority. Subclasses define domain-specific operations.
 *
 * Every adapter:
 * 1. Validates that the target authority is registered
 * 2. Checks that the port is active
 * 3. Delegates execution to the owning authority
 * 4. Returns redacted structured diagnostics on bypass or failure
 *
 * Requirements: 1.1–1.6, 25.4, 35.12, 39.13, 43.3
 */

import { randomUUID } from 'node:crypto';
import type {
  ExtensionPortId,
  ExtensionPortResult,
  AuthorityDenial,
  ExtensionPort,
} from './types.js';
import { AUTHORITY_LABELS } from './types.js';
import type { AuthorityRegistry } from './authority-registry.js';

// ─── Base Extension Port Adapter ────────────────────────────────

/**
 * Abstract base for extension port adapters. Provides authority routing,
 * bypass rejection, and health-checking infrastructure.
 */
export abstract class BaseExtensionPortAdapter<TInput, TOutput>
  implements ExtensionPort<TInput, TOutput>
{
  readonly id: ExtensionPortId;
  protected readonly registry: AuthorityRegistry;

  constructor(id: ExtensionPortId, registry: AuthorityRegistry) {
    this.id = id;
    this.registry = registry;
  }

  /**
   * Execute an operation through the owning authority. Validates routing before
   * delegating to the concrete implementation.
   */
  async execute(input: TInput): Promise<ExtensionPortResult<TOutput>> {
    // Validate that the operation routes through the correct authority
    const routingCheck = this.registry.validateRouting(
      this.id.authority,
      this.id.name,
    );

    if (!routingCheck.ok) {
      return { ok: false, error: routingCheck.denial };
    }

    // Retrieve the owning authority instance
    const authority = this.registry.getAuthority(this.id.authority);
    if (!authority) {
      return {
        ok: false,
        error: this.createDenial(
          'AUTHORITY_BYPASS_REJECTED',
          `Authority '${AUTHORITY_LABELS[this.id.authority]}' is not available.`,
        ),
      };
    }

    // Delegate to concrete implementation
    return this.executeViaAuthority(input, authority);
  }

  /**
   * Check whether this port is healthy — the owning authority must be registered
   * and the port must be active.
   */
  isHealthy(): boolean {
    const check = this.registry.validateRouting(this.id.authority, this.id.name);
    return check.ok;
  }

  /**
   * Concrete subclasses implement this to perform the actual operation through
   * the authority instance.
   */
  protected abstract executeViaAuthority(
    input: TInput,
    authority: unknown,
  ): Promise<ExtensionPortResult<TOutput>>;

  /**
   * Utility to create a redacted denial.
   */
  protected createDenial(
    code: AuthorityDenial['code'],
    message: string,
  ): AuthorityDenial {
    return {
      authority: this.id.authority,
      portName: this.id.name,
      code,
      message,
      timestamp: Date.now(),
      correlationId: randomUUID(),
    };
  }

  /**
   * Utility to create a successful result.
   */
  protected success(value: TOutput): ExtensionPortResult<TOutput> {
    return { ok: true, value };
  }

  /**
   * Utility to create a denial result.
   */
  protected denied(
    code: AuthorityDenial['code'],
    message: string,
  ): ExtensionPortResult<TOutput> {
    return { ok: false, error: this.createDenial(code, message) };
  }
}
