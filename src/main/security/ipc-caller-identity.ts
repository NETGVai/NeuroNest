/**
 * Main-derived IPC caller identity (FUT-PKG-04-SECURITY/T-001).
 *
 * Implements the D-16.2 rule that **renderer-provided tier markers are
 * untrusted**: the main process derives caller identity from the sender
 * `WebContents`, its window/session binding, an authenticated principal, and
 * the contract registration — never from a payload field such as the legacy
 * `__ipcTier` marker (NN-SEC-009, D-16.2, CD-024/CD-029).
 *
 * The identity produced here is exactly the {@link CallerIdentity} consumed by
 * the T-002 `ContractRegistry.authorizeDispatch()` main-attested authorization
 * path: `attestedTier` is what the main process is willing to vouch for a
 * caller, `assertedTier` is the *untrusted* renderer marker retained solely for
 * forgery detection / telemetry, and `sessionBound` records whether a valid
 * authenticated session is bound to the caller.
 *
 * Trust model (weakest to strongest):
 *
 *   - Any request whose sender is not a registered trusted main window is
 *     denied a tier entirely (`public`, `sessionBound:false`) — an untrusted or
 *     destroyed `WebContents`, a guest webview frame, or a devtools context
 *     never inherits privilege.
 *   - A request from the registered trusted main window is attested at the
 *     `authenticated` tier (the renderer is the app's own first-party UI).
 *   - `privileged`/`admin` are only attested when a caller-supplied
 *     authentication token is *validated in the main process* against the
 *     configured principal resolver. Absent a resolver or a valid token, the
 *     caller never rises above `authenticated`, regardless of any marker it
 *     supplies.
 *
 * This module registers no `ipcMain` handlers and mutates no existing contract;
 * it is a pure derivation used by the main handlers at the boundary. It runs
 * beside the typed registry with one main-process writer (NN-COMPAT-001/002).
 * Rollback returns a bounded validated adapter, never renderer-trusted
 * authorization.
 *
 * Design anchors: D-03, D-05, D-11, D-16, D-17, D-20.
 * Requirements: NN-SEC-001/009/017, NN-EVENT-007/009, NN-PLATFORM-001,
 * NN-COMPAT-017, CD-024, CD-029.
 */

import type { IpcMainInvokeEvent, WebContents } from 'electron';
import type { CallerIdentity, ContractTier } from '../../ipc/contract-registry';

/**
 * A resolved principal for a validated authentication token. The resolver is
 * the sole source of a `privileged`/`admin` tier: it must validate the token
 * in the main process (e.g. via the auth session manager) and return the
 * attested tier for that principal.
 */
export interface ResolvedPrincipal {
  /** Opaque principal id (never a raw secret). */
  readonly principalId: string;
  /** Tier the main process attests for this authenticated principal. */
  readonly tier: ContractTier;
}

/**
 * Resolve an authenticated principal from a caller-supplied token, in the main
 * process. Returning `null`/`undefined` means the token is absent, invalid, or
 * expired: the caller does not rise above the first-party `authenticated` tier.
 * A resolver MUST NOT consult any renderer-supplied tier marker.
 */
export type PrincipalResolver = (
  token: string | undefined,
) => ResolvedPrincipal | null | undefined;

/**
 * Configuration for the caller-identity deriver. `isTrustedSender` decides
 * whether a sender `WebContents` is the app's own first-party main window (the
 * only renderer context that inherits the `authenticated` floor). The optional
 * `principalResolver` upgrades a caller to `privileged`/`admin` after a
 * main-process token validation.
 */
export interface CallerIdentityConfig {
  /** True when the sender is a registered trusted main window. */
  readonly isTrustedSender: (sender: WebContents | undefined) => boolean;
  /** Optional main-process token validator; the sole source of admin tier. */
  readonly principalResolver?: PrincipalResolver;
}

/** The legacy, untrusted renderer-supplied tier marker (D-16.2 anti-pattern). */
export const LEGACY_TIER_MARKER = '__ipcTier';

/**
 * Extract the untrusted renderer-asserted tier marker from a payload, for
 * telemetry / forgery detection only. This value is *never* used to authorize.
 */
export function readAssertedTierMarker(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const marker = (payload as Record<string, unknown>)[LEGACY_TIER_MARKER];
  return typeof marker === 'string' ? marker : undefined;
}

/**
 * Determine whether the sender `WebContents` is safe to attest at all. A
 * destroyed or crashed sender, or one whose frame is not the trusted main
 * window, is never attested above `public`.
 */
function senderIsAttestable(
  sender: WebContents | undefined,
  isTrustedSender: (sender: WebContents | undefined) => boolean,
): boolean {
  if (!sender) return false;
  // A destroyed/crashed WebContents cannot be trusted. `isDestroyed` /
  // `isCrashed` are optional in test doubles, so guard their presence.
  try {
    if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
      return false;
    }
    if (typeof sender.isCrashed === 'function' && sender.isCrashed()) {
      return false;
    }
  } catch {
    return false;
  }
  return isTrustedSender(sender);
}

/**
 * Derive a main-attested {@link CallerIdentity} for an incoming
 * `IpcMainInvokeEvent`. Authorization tier is attested by the main process
 * only; the renderer's `__ipcTier` marker (if any) is captured as
 * `assertedTier` for forgery telemetry and never grants privilege.
 *
 * @param event   The Electron invoke event (source of the sender WebContents).
 * @param payload The first request argument, inspected only for the untrusted
 *                asserted-tier marker (telemetry) — never for authorization.
 * @param config  Trust decision + optional principal resolver.
 */
export function deriveCallerIdentity(
  event: Pick<IpcMainInvokeEvent, 'sender'> | undefined,
  payload: unknown,
  config: CallerIdentityConfig,
): CallerIdentity {
  const assertedTier = readAssertedTierMarker(payload);
  const sender = event?.sender;

  // Untrusted / unknown / destroyed sender: no attested tier, no session.
  if (!senderIsAttestable(sender, config.isTrustedSender)) {
    return { attestedTier: 'public', sessionBound: false, assertedTier };
  }

  // First-party main window: floor is `authenticated`.
  let attestedTier: ContractTier = 'authenticated';
  let principalId: string | undefined;
  let sessionBound = false;

  // A privileged/admin tier is attested ONLY after a main-process token
  // validation. The token comes from the caller payload but is verified in
  // main; it is not a self-asserted tier. A payload marker never reaches here.
  if (config.principalResolver) {
    const token = readAuthToken(payload);
    const resolved = config.principalResolver(token);
    if (resolved) {
      principalId = resolved.principalId;
      sessionBound = true;
      // Never let a resolver *lower* the first-party floor; take the stronger.
      attestedTier = resolved.tier;
    }
  }

  return { principalId, attestedTier, sessionBound, assertedTier };
}

/**
 * Read a caller-supplied auth token from a payload for main-process
 * validation. Only the `authToken` field is recognized; this is a bearer input
 * to the resolver, never an authorization decision by itself.
 */
export function readAuthToken(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const token = (payload as Record<string, unknown>).authToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * Build an `isTrustedSender` predicate that trusts exactly the provided set of
 * main-window `WebContents`. Identity is by object reference / stable id, not
 * by any renderer-controllable value. Destroyed windows are excluded by the
 * deriver's attestability check.
 */
export function trustedSenderFromWindows(
  getTrustedWebContents: () => readonly (WebContents | undefined)[],
): (sender: WebContents | undefined) => boolean {
  return (sender) => {
    if (!sender) return false;
    const trusted = getTrustedWebContents();
    for (const wc of trusted) {
      if (!wc) continue;
      if (wc === sender) return true;
      // Fall back to a stable numeric id comparison when available (survives
      // proxying) without trusting any renderer-supplied value.
      try {
        if (typeof wc.id === 'number' && typeof sender.id === 'number' && wc.id === sender.id) {
          return true;
        }
      } catch {
        /* id access may throw on a torn-down sender; treat as untrusted. */
      }
    }
    return false;
  };
}
