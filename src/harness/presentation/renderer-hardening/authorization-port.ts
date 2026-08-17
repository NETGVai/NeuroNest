/**
 * Authorization Port — Routes renderer actions through owning authorities.
 *
 * All file/web/attachment/spill actions from renderer adapters must pass
 * through this port for authorization. The port ensures:
 * - Actions are checked against scope, policy, and resource availability
 * - Denial reasons are canary-safe (no secrets, private paths, locators)
 * - Private storage paths are never exposed in results
 *
 * Requirements: 21.6, 24.2–24.8, 29.2, 37.9–37.11, 41.3, 41.11, 45.10
 */

import type {
  AuthorizationRequest,
  AuthorizationResult,
  AuthorizedActionKind,
  RendererAuthorizationPort,
} from './types';
import { makeCanarySafeLabel } from './canary-labels';

// ─── Action-Specific Validation ─────────────────────────────────

/**
 * Validate that a target is appropriate for the given action kind.
 * Returns a sanitized target or null if the target is invalid.
 */
function validateTarget(action: AuthorizedActionKind, target: string): string | null {
  if (!target || typeof target !== 'string') return null;

  switch (action) {
    case 'file_open':
    case 'file_download':
      // File targets must not contain protocol schemes
      if (/^[a-z]+:\/\//i.test(target)) return null;
      return target;

    case 'web_fetch':
    case 'web_navigate':
      // Web targets must be http/https
      if (!/^https?:\/\//i.test(target)) return null;
      return target;

    case 'attachment_retrieve':
    case 'attachment_download':
      // Attachment targets are opaque identifiers (no path-like content)
      if (target.includes('/') || target.includes('\\')) return null;
      return target;

    case 'spill_retrieve':
      // Spill locators are opaque (no path-like content)
      if (target.includes('/') || target.includes('\\')) return null;
      return target;

    default:
      return null;
  }
}

/**
 * Redact a target for safe inclusion in diagnostics and denial reasons.
 * Strips private paths, secrets, and raw locator identifiers.
 */
function redactTarget(action: AuthorizedActionKind, target: string): string {
  const safeLabel = makeCanarySafeLabel(target);
  // Further limit the length for diagnostic display
  const maxLen = 80;
  const text = safeLabel.text.length > maxLen
    ? safeLabel.text.slice(0, maxLen) + '...'
    : safeLabel.text;
  return `[${action}] ${text}`;
}

// ─── Default (Deny-All) Authorization Port ──────────────────────

/**
 * A default deny-all authorization port.
 * Used when no authority-backed port is configured.
 * All actions are denied with a generic policy reason.
 */
export class DenyAllAuthorizationPort implements RendererAuthorizationPort {
  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    return {
      decision: {
        authorized: false,
        code: 'POLICY_DENIED',
        reason: 'No authorization port configured for renderer actions',
      },
      action: request.action,
      redactedTarget: redactTarget(request.action, request.target),
      timestamp: Date.now(),
    };
  }

  isHealthy(): boolean {
    return true;
  }
}

// ─── Authority-Backed Authorization Port ────────────────────────

/**
 * Delegate interface for the owning authority.
 * Each authority type implements its own authorization logic.
 */
export interface AuthorityDelegate {
  /** Check if an action is permitted for the given scope and target. */
  checkPermission(
    action: AuthorizedActionKind,
    target: string,
    scopeId: string,
    sessionId: string,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

/**
 * An authorization port that routes through an authority delegate.
 *
 * Validates the request, consults the owning authority, and returns
 * a canary-safe result with no private paths or secrets exposed.
 */
export class AuthorityBackedAuthorizationPort implements RendererAuthorizationPort {
  private readonly delegate: AuthorityDelegate;
  private healthy = true;

  constructor(delegate: AuthorityDelegate) {
    this.delegate = delegate;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    // Validate the target format for the action kind
    const validatedTarget = validateTarget(request.action, request.target);
    if (validatedTarget === null) {
      return {
        decision: {
          authorized: false,
          code: 'UNAUTHORIZED_LOCATOR',
          reason: 'Invalid target format for requested action',
        },
        action: request.action,
        redactedTarget: redactTarget(request.action, request.target),
        timestamp: Date.now(),
      };
    }

    try {
      const result = await this.delegate.checkPermission(
        request.action,
        validatedTarget,
        request.scopeId,
        request.sessionId,
      );

      if (result.allowed) {
        return {
          decision: { authorized: true },
          action: request.action,
          redactedTarget: redactTarget(request.action, validatedTarget),
          timestamp: Date.now(),
        };
      }

      return {
        decision: {
          authorized: false,
          code: 'POLICY_DENIED',
          reason: result.reason ?? 'Action denied by authority policy',
        },
        action: request.action,
        redactedTarget: redactTarget(request.action, validatedTarget),
        timestamp: Date.now(),
      };
    } catch {
      this.healthy = false;
      return {
        decision: {
          authorized: false,
          code: 'RESOURCE_UNAVAILABLE',
          reason: 'Authorization authority is unavailable',
        },
        action: request.action,
        redactedTarget: redactTarget(request.action, request.target),
        timestamp: Date.now(),
      };
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /** Reset health state (e.g., after reconnection). */
  resetHealth(): void {
    this.healthy = true;
  }
}

// ─── Renderer Action Router ─────────────────────────────────────

/**
 * Routes renderer actions through the appropriate authorization port
 * based on action kind.
 *
 * All file/web/attachment/spill actions MUST pass through this router.
 * Direct access to resources from renderer adapters is prohibited.
 */
export class RendererActionRouter {
  private readonly ports: Map<AuthorizedActionKind, RendererAuthorizationPort>;
  private readonly fallback: RendererAuthorizationPort;

  constructor(
    ports?: Partial<Record<AuthorizedActionKind, RendererAuthorizationPort>>,
  ) {
    this.ports = new Map();
    this.fallback = new DenyAllAuthorizationPort();

    if (ports) {
      for (const [action, port] of Object.entries(ports)) {
        if (port) {
          this.ports.set(action as AuthorizedActionKind, port);
        }
      }
    }
  }

  /**
   * Route an authorization request to the appropriate port.
   * Falls back to deny-all if no port is registered for the action.
   */
  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    const port = this.ports.get(request.action) ?? this.fallback;
    return port.authorize(request);
  }

  /**
   * Check if the port for a specific action is healthy.
   */
  isPortHealthy(action: AuthorizedActionKind): boolean {
    const port = this.ports.get(action);
    if (!port) return true; // Fallback is always healthy
    return port.isHealthy();
  }

  /**
   * Get registered action kinds.
   */
  getRegisteredActions(): AuthorizedActionKind[] {
    return [...this.ports.keys()];
  }
}
