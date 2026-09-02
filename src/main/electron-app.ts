/**
 * Electron application bootstrap.
 * This is the main entry point — referenced by package.json "main".
 */

// reflect-metadata polyfill required by @peculiar/x509 v2 (via tsyringe)
import 'reflect-metadata';

// Suppress EPIPE errors from console.log when stdout pipe is broken
process.stdout?.on?.('error', (err: any) => { if (err?.code === 'EPIPE') return; });
process.stderr?.on?.('error', (err: any) => { if (err?.code === 'EPIPE') return; });

// In production, silence console.log/console.debug unless NEURONEST_DEBUG=1.
// Errors and warnings are always shown so users can report them.
(function configureLogging() {
  const isProduction = process.env.NODE_ENV === 'production';
  const isDebug = process.env.NEURONEST_DEBUG === '1' || process.env.NEURONEST_DEBUG === 'true';
  if (isProduction && !isDebug) {
    const noop = () => {};
    // Keep error/warn — silence verbose logs
    console.log = noop;
    console.debug = noop;
    console.info = noop;
    console.trace = noop;
  }
})();

import { app, BrowserWindow, safeStorage } from 'electron';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { initAppSecrets, getAppSecretStore } from './app-secrets';
import { restoreWindowState, persistWindowState } from './native-shell';
import { registerIPCHandlers, notifyThemeChange, runtimeManager, activeLlmClient, initDeferredSubsystems } from './ipc';
import { getProcessLaunchKind } from './launch-mode';
import { LaunchModeService } from './launch-mode-service';
import { LaunchModeWindowGate } from './launch-mode-window-gate';
import { InspectorLayoutService } from './inspector-layout-service';
import { LegacyProviderKeyMigrationService } from './legacy-provider-key-migration-service';
import { startOllama, stopOllama } from './ollama-manager';
import { stopOpenMythos } from './openmythos-manager';
import { shutdownAgentSkillsService } from '../agent-skills/main-process-integration.js';
import type { WindowState } from '../shared/types';
import { hardenWindow, installCSP, getSecureWebPreferences, DEFAULT_SECURITY_POLICY, generateCSPNonce, injectCSPNonceMeta, enableLegacyWebviewGuest, type WebviewGuestPolicy } from './security/window-hardener';
import { migrateLegacyData, getDataDirectory } from '../storage/data-directory';
import { bootstrapGCF, shutdownGCF } from '../context/gcf-bootstrap.js';
import { initDatabase } from '../storage/database';
import { OSBackedKeyProvider } from '../storage/encrypted-blob-store';
import { CredentialService } from '../harness/credentials/credential-service';
import {
  ProtectedSecretsV2Provider,
  ProxyCredentialService,
} from './proxy-credential-service';
import { registerStubHandlers } from './stub-ipc';

// Auth system imports
import { CertificateManager } from './auth/certificate-manager';
import { AuthSessionManager } from './auth/session-manager';
import { DeepLinkHandler } from './auth/deep-link-handler';
import { AuthServer } from './auth/auth-server';
import { WebAuthnFlowController } from './auth/flow-controller';
import { SQLiteCredentialStore } from './auth/sqlite-credential-store';
import { registerAuthIPC } from './auth/auth-ipc';
import { registerSubscriptionIPC } from './subscription/subscription-ipc';
import { validateLicenseOnStartup } from './subscription/startup-validator';
import { EventLog } from '../pipeline/event-log';
import { SessionTelemetryService } from '../session/session-telemetry';
import { DualWriteReconciler } from '../pipeline/dual-write-reconciler';

let mainWindow: BrowserWindow | null = null;

// ── Inline .env Loader ──
// Electron doesn't auto-load .env files. Parse KEY=VALUE pairs from the project
// root .env so that secrets like BEARER_TOKEN and DATABASE_URL are available
// before initAppSecrets() runs. Real environment variables take precedence.
try {
  const fs = require('node:fs');
  const envPath = path.join(__dirname, '..', '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8') as string;
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Only set if not already defined — real env vars take precedence
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} catch {
  // .env loading failure is non-fatal — variables may be provided via real env
}

// ── Secret Store Initialization ──
// Load required secrets from environment variables at the very start.
// If any required secret is missing, the application refuses to start.
try {
  initAppSecrets();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[App] FATAL: ${message}`);
  process.exit(1);
}

// Auth system singletons — initialized once on first GUI startup
let certManager: CertificateManager | null = null;
let authSessionManager: AuthSessionManager | null = null;
let deepLinkHandler: DeepLinkHandler | null = null;
let authServer: AuthServer | null = null;
let flowController: WebAuthnFlowController | null = null;
let credentialStore: SQLiteCredentialStore | null = null;
let proxyCredentialService: ProxyCredentialService | null = null;
let launchModeWindowGate: LaunchModeWindowGate | null = null;
let legacyProviderKeyMigrationService: LegacyProviderKeyMigrationService | null =
  null;

function readBootstrapConfigValue(key: string): unknown {
  const row = initDatabase()
    .prepare('SELECT value FROM config WHERE key = ?')
    .get(key) as { value?: unknown } | undefined;
  if (typeof row?.value !== 'string') return row?.value;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return row.value;
  }
}

/** Read only allowlisted, non-secret context for the renderer bootstrap. */
function readRendererBootstrapContext(): {
  edition: 'community' | 'professional' | 'enterprise';
  themeRevision: number;
  activeProjectId?: string;
} {
  const storedEdition = readBootstrapConfigValue('edition');
  const edition = storedEdition === 'professional' || storedEdition === 'enterprise'
    ? storedEdition
    : 'community';
  const storedThemeRevision = readBootstrapConfigValue('themeRevision');
  const themeRevision = typeof storedThemeRevision === 'number'
    && Number.isInteger(storedThemeRevision)
    && storedThemeRevision >= 0
    ? storedThemeRevision
    : 0;
  const storedProjectId = readBootstrapConfigValue('activeProjectId');
  const activeProjectId = typeof storedProjectId === 'string'
    && storedProjectId.trim().length > 0
    ? storedProjectId.trim()
    : undefined;

  return {
    edition,
    themeRevision,
    ...(activeProjectId ? { activeProjectId } : {}),
  };
}

/** Build the main-process graphical launch gate shared by recreated windows. */
function ensureLaunchModeWindowGate(): LaunchModeWindowGate {
  if (launchModeWindowGate) return launchModeWindowGate;

  const db = initDatabase();
  const launchModeService = new LaunchModeService(db, {
    onRepair: (diagnostic) => {
      console.warn('[App] Launch mode setting repaired:', diagnostic.reason);
    },
  });

  // The Inspector layout service reads `getCurrentLaunchMode()` off the gate
  // itself so Classic startup — and Classic settings updates — can never
  // overwrite the persisted Advanced layout (Requirement 2.8). A forward
  // reference is safe because the gate is only consulted at read/update
  // time, well after construction.
  let gateRef: LaunchModeWindowGate | null = null;
  const inspectorLayoutService = new InspectorLayoutService(db, {
    getCurrentLaunchMode: () => gateRef?.getCurrentLaunchMode() ?? null,
    onDiagnostic: (diagnostic) => {
      if (diagnostic.kind === 'inspector-layout-repaired') {
        console.warn(
          '[App] Inspector layout repaired:',
          diagnostic.reason,
        );
      } else {
        console.warn(
          '[App] Inspector layout write rejected while not in Advanced mode',
        );
      }
    },
  });

  launchModeWindowGate = new LaunchModeWindowGate({
    launchModeService,
    inspectorLayoutService,
    selectorFile: path.join(
      __dirname,
      '..',
      'renderer',
      'first-run-mode-selector.html',
    ),
    workspaceFile: path.join(__dirname, '..', 'renderer', 'index.html'),
    createBootstrapSnapshot: (resolution, context) => {
      const base = {
        launchModeSource: resolution.source,
        ...readRendererBootstrapContext(),
      };
      if (resolution.mode === 'advanced') {
        return {
          launchMode: 'advanced',
          ...base,
          ...(context.inspector ? { inspector: context.inspector } : {}),
        };
      }
      return { launchMode: 'classic', ...base };
    },
    onWorkspaceLoaded: () => {
      initDeferredSubsystems().catch((error) => {
        console.error('[App] Deferred module initialization error (non-fatal):', error);
      });
    },
    onWorkspaceLoadError: (error) => {
      console.error('[App] Failed to open workspace after mode selection:', error);
    },
  });
  gateRef = launchModeWindowGate;
  return launchModeWindowGate;
}

/** Build the one main-process credential authority shared by every edition. */
function ensureProxyCredentialService(): ProxyCredentialService {
  if (proxyCredentialService) return proxyCredentialService;

  const credentialDb = initDatabase();
  const protectedProvider = new ProtectedSecretsV2Provider(
    credentialDb,
    safeStorage,
    new OSBackedKeyProvider(getDataDirectory()),
  );
  proxyCredentialService = new ProxyCredentialService({
    db: credentialDb,
    credentialService: new CredentialService(),
    secretProvider: protectedProvider,
  });
  return proxyCredentialService;
}

/**
 * Build the main-process legacy provider-key migration authority and run the
 * inventory once per process. The first invocation marks any saved cloud
 * provider that still carries an `apiKey` as `legacy-unused` before any cloud
 * inference can happen (Requirements 7.1, 7.2, 7.7 — enhanced-chat-ui design
 * Phase A). Repeated runs are no-ops on already-marked records. Failures are
 * non-fatal: the audit payload records `failed` and the renderer status IPC
 * continues to serve non-secret aggregate counts.
 */
function ensureLegacyProviderKeyMigrationService(): LegacyProviderKeyMigrationService {
  if (legacyProviderKeyMigrationService) return legacyProviderKeyMigrationService;

  const service = new LegacyProviderKeyMigrationService(initDatabase());
  try {
    const result = service.runMigration();
    console.log(
      `[App] Legacy provider-key migration ${result.status}: examined=${result.payload.recordsExamined}, disabled=${result.payload.recordsDisabled}, removed=${result.payload.recordsRemoved}, failures=${result.payload.failureCount}`,
    );
  } catch (error) {
    // A migration failure must never block startup or route cloud requests to
    // a legacy provider endpoint. `getStatus()` will continue to report the
    // last durable aggregate, which callers can use to surface a repair path.
    console.error(
      '[App] Legacy provider-key migration inventory failed (non-fatal, cloud routing remains proxy-only):',
      error,
    );
  }
  legacyProviderKeyMigrationService = service;
  return service;
}

/**
 * Whether this release profile enables the legacy guest webview
 * (NN-SEC-017). The in-app browser panel and the Stripe checkout surface are
 * legacy guests that must remain enabled; they run ONLY under the guarded
 * NN-SEC-017 guest-controls path. Set to `false` to fully disable the guest
 * (the capability then reports UNAVAILABLE). This is a fixed release-profile
 * constant, never a renderer-controllable value.
 */
const LEGACY_WEBVIEW_GUEST_ENABLED = true;

/**
 * FUT-PKG-02-FOUNDATION/T-006 — whether the phased startup coordinator runs on
 * this launch. Additive and developer-profile gated (D-23 rollout: developer
 * profile then internal opt-in). When enabled the coordinator composes the
 * D-09 boot phases (lease/root → capability probe → database/schema/migration
 * → reconciliation → contract registration → required projections → hardened
 * window/bootstrap) in an OBSERVER role beside the existing startup: it
 * produces a truthful scoped readiness report and, when a required authority/
 * schema/integrity phase blocks, a diagnostic-only signal, WITHOUT replacing
 * the legacy startup or weakening the 3.1 security posture. It never gates the
 * legacy app; it is a measured, reversible foundation gate. Off by default;
 * enable with `NEURONEST_FOUNDATION_STARTUP=1` (developer profile).
 */
function isFoundationStartupEnabled(): boolean {
  const flag = process.env.NEURONEST_FOUNDATION_STARTUP;
  return flag === '1' || flag === 'true';
}

/**
 * Build the NN-SEC-017 policy for the legacy guest webview. The guest runs in
 * a dedicated non-persistent isolated partition with a minimal constrained
 * preload, no Node integration, denied permissions/downloads/new-windows, and
 * enforced navigation policy. `allowAnyWebOrigin` reflects that the browser
 * panel is a general-purpose web surface; all other controls still apply, and
 * the checkout surface's initial Stripe origin is in the explicit allowlist.
 */
function buildLegacyWebviewGuestPolicy(): WebviewGuestPolicy {
  return {
    // A fresh in-memory partition dedicated to guest content; NOT the app's
    // own default/main partition.
    partition: 'nn-legacy-webview-guest',
    guestPreloadPath: path.join(__dirname, '..', 'renderer', 'webview-guest-preload.js'),
    // Initial attach targets: the app site and Stripe checkout hosts.
    allowedGuestOrigins: [
      'https://neuronest.cc',
      'https://checkout.stripe.com',
      'https://js.stripe.com',
    ],
    // The guest is granted no host permissions.
    allowedPermissions: [],
    allowDownloads: false,
    // The browser panel is a general-purpose web browser surface.
    allowAnyWebOrigin: true,
  };
}

function createMainWindow(): BrowserWindow {
  const saved: WindowState = restoreWindowState();

  const win = new BrowserWindow({
    x: saved.x,
    y: saved.y,
    width: saved.width,
    height: saved.height,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e2e',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: false,
    webPreferences: getSecureWebPreferences({
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      // NN-SEC-017 / D-16.1: webviewTag is DISABLED by default. The legacy
      // guest webview (in-app browser panel + Stripe checkout) is enabled
      // explicitly below under the guarded NN-SEC-017 guest-controls path, not
      // by trusting an insecure default here.
      webviewTag: LEGACY_WEBVIEW_GUEST_ENABLED,
    }),
  });

  // NN-SEC-017 legacy guest: install the guarded guest controls (isolated
  // partition, constrained preload, attach validation, and
  // navigation/window-open/permission/download/network policy) BEFORE the
  // window is hardened/loaded. If the policy is incomplete the guest stays
  // disabled and the capability is UNAVAILABLE — the app never silently
  // enables an unguarded guest.
  if (LEGACY_WEBVIEW_GUEST_ENABLED) {
    const guestApproved = enableLegacyWebviewGuest(win, buildLegacyWebviewGuestPolicy());
    if (!guestApproved) {
      console.warn('[Security] Legacy webview guest policy incomplete; guest disabled (UNAVAILABLE)');
    }
  }

  // Apply window hardening (fail-fast security-preference validation + navigation
  // blocking + new-window interception). Throws if the window is not secure.
  hardenWindow(win, DEFAULT_SECURITY_POLICY);

  // Generate per-window CSP nonce and install nonce-based CSP
  const cspNonce = generateCSPNonce();
  installCSP(undefined, undefined, cspNonce);

  // Inject nonce into every renderer document loaded in this window. First-run
  // selection and the production workspace are distinct documents.
  win.webContents.on('did-finish-load', () => {
    injectCSPNonceMeta(win, cspNonce);
  });

  if (saved.isMaximized) {
    win.maximize();
  }

  // NOTE: Do NOT call win.loadFile() here.
  // IPC handlers must be registered BEFORE the renderer starts loading,
  // otherwise the renderer may invoke handlers that don't exist yet.
  // loadFile() is called explicitly after registerIPCHandlers() in the startup sequence.

  // Show window once content is ready (avoids white flash). Workspace-only
  // deferred subsystems are started by LaunchModeWindowGate after resolution.
  win.once('ready-to-show', () => {
    win.show();
  });

  // Persist window state on move/resize/close
  const persist = () => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    persistWindowState({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    });
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('close', persist);

  return win;
}

/**
 * Initialize the auth system modules (CertificateManager, AuthServer, etc.).
 * Creates singletons once; subsequent calls are no-ops.
 * Returns true if modules were successfully created.
 */
function ensureAuthModules(): boolean {
  if (certManager) return true; // already initialized

  try {
    const authDb = initDatabase(); // uses the same default DB path as ipc.ts
    credentialStore = new SQLiteCredentialStore(authDb);

    certManager = new CertificateManager();
    authSessionManager = new AuthSessionManager();
    deepLinkHandler = new DeepLinkHandler();
    authServer = new AuthServer({
      credentialStore,
      authSessionManager,
    });
    flowController = new WebAuthnFlowController(
      certManager,
      authServer,
      deepLinkHandler,
      authSessionManager,
      {
        onAuthSuccess: (token: string) => {
          console.log('[App] Auth success via deep link');
          if (authSessionManager && mainWindow && !mainWindow.isDestroyed()) {
            authSessionManager.ensureSecret().then(async (secret) => {
              const payload = authSessionManager!.validateToken(token, secret);
              const email = payload?.userId || '';

              // Look up user profile from credential store
              let userName = email;
              let userAppId = '';
              let userDeviceId = '';
              try {
                const { initDatabase } = await import('../storage/database');
                const authDb = initDatabase();
                const { SQLiteCredentialStore } = await import('./auth/sqlite-credential-store');
                const store = new SQLiteCredentialStore(authDb);
                const profile = store.getUserProfile(email);
                console.log('[App] Profile lookup for', email, ':', profile ? `${profile.firstName} ${profile.lastName}` : 'not found');
                if (profile) {
                  userName = `${profile.firstName} ${profile.lastName}`.trim() || email;
                  userAppId = profile.appId;
                  userDeviceId = profile.deviceId;
                }
              } catch (e) {
                console.error('[App] Failed to look up user profile:', e);
              }

              mainWindow!.webContents.send('auth-status-update', {
                type: 'login-complete',
                success: true,
                credentialId: payload?.credentialId || 'authenticated',
                userName,
                userEmail: email,
                appId: userAppId,
                deviceId: userDeviceId,
              });

              // Stop auth server after successful login — no longer needed
              console.log('[App] Stopping auth server after successful login...');
              if (authServer) {
                authServer.stop().then(() => {
                  console.log('[App] Auth server stopped after successful login');
                  if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('auth-status-update', { type: 'server-stopped' });
                  }
                }).catch((err) => {
                  console.error('[App] Failed to stop auth server after login (non-fatal):', err);
                });
              } else {
                console.log('[App] authServer is null, cannot stop');
              }
              if (certManager) {
                certManager.stopHealthMonitor();
              }
            }).catch((err) => {
              console.error('[App] Failed to validate auth token:', err);
            });
          }
        },
        onFlowTimeout: () => {
          console.log('[App] Auth flow timed out');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('auth-status-update', {
              type: 'flow-timeout',
              message: 'Authentication timed out. Please try again.',
            });
          }
        },
        onError: (error: Error) => {
          console.error('[App] Auth flow error:', error.message);
        },
      },
    );

    console.log('[App] Auth modules instantiated');
    return true;
  } catch (err) {
    console.error('[App] Failed to instantiate auth modules:', err);
    return false;
  }
}

/**
 * Non-blocking auth initialization: provision cert, start server, register deep link, start health monitor.
 * Failures are logged but do NOT prevent the app from starting ("Simulate Login" fallback remains).
 */
async function initializeAuth(): Promise<void> {
  try {
    await flowController!.initialize();
    certManager!.startHealthMonitor();
    console.log('[App] Auth system initialized successfully');
  } catch (err) {
    console.error('[App] Auth initialization failed (non-fatal, Simulate Login fallback available):', err);
  }
}

/**
 * Register auth IPC handlers for the given window.
 * Safe to call even if auth modules failed to initialize.
 */
function registerAuthIPCForWindow(win: BrowserWindow): void {
  if (!flowController || !certManager || !authServer || !authSessionManager) {
    console.warn('[App] Auth modules not available, skipping auth IPC registration');
    return;
  }

  try {
    registerAuthIPC({
      flowController,
      certManager,
      authServer,
      sessionManager: authSessionManager,
      credentialStore: credentialStore ?? undefined,
      mainWindow: win,
    });
    console.log('[App] Auth IPC handlers registered');
  } catch (err) {
    console.error('[App] Failed to register auth IPC handlers:', err);
  }
}

// ── Single Instance Lock (required for Windows/Linux deep links) ──
// On Windows, when a deep link (neuronest://...) is clicked, the OS launches a new
// instance of the app with the URL as a command-line argument. The single instance
// lock ensures only one instance runs, and the 'second-instance' event fires on the
// existing instance with the argv containing the deep link URL.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Another instance is already running — it will receive our argv via 'second-instance'
  app.quit();
} else {
  app.on('second-instance', (_event, _argv) => {
    // Focus the main window when a second instance tries to launch
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Deep link handling is done in DeepLinkHandler.register() which also listens for 'second-instance'
  });
}

app.whenReady().then(async () => {
  // One-time migration of legacy data (~/.ai-superagent) into the canonical
  // data directory (~/.neuronest) — must run before any DB access so that
  // existing licenses, provider configs, and other user data carry over
  // from pre-rebrand installs. Idempotent: no-ops once the marker is written.
  try {
    const migrationResult = migrateLegacyData();
    if (migrationResult.status === 'completed') {
      console.log(`[Startup] Legacy data migration completed: ${migrationResult.message}`);
    } else if (migrationResult.status === 'failed') {
      console.error(`[Startup] Legacy data migration failed (will retry next launch): ${migrationResult.message}`);
    }
  } catch (migrationErr: unknown) {
    console.error('[Startup] Legacy data migration threw unexpectedly:', migrationErr);
  }

  // ── Phased Startup Coordinator (FUT-PKG-02-FOUNDATION/T-006) ──
  // Developer-profile gated, additive, OBSERVER-only foundation gate. Composes
  // the D-09 boot phases and logs a truthful scoped readiness report (and a
  // diagnostic-only signal when a required authority/schema/integrity phase
  // blocks). It runs BESIDE the legacy startup below and never replaces it,
  // gates it, or alters the 3.1 security hardening. Any failure here is
  // non-fatal: the legacy app proceeds exactly as before.
  if (isFoundationStartupEnabled()) {
    try {
      const { runFoundationStartup } = await import('./startup-foundation.js');
      const foundation = await runFoundationStartup();
      const { startup } = foundation;
      console.log(
        `[Foundation] Phased startup: mode=${startup.mode} mutationAllowed=${startup.mutationAllowed} ready=${startup.readiness.ready}`,
      );
      if (startup.mode === 'diagnostic-only' && startup.firstRequiredFailure) {
        const f = startup.firstRequiredFailure;
        console.warn(
          `[Foundation] Diagnostic-only startup — required phase '${f.phase}' blocked: ${f.failure?.reason ?? 'UNKNOWN'} (${f.failure?.message ?? ''})`,
        );
      }
      for (const isolated of startup.isolatedFailures) {
        console.warn(
          `[Foundation] Isolated (scoped) phase failure '${isolated.phase}': ${isolated.failure?.reason ?? 'UNKNOWN'} — core boot unaffected`,
        );
      }
      if (startup.readiness.notReadyCapabilities.length > 0) {
        console.log(
          `[Foundation] Not-ready capabilities: ${startup.readiness.notReadyCapabilities.join(', ')}`,
        );
      }
      // The coordinator holds a single-instance lease for observation; release
      // it immediately so it never contends with the legacy instance lock.
      foundation.instanceLease?.release();
      // Close any database handle the observer opened so it never holds a
      // second connection while the legacy `initDatabase()` path runs. The
      // schema/migration work is idempotent and WAL-safe; the observer only
      // needs to have opened it to attest readiness, not to keep it.
      if (foundation.database && foundation.database.ok) {
        foundation.database.db.close();
      }
    } catch (foundationErr) {
      console.error('[Foundation] Phased startup observer failed (non-fatal):', foundationErr);
    }
  }

  const processLaunchKind = getProcessLaunchKind();

  if (processLaunchKind === 'cli') {
    const { createCLIRenderer } = await import('../cli/cli-renderer');
    const { runREPL } = await import('../cli/index');
    const renderer = createCLIRenderer();
    process.on('SIGINT', () => {
      renderer.close();
      app.quit();
    });
    runREPL(renderer).then(() => app.quit());
    return;
  }

  mainWindow = createMainWindow();

  // Load the ESM-only GCF (F10 GCF_Wire_Format) library bindings. The encoder
  // imports it lazily so the CommonJS main process never `require()`s an
  // ESM-only package at load time (which would crash Electron's Node 20 with
  // ERR_PACKAGE_PATH_NOT_EXPORTED). Fail-soft: on any load error the F10
  // surfaces simply keep emitting their pre-existing JSON encoding.
  try {
    const { initGcf } = await import('../serializers/gcf-encoder.js');
    await initGcf();
  } catch (e) {
    console.warn('[App] GCF wire-format init skipped (F10 falls back to JSON):', e);
  }

  // Initialize runtime protection (production only)
  try {
    const { RuntimeProtection } = await import('../security/runtime-protection.js');
    const runtimeProtection = new RuntimeProtection();
    runtimeProtection.initialize(mainWindow);
  } catch (e) {
    console.warn('[App] Runtime protection init skipped:', e);
  }

  // Initialize secure communication (certificate pinning)
  try {
    const { setupCertificatePinning } = await import('../security/secure-communication.js');
    setupCertificatePinning();
  } catch (e) {
    console.warn('[App] Certificate pinning init skipped:', e);
  }

  // CRITICAL: Register IPC handlers BEFORE the renderer finishes loading.
  // createMainWindow() calls loadFile() which starts async page load.
  // We must register all handlers before the renderer can invoke them.
  //
  // Run the Dual_Write_Reconciler startup pass FIRST, after DB init and
  // BEFORE any chat-message IPC handler is exposed (12-factor-agent-
  // improvements task 29 → Requirement 6.8). The reconciler closes any
  // gap between authoritative tables (`agent_tasks`, `subagent_tasks`,
  // `pipeline_traces`, plus checkpoint refs) and `pipeline_events` left
  // behind by a previous EventLog flush failure / crash. It must finish
  // before the chat-message handler can run because the handler emits
  // new Pipeline_Events that would race with the gap-closing inserts.
  //
  // initDatabase() is idempotent (opens the same WAL-mode file; running
  // it here in addition to the lazy init inside registerIPCHandlers is
  // safe — better-sqlite3 supports multiple handles to the same DB).
  // Failures are caught and logged: a reconciliation failure must NEVER
  // block app startup, so we proceed regardless.
  try {
    const reconcilerDb = initDatabase();
    const reconcilerEventLog = new EventLog(reconcilerDb, { autoStart: false });
    const reconcilerMetrics = new SessionTelemetryService(reconcilerDb);
    const reconciler = new DualWriteReconciler(reconcilerDb, reconcilerEventLog, reconcilerMetrics);
    const summary = await reconciler.runOnStartup();
    console.log(`[App] Reconciler: replayed ${summary.reconciled} events, ${summary.unmatched} unmatched`);
  } catch (err) {
    console.error('[App] Reconciler startup pass failed (non-fatal):', err);
  }

  const launchModeGate = ensureLaunchModeWindowGate();
  const credentialLifecycle = ensureProxyCredentialService();
  const legacyKeyMigration = ensureLegacyProviderKeyMigrationService();
  registerIPCHandlers({
    mainWindow,
    appBootstrap: {
      ...launchModeGate.appBootstrapServices,
      readProxyCredentialStatus: () => credentialLifecycle.getRendererStatus(),
      readCloudProviderKeyMigrationStatus: () => legacyKeyMigration.getStatus(),
      listLegacyProviderKeys: () => legacyKeyMigration.listRecordsV1(),
      deleteLegacyProviderKey: (request) => {
        const outcome = legacyKeyMigration.deleteLegacyKey(request.providerId);
        return {
          schemaVersion: 1 as const,
          deleted: outcome.deleted,
          alreadyRemoved: outcome.alreadyRemoved,
          payload: outcome.payload,
        };
      },
    },
  });

  // ── Stub IPC Handlers ──
  // Register placeholder handlers for all declared-but-unimplemented IPC channels.
  // Must happen after registerIPCHandlers() so we don't collide with real handlers,
  // but before the renderer loads so invocations never hit "No handler registered".
  registerStubHandlers([
    'personas:update',
    'personas:preview',
    'personas:activate',
    'plan-mode:get-state',
    'plan-mode:toggle',
    'focus-mode:toggle',
    'voice:start-capture',
    'voice:stop-capture',
    'voice:status',
    'i18n:set-locale',
    'i18n:get-locale',
    'i18n:available-locales',
  ]);

  // ── GCF System Bootstrap ──
  // Wire the Global Context Framework into the application startup.
  // Must happen after registerIPCHandlers() completes so that core IPC is ready.
  // Graceful degradation: if bootstrap throws, log and continue without GCF.
  // Startup guard: if this code path is somehow skipped, terminate with an error.
  let gcfBootstrapAttempted = false;
  // gcfSystem is used by subsequent startup tasks (agent pipeline integration, task 13.x)
  let gcfSystem: import('../context/gcf-bootstrap.js').GCFSystem | null = null;
  try {
    gcfBootstrapAttempted = true;
    gcfSystem = await bootstrapGCF({
      db: initDatabase(),
      projectDir: getDataDirectory(),
      sessionId: crypto.randomUUID(),
      mainWindow,
    });
    console.log('[App] GCF system bootstrapped successfully');
  } catch (err) {
    console.error('[App] GCF bootstrap failed (graceful degradation):', err);
  }

  // Startup guard: if bootstrapGCF was never attempted (code path bug), terminate.
  if (!gcfBootstrapAttempted) {
    console.error('[App] FATAL: GCF bootstrap was never called — startup code path error');
    process.exit(1);
  }

  // Expose gcfSystem for use in later startup tasks (agent pipeline integration).
  // It is intentionally retained in scope even if not immediately consumed.
  void gcfSystem;

  // Resolve graphical mode only after fixed IPC handlers exist. New installs
  // remain on the restricted selector until the revisioned choice is committed.
  void launchModeGate.resolveAndLoad(mainWindow).catch((error) => {
    console.error('[App] Failed to load resolved launch surface:', error);
  });

  // Initialize auth system (non-blocking — failures don't prevent app startup)
  if (ensureAuthModules()) {
    registerAuthIPCForWindow(mainWindow);
    initializeAuth().catch((err) => {
      console.error('[App] Auth init error (non-fatal):', err);
    });
  }

  // Register subscription IPC handlers
  registerSubscriptionIPC();

  // Non-blocking startup license validation (Req 7.1, 7.4)
  // Wait for page to load so localStorage is accessible, then validate license
  const initializeLoadedWorkspace = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let isWorkspaceDocument = false;
    try {
      isWorkspaceDocument = new URL(mainWindow.webContents.getURL()).pathname.endsWith('/index.html');
    } catch { /* Invalid or transient URLs are retried after the next page load. */ }
    if (!isWorkspaceDocument) {
      mainWindow.webContents.once('did-finish-load', initializeLoadedWorkspace);
      return;
    }

    // Initialize auto-updater (electron-updater) — checks GitHub releases / configured publish target
    try {
      const { initAutoUpdater } = await import('./auto-updater');
      initAutoUpdater(mainWindow);
    } catch (err: any) {
      console.warn('[App] Auto-updater init failed (non-fatal):', err.message);
    }

    // Check for updates (blocks UI if update required)
    import('./update-checker.js').then(({ checkForUpdates }) => {
      checkForUpdates(mainWindow!).catch((err) => {
        console.warn('[App] Update check failed (non-fatal):', err);
      });
    }).catch(() => {});

    mainWindow.webContents
      .send('request-user-profile');

    // Listen for the profile response from the renderer via IPC (replaces executeJavaScript localStorage read)
    const { ipcMain: ipcMainProfile } = require('electron');
    ipcMainProfile.once('user-profile-response', async (_event: any, profile: { licenseKey?: string; appId?: string; subscriptionId?: string; invitationCode?: string }) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;

        // For Stripe subscription users: validate via payments API
        if (profile.licenseKey && profile.appId && profile.subscriptionId) {
          validateLicenseOnStartup(mainWindow, profile.licenseKey, profile.appId).catch((err) => {
            console.error('[App] Startup license validation error (non-fatal):', err);
          });
          return;
        }

        // For activation-code users: fetch plan from keys API
        if (profile.licenseKey) {
          // Get the stored invitation code to look up the plan
          const { ipcMain } = require('electron');
          const { initDatabase } = await import('../storage/database');
          try {
            const db2 = initDatabase();
            const row = db2.prepare("SELECT value FROM config WHERE key = 'license:invitationCode'").get() as any;
            const inviteCode = row?.value || '';
            if (inviteCode) {
              const os = require('node:os');
              const bearerToken = getAppSecretStore().get('BEARER_TOKEN');
              const plat = os.platform() === 'darwin' ? (os.arch() === 'arm64' ? 'macos-arm64' : 'macos-intel') : os.platform() === 'win32' ? (os.arch() === 'arm64' ? 'windows-arm64' : 'windows-x64') : (os.arch() === 'arm64' ? 'linux-arm64' : 'linux-x64');
              const ver = app.getVersion() || '0.0.0';
              fetch(`https://neuronest.cc/api/service/keys/${encodeURIComponent(inviteCode)}?platform=${encodeURIComponent(plat)}&version=${encodeURIComponent(ver)}`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${bearerToken}` },
              }).then(async (resp) => {
                if (!resp.ok) return;
                const data = await resp.json() as { features?: string[]; plan?: string };
                // Use the plan field from the server directly (source of truth for upgrades/downgrades)
                let plan = 'community';
                if (data.plan) {
                  // Server explicitly provides the plan — trust it
                  const serverPlan = data.plan.toLowerCase();
                  if (serverPlan === 'enterprise' || serverPlan === 'ent') plan = 'enterprise';
                  else if (serverPlan === 'professional' || serverPlan === 'pro') plan = 'professional';
                  else plan = 'community';
                } else {
                  // Fallback: derive from features array (legacy keys without plan field)
                  const features = (data.features || []).map((f: string) => f.toLowerCase());
                  if (features.includes('enterprise') || features.includes('ent')) plan = 'enterprise';
                  else if (features.includes('professional') || features.includes('pro')) plan = 'professional';
                }
                // Send plan update to renderer
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('subscription-status-update', { status: 'active', plan });
                  console.log('[App] Startup plan refresh from keys API:', plan, 'source:', data.plan ? 'server plan field' : 'features array');
                }
              }).catch((err: any) => {
                console.warn('[App] Startup plan refresh failed (non-fatal):', err.message);
              });
            }
          } catch (e) {
            console.warn('[App] Could not read invitation code for plan refresh:', e);
          }

          // Start periodic heartbeat (every 30 minutes, fire-and-forget)
          try {
            const { LicenseManager } = await import('./license/license-manager');
            const heartbeatDb = initDatabase();
            const heartbeatMgr = new LicenseManager({ db: heartbeatDb });
            // Initial heartbeat after 60 seconds
            setTimeout(() => { heartbeatMgr.heartbeat().catch(() => {}); }, 60000);
            // Then every 30 minutes
            setInterval(() => { heartbeatMgr.heartbeat().catch(() => {}); }, 30 * 60 * 1000);
          } catch (hbErr) {
            console.warn('[App] Heartbeat setup failed (non-fatal):', hbErr);
          }
        }
    });
  };
  mainWindow.webContents.once('did-finish-load', initializeLoadedWorkspace);

  // Initialize Agent Skills service
  try {
    const { initializeAgentSkillsInMainProcess } = await import('../agent-skills/main-process-integration');
    initializeAgentSkillsInMainProcess().then(() => {
      console.log('[App] Agent Skills service initialized');
    }).catch((error: any) => {
      console.error('[App] Failed to initialize Agent Skills service:', error);
    });
  } catch (error) {
    console.error('[App] Agent Skills integration not available:', error);
  }

  // Set app icon to brain emoji PNG
  try {
    const { nativeImage } = require('electron');
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
    const fs = require('node:fs');
    if (fs.existsSync(iconPath)) {
      const icon = nativeImage.createFromPath(iconPath);
      if (app.dock) app.dock.setIcon(icon);
      console.log('[App] Dock icon set from', iconPath);
    } else {
      console.log('[App] Icon not found at', iconPath);
    }
  } catch (e: any) {
    console.log('[App] Icon set skipped:', e?.message);
  }

  // Auto-start Ollama
  startOllama().then(r => console.log('[App]', r.message)).catch(e => console.error('[App] Ollama error:', e));

  // Dark Mode listener
  const { nativeTheme } = require('electron');
  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
      notifyThemeChange(mainWindow, theme);
    }
  });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
      const launchModeGate = ensureLaunchModeWindowGate();
      const credentialLifecycle = ensureProxyCredentialService();
      const legacyKeyMigration = ensureLegacyProviderKeyMigrationService();
      registerIPCHandlers({
        mainWindow,
        appBootstrap: {
          ...launchModeGate.appBootstrapServices,
          readProxyCredentialStatus: () => credentialLifecycle.getRendererStatus(),
          readCloudProviderKeyMigrationStatus: () =>
            legacyKeyMigration.getStatus(),
          listLegacyProviderKeys: () => legacyKeyMigration.listRecordsV1(),
          deleteLegacyProviderKey: (request) => {
            const outcome = legacyKeyMigration.deleteLegacyKey(request.providerId);
            return {
              schemaVersion: 1 as const,
              deleted: outcome.deleted,
              alreadyRemoved: outcome.alreadyRemoved,
              payload: outcome.payload,
            };
          },
        },
      });
      // Re-resolve mode for every recreated BrowserWindow after IPC is ready.
      void launchModeGate.resolveAndLoad(mainWindow).catch((error) => {
        console.error('[App] Failed to load resolved launch surface:', error);
      });

      // Re-register auth IPC for the new window
      registerAuthIPCForWindow(mainWindow);

      // Re-register subscription IPC for the new window
      registerSubscriptionIPC();

      // Auto-start Ollama
      startOllama().then(r => console.log('[App]', r.message)).catch(e => console.error('[App] Ollama error:', e));

      // Initialize Agent Skills service
      try {
        const { initializeAgentSkillsInMainProcess } = await import('../agent-skills/main-process-integration');
        initializeAgentSkillsInMainProcess().then(() => {
          console.log('[App] Agent Skills service initialized on activate');
        }).catch((error: any) => {
          console.error('[App] Failed to initialize Agent Skills service on activate:', error);
        });
      } catch (error) {
        console.error('[App] Agent Skills integration not available on activate:', error);
      }
    }
  });
});

app.on('window-all-closed', async () => {
  stopOllama();
  stopOpenMythos();
  await shutdownAgentSkillsService();
  try { await import('../channels/channel-manager'); } catch {}

  // Abort any active LLM streaming client (Req 9.3)
  try {
    if (activeLlmClient) {
      activeLlmClient.abort();
      console.log('[App] Active LLM client aborted on window close');
    }
  } catch (err) {
    console.error('[App] LLM client abort error (non-fatal):', err);
  }

  // Graceful auth shutdown: stop auth server and health monitor
  try {
    if (flowController) {
      await flowController.shutdown();
    }
    if (certManager) {
      certManager.stopHealthMonitor();
    }
    console.log('[App] Auth system shut down');
  } catch (err) {
    console.error('[App] Auth shutdown error (non-fatal):', err);
  }

  // Graceful runtime cleanup: stop all Docker containers before quitting
  try {
    if (runtimeManager) {
      await runtimeManager.shutdownAll();
    }
  } catch (err) {
    console.error('[App] Runtime shutdown error (non-fatal):', err);
  }

  // Graceful GCF shutdown: flush state and release resources
  try {
    await shutdownGCF();
    console.log('[App] GCF system shut down');
  } catch (err) {
    console.error('[App] GCF shutdown error (non-fatal):', err);
  }

  app.quit();
});
