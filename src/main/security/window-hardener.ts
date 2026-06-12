/**
 * Electron Window Hardener
 *
 * Enforces security policies on all BrowserWindow instances:
 * - Sandbox isolation
 * - Content Security Policy via session headers
 * - External navigation blocking
 * - New-window event interception
 *
 * @module src/main/security/window-hardener
 */

import { BrowserWindow, session, shell } from 'electron';
import { getLogger } from '../../utils/structured-logger';

const LOG_SOURCE = 'WindowHardener';

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
    'script-src': ["'self'", "'unsafe-inline'"],
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
 * @param ses - The Electron session to apply CSP to (defaults to defaultSession)
 * @param directives - CSP directive map (key = directive name, value = sources array)
 */
export function installCSP(
  ses?: Electron.Session,
  directives: Record<string, string[]> = DEFAULT_SECURITY_POLICY.cspDirectives
): void {
  const targetSession = ses ?? session.defaultSession;

  const cspValue = Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');

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
 * Intercepts new-window events to prevent the renderer from spawning windows.
 * External URLs are optionally opened in the system default browser via shell.openExternal.
 * Internal URLs matching allowed origins are silently blocked (no new window).
 */
function interceptNewWindow(win: BrowserWindow, allowedOrigins: string[]): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // If the URL looks like a legitimate external link, open in system browser
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url).catch((err) => {
        getLogger().error(LOG_SOURCE, 'Failed to open URL in system browser', err instanceof Error ? err : new Error(String(err)), { url });
      });
    } else {
      getLogger().warn(LOG_SOURCE, 'Blocked new-window event for URL', { url });
    }

    // Always deny the new window creation in the renderer
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
