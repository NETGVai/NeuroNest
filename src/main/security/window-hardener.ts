/**
 * Electron Window Hardener
 *
 * Enforces security policies on all BrowserWindow instances:
 * - Sandbox isolation
 * - Content Security Policy via session headers
 * - Nonce-based script allowlisting (no 'unsafe-inline')
 * - External navigation blocking
 * - New-window event interception (always denied; never auto-opens)
 *
 * External navigation may only reach `shell.openExternal` via the fixed
 * `shell:open-external-v1` IPC contract implemented in
 * `../shell-open-external-handler.ts`. This module never opens URLs on
 * behalf of the renderer — even for `https:` links.
 *
 * @module src/main/security/window-hardener
 */

import { BrowserWindow, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { getLogger } from '../../utils/structured-logger';

const LOG_SOURCE = 'WindowHardener';

/**
 * Configuration for building a nonce-based Content Security Policy header.
 */
export interface CSPConfig {
  /** Per-session cryptographic nonce for inline script allowlisting */
  nonce: string;
  /** Optional additional script hash values to allow (e.g., 'sha256-...') */
  additionalScriptHashes?: string[];
  /** Additional allowed connect-src origins beyond 'self' and 'https:' */
  connectSrc?: string[];
}

/**
 * Generates a cryptographically secure, per-session nonce for CSP script allowlisting.
 * The nonce is a base64-encoded random value (16 bytes = 128 bits of entropy).
 *
 * @returns A base64-encoded nonce string suitable for CSP headers
 */
export function generateCSPNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Builds a Content Security Policy header string without 'unsafe-inline' in script-src.
 * Uses nonce-based allowlisting for inline scripts.
 *
 * @param config - CSP configuration including the nonce and optional script hashes
 * @returns A fully-formed CSP header value string
 */
export function buildCSPHeader(config: CSPConfig): string {
  const { nonce, additionalScriptHashes = [], connectSrc = [] } = config;

  // Keep JavaScript eval disabled while allowing Shiki's packaged Oniguruma
  // WebAssembly engine to compile under Chromium's CSP enforcement.
  const scriptSources = [
    "'self'",
    "'wasm-unsafe-eval'",
    `'nonce-${nonce}'`,
    ...additionalScriptHashes.map(h => `'${h}'`),
  ];

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSources,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https:', ...connectSrc],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  };

  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}

/**
 * Security policy enforced on every BrowserWindow instance.
 */
export interface WindowSecurityPolicy {
  sandbox: true;
  webSecurity: true;
  contextIsolation: true;
  nodeIntegration: false;
  allowedNavigationOrigins: string[];
  cspDirectives: Record<string, string[]>;
}

/**
 * Default security policy for the application.
 * Restricts script-src to 'self' and trusted origins.
 */
export const DEFAULT_SECURITY_POLICY: WindowSecurityPolicy = {
  sandbox: true,
  webSecurity: true,
  contextIsolation: true,
  nodeIntegration: false,
  allowedNavigationOrigins: ['file://'],
  cspDirectives: {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'https:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
  },
};

/**
 * Enforces security-critical webPreferences on a BrowserWindow.
 * Overrides any insecure preferences that may have been set during creation.
 *
 * This must be called immediately after BrowserWindow construction,
 * before any content is loaded.
 */
export function hardenWindow(win: BrowserWindow, policy: WindowSecurityPolicy = DEFAULT_SECURITY_POLICY): void {
  const webContents = win.webContents;

  // Fail-fast validation of the security-critical webPreferences BEFORE any
  // content loads (D-16.1: "Post-creation validation is fail-fast before load,
  // not warning-only"). getSecureWebPreferences() already forces these at
  // creation time; a mismatch here means the factory was bypassed, which is a
  // hard security defect, not an advisory. We throw so the window is never
  // shown or navigated in an insecure state.
  const violations = collectSecurityPreferenceViolations(win);
  if (violations.length > 0) {
    const message = `BrowserWindow created with insecure webPreferences: ${violations.join('; ')}`;
    getLogger().error(LOG_SOURCE, message, new Error(message));
    throw new Error(`[${LOG_SOURCE}] ${message}`);
  }

  // Install navigation and new-window protections
  blockExternalNavigation(win, policy.allowedNavigationOrigins);
  interceptNewWindow(win, policy.allowedNavigationOrigins);
}

/**
 * Collect the set of security-critical webPreferences violations for a window.
 * Returns an empty array when the window enforces context isolation, sandbox,
 * web security, and no Node integration. `webviewTag` is validated separately
 * (NN-SEC-017): it must be `false` unless the caller opts into the guarded
 * legacy-guest path via {@link enableLegacyWebviewGuest}.
 *
 * Exposed for tests and for a caller that wants a fail-open audit (e.g. an
 * enforce-in-audit rollout) rather than the fail-fast throw of hardenWindow.
 */
export function collectSecurityPreferenceViolations(win: BrowserWindow): string[] {
  const webContents = win.webContents;
  const prefs = (webContents as any).getLastWebPreferences?.() ?? {};
  const violations: string[] = [];
  if (prefs.sandbox !== true) violations.push('sandbox is not true');
  if (prefs.contextIsolation !== true) violations.push('contextIsolation is not true');
  if (prefs.nodeIntegration === true) violations.push('nodeIntegration is enabled');
  if (prefs.webSecurity === false) violations.push('webSecurity is disabled');
  // webviewTag must be disabled by default (NN-SEC-017). A window that enables
  // it without the guarded guest path is a violation.
  if (prefs.webviewTag === true && (win as any).__nnLegacyGuestApproved !== true) {
    violations.push('webviewTag is enabled without an approved NN-SEC-017 guest policy');
  }
  return violations;
}

/**
 * Installs Content-Security-Policy headers on all responses via session.webRequest.
 * Uses onHeadersReceived to inject CSP, ensuring it cannot be bypassed by
 * renderer-injected HTML meta tags.
 *
 * When a nonce is provided, uses nonce-based script allowlisting (no 'unsafe-inline').
 * When no nonce is provided, falls back to directive-based CSP from the policy.
 *
 * @param ses - The Electron session to apply CSP to (defaults to defaultSession)
 * @param directives - CSP directive map (key = directive name, value = sources array)
 * @param nonce - Optional nonce to use for script-src allowlisting
 */
export function installCSP(
  ses?: Electron.Session,
  directives: Record<string, string[]> = DEFAULT_SECURITY_POLICY.cspDirectives,
  nonce?: string
): void {
  const targetSession = ses ?? session.defaultSession;

  let cspValue: string;

  if (nonce) {
    // Use nonce-based CSP (no 'unsafe-inline' in script-src)
    cspValue = buildCSPHeader({ nonce });
  } else {
    cspValue = Object.entries(directives)
      .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
      .join('; ');
  }

  targetSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspValue],
      },
    });
  });
}

/**
 * Blocks navigation to URLs outside allowed origins.
 * Intercepts both will-navigate and will-redirect events.
 * Blocked attempts are logged with the attempted URL.
 */
export function blockExternalNavigation(win: BrowserWindow, allowedOrigins: string[]): void {
  const isAllowed = (url: string): boolean => {
    return allowedOrigins.some((origin) => url.startsWith(origin));
  };

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      getLogger().warn(LOG_SOURCE, 'Blocked navigation to external URL', { url });
    }
  });

  // Also intercept will-redirect to prevent server-side redirects to external origins
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowed(url)) {
      event.preventDefault();
      getLogger().warn(LOG_SOURCE, 'Blocked redirect to external URL', { url });
    }
  });
}

/**
 * Intercepts new-window events. Every request is denied — including
 * `https:` links — without any side effect. There is *no* auto-open via
 * `shell.openExternal` from this path. Task 10.6 moved the sole
 * authorized external-navigation route to the fixed
 * `shell:open-external-v1` IPC contract; the renderer must route through
 * that contract explicitly. `_allowedOrigins` is retained on the
 * signature so callers do not break, but the value is unused.
 */
function interceptNewWindow(win: BrowserWindow, _allowedOrigins: string[]): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Never auto-open. Renderer-side callers must use the fixed
    // `shell:open-external-v1` IPC method after validation.
    getLogger().warn(LOG_SOURCE, 'Denied window-open request', { url });
    return { action: 'deny' };
  });
}

/**
 * Returns the secure webPreferences object that should be used
 * when creating BrowserWindow instances.
 * Merges provided overrides with the security-required defaults.
 */
export function getSecureWebPreferences(
  overrides: Partial<Electron.WebPreferences> = {}
): Electron.WebPreferences {
  return {
    ...overrides,
    // Security-critical settings that cannot be overridden
    sandbox: true,
    webSecurity: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    allowRunningInsecureContent: false,
  };
}

/**
 * Injects the CSP nonce into the renderer process via a meta tag.
 * This allows renderer-side scripts to discover the nonce and apply it
 * to dynamically-created script elements.
 *
 * Must be called after the window has loaded content (e.g., in `did-finish-load`).
 *
 * @param win - The BrowserWindow to inject the nonce into
 * @param nonce - The CSP nonce value to inject
 */
export function injectCSPNonceMeta(win: BrowserWindow, nonce: string): void {
  const script = `
    (function() {
      var meta = document.createElement('meta');
      meta.name = 'csp-nonce';
      meta.content = '${nonce}';
      document.head.appendChild(meta);
    })();
  `;
  win.webContents.executeJavaScript(script).catch((err) => {
    getLogger().error(
      LOG_SOURCE,
      'Failed to inject CSP nonce meta tag',
      err instanceof Error ? err : new Error(String(err))
    );
  });
}

// ─── NN-SEC-017 Legacy webview guest policy ──────────────────────────────────

/**
 * Policy describing the single legacy guest webview a release profile may
 * explicitly enable (NN-SEC-017, D-16.1). Every field is mandatory: a missing
 * or empty policy leaves the guest disabled and the capability `UNAVAILABLE`.
 */
export interface WebviewGuestPolicy {
  /**
   * Dedicated isolated partition for the guest. Must be a non-persistent
   * (`partitionName` without a `persist:` prefix is fine; a fresh in-memory
   * partition is preferred) or explicitly policy-approved partition. It MUST
   * NOT be the app's own default/main partition.
   */
  readonly partition: string;
  /** Absolute path to the minimal constrained guest preload script. */
  readonly guestPreloadPath: string;
  /** Exact allowlist of origins the guest is permitted to load/navigate to. */
  readonly allowedGuestOrigins: readonly string[];
  /**
   * Permissions the guest may be granted (e.g. none). Anything not listed is
   * denied. Empty array = deny all permission requests.
   */
  readonly allowedPermissions: readonly string[];
  /** When false (default), all guest-initiated downloads are cancelled. */
  readonly allowDownloads?: boolean;
  /**
   * When true, the guest is a general-purpose web browser surface: any
   * `http(s)` origin without embedded credentials is permitted for
   * navigation. `allowedGuestOrigins` still applies to the *initial* attach
   * validation. All other NN-SEC-017 controls (isolated partition, no Node,
   * constrained preload, denied permissions/downloads/new-windows,
   * guest-to-host escalation prevention) remain in force. Defaults to false
   * (exact-origin allowlist only).
   */
  readonly allowAnyWebOrigin?: boolean;
}

/** A guest partition name that must never be used for a webview guest. */
const FORBIDDEN_GUEST_PARTITIONS = new Set(['', 'persist:default']);

/**
 * Validate a {@link WebviewGuestPolicy}. Returns the list of reasons the
 * policy is unacceptable; an empty list means the policy is complete and the
 * guest may be enabled. Missing policy fields → guest stays disabled
 * (`UNAVAILABLE`), never silently enabled (NN-SEC-017).
 */
export function validateWebviewGuestPolicy(policy: WebviewGuestPolicy | undefined | null): string[] {
  const reasons: string[] = [];
  if (!policy || typeof policy !== 'object') {
    return ['no webview guest policy provided'];
  }
  if (typeof policy.partition !== 'string' || FORBIDDEN_GUEST_PARTITIONS.has(policy.partition)) {
    reasons.push('a dedicated non-default guest partition is required');
  }
  if (typeof policy.guestPreloadPath !== 'string' || policy.guestPreloadPath.length === 0) {
    reasons.push('a constrained guest preload path is required');
  }
  if (!Array.isArray(policy.allowedGuestOrigins) || policy.allowedGuestOrigins.length === 0) {
    reasons.push('an explicit guest origin allowlist is required');
  }
  if (!Array.isArray(policy.allowedPermissions)) {
    reasons.push('an explicit guest permission allowlist is required');
  }
  return reasons;
}

/**
 * The secure `webPreferences` a validated attach request must be constrained
 * to. Node integration is always denied; the guest is sandboxed, context
 * isolated, web-secure, and bound to the constrained guest preload and the
 * dedicated partition. Any renderer-supplied preload/options on the attach are
 * discarded in favor of these.
 */
export function guestWebPreferences(policy: WebviewGuestPolicy): Record<string, unknown> {
  return {
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    // Bind the guest to the dedicated isolated partition and constrained preload.
    partition: policy.partition,
    preload: policy.guestPreloadPath,
    // A guest may never spawn further guests.
    webviewTag: false,
  };
}

/**
 * Whether a URL is permitted for the guest under the policy's exact origin
 * allowlist. Comparison is by parsed canonical origin, never a raw prefix
 * (D-16.1). Unparseable, credentialed, or non-http(s) URLs are denied.
 */
export function guestUrlAllowed(
  url: string,
  allowedOrigins: readonly string[],
  options: { allowAnyWebOrigin?: boolean } = {},
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // General-purpose browser guest: any credential-free http(s) origin is
  // navigable. All other guest controls still apply.
  if (options.allowAnyWebOrigin === true) return true;
  const origin = parsed.origin;
  for (const allowed of allowedOrigins) {
    let allowedOrigin: string;
    try {
      allowedOrigin = new URL(allowed).origin;
    } catch {
      continue;
    }
    if (origin === allowedOrigin) return true;
  }
  return false;
}

/**
 * The minimal surface of an Electron `WebContents` the guest controls need. A
 * real `WebContents` satisfies this; tests supply a light double.
 */
export interface GuestControlHost {
  on(event: string, listener: (...args: any[]) => void): unknown;
  session?: {
    setPermissionRequestHandler?(
      handler: ((wc: unknown, permission: string, cb: (granted: boolean) => void) => void) | null,
    ): void;
    setPermissionCheckHandler?(handler: ((...args: any[]) => boolean) | null): void;
    on?(event: string, listener: (...args: any[]) => void): unknown;
  };
}

/**
 * Install the NN-SEC-017 guest controls on the *host* window's webContents:
 * validate `will-attach-webview` (strip unapproved preload/options, deny Node
 * integration, bind partition/preload), deny unapproved
 * navigation/window-open/permissions/downloads, and enforce destination
 * policy. Returns the set of control names that were installed so callers can
 * emit evidence. If the policy is invalid, NOTHING is installed and the caller
 * MUST leave the guest disabled (`UNAVAILABLE`).
 */
export function installWebviewGuestControls(
  host: GuestControlHost,
  policy: WebviewGuestPolicy,
): { installed: string[]; policyReasons: string[] } {
  const policyReasons = validateWebviewGuestPolicy(policy);
  if (policyReasons.length > 0) {
    getLogger().warn(LOG_SOURCE, 'Webview guest policy invalid; guest remains UNAVAILABLE', {
      reasons: policyReasons,
    });
    return { installed: [], policyReasons };
  }

  const installed: string[] = [];

  // 1. Validate the exact attach request; overwrite preload/options with the
  //    constrained secure set; deny Node integration (D-16.1).
  host.on('will-attach-webview', (event: any, webPreferences: any, params: any) => {
    // Deny Node integration and strip any renderer-supplied preload/options.
    if (webPreferences && typeof webPreferences === 'object') {
      const secure = guestWebPreferences(policy);
      for (const key of Object.keys(webPreferences)) {
        // Remove any renderer-provided key not in the secure set (e.g.
        // nodeIntegration:true, a rogue preload, an unexpected partition).
        if (!(key in secure)) delete webPreferences[key];
      }
      Object.assign(webPreferences, secure);
    }
    // Validate the attach src against the exact origin allowlist. The initial
    // attach src is always checked against the explicit allowlist even for a
    // general browser guest, so an unexpected initial target is still rejected.
    const src = params && typeof params.src === 'string' ? params.src : '';
    if (!src || !guestUrlAllowed(src, policy.allowedGuestOrigins)) {
      getLogger().warn(LOG_SOURCE, 'Denied webview attach for disallowed src', { src });
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    }
  });
  installed.push('will-attach-webview');

  // 2. Constrain the attached guest webContents: navigation, window-open,
  //    permissions, and downloads.
  host.on('did-attach-webview', (_event: any, guest: any) => {
    if (!guest || typeof guest.on !== 'function') return;

    // Deny navigation outside the allowlist (parsed-origin, not prefix).
    const navOpts = { allowAnyWebOrigin: policy.allowAnyWebOrigin === true };
    guest.on('will-navigate', (e: any, url: string) => {
      if (!guestUrlAllowed(url, policy.allowedGuestOrigins, navOpts)) {
        getLogger().warn(LOG_SOURCE, 'Denied guest navigation', { url });
        if (typeof e?.preventDefault === 'function') e.preventDefault();
      }
    });
    guest.on('will-redirect', (e: any, url: string) => {
      if (!guestUrlAllowed(url, policy.allowedGuestOrigins, navOpts)) {
        getLogger().warn(LOG_SOURCE, 'Denied guest redirect', { url });
        if (typeof e?.preventDefault === 'function') e.preventDefault();
      }
    });

    // Deny all guest-initiated new windows.
    if (typeof guest.setWindowOpenHandler === 'function') {
      guest.setWindowOpenHandler(({ url }: { url: string }) => {
        getLogger().warn(LOG_SOURCE, 'Denied guest window-open', { url });
        return { action: 'deny' };
      });
    }

    // Permission + download policy on the guest's (isolated) session.
    const guestSession = guest.session;
    if (guestSession) {
      if (typeof guestSession.setPermissionRequestHandler === 'function') {
        guestSession.setPermissionRequestHandler((_wc: unknown, permission: string, cb: (granted: boolean) => void) => {
          const granted = policy.allowedPermissions.includes(permission);
          if (!granted) getLogger().warn(LOG_SOURCE, 'Denied guest permission', { permission });
          cb(granted);
        });
      }
      if (typeof guestSession.setPermissionCheckHandler === 'function') {
        guestSession.setPermissionCheckHandler((_wc: unknown, permission: string) =>
          policy.allowedPermissions.includes(permission),
        );
      }
      if (typeof guestSession.on === 'function') {
        guestSession.on('will-download', (e: any, item: any) => {
          if (policy.allowDownloads !== true) {
            getLogger().warn(LOG_SOURCE, 'Cancelled guest download');
            if (typeof e?.preventDefault === 'function') e.preventDefault();
            if (item && typeof item.cancel === 'function') item.cancel();
          }
        });
      }
    }
  });
  installed.push('did-attach-webview');

  return { installed, policyReasons: [] };
}

/**
 * Mark a window as having an approved NN-SEC-017 legacy-guest policy so
 * {@link hardenWindow}'s fail-fast check permits `webviewTag: true` for that
 * window only. Installs the guest controls; if the policy is invalid the guest
 * is NOT approved and the marker is not set (capability stays `UNAVAILABLE`).
 *
 * @returns true when the guest is approved and controls were installed.
 */
export function enableLegacyWebviewGuest(
  win: BrowserWindow,
  policy: WebviewGuestPolicy,
): boolean {
  const { installed, policyReasons } = installWebviewGuestControls(
    win.webContents as unknown as GuestControlHost,
    policy,
  );
  if (policyReasons.length > 0 || installed.length === 0) {
    getLogger().warn(LOG_SOURCE, 'Legacy webview guest NOT enabled; capability UNAVAILABLE', {
      reasons: policyReasons,
    });
    return false;
  }
  (win as any).__nnLegacyGuestApproved = true;
  return true;
}
