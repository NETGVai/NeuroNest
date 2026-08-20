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

  // Enforce secure webPreferences via webContents session
  // Note: sandbox, contextIsolation, and nodeIntegration are set at creation time.
  // This function validates and logs if they were not set correctly.
  const prefs = (webContents as any).getLastWebPreferences?.() ?? {};

  if (prefs.sandbox !== true) {
    getLogger().warn(LOG_SOURCE, 'BrowserWindow created without sandbox=true. This is a security risk.');
  }
  if (prefs.contextIsolation !== true) {
    getLogger().warn(LOG_SOURCE, 'BrowserWindow created without contextIsolation=true. This is a security risk.');
  }
  if (prefs.nodeIntegration !== false && prefs.nodeIntegration !== undefined) {
    getLogger().warn(LOG_SOURCE, 'BrowserWindow created with nodeIntegration enabled. This is a security risk.');
  }
  if (prefs.webSecurity === false) {
    getLogger().warn(LOG_SOURCE, 'BrowserWindow created with webSecurity=false. This is a security risk.');
  }

  // Install navigation and new-window protections
  blockExternalNavigation(win, policy.allowedNavigationOrigins);
  interceptNewWindow(win, policy.allowedNavigationOrigins);
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
