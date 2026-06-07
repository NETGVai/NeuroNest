import { shell, BrowserWindow } from 'electron';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { CertificateManager } from './certificate-manager';
import { AuthServer } from './auth-server';
import { DeepLinkHandler } from './deep-link-handler';
import { AuthSessionManager } from './session-manager';

const AUTH_DOMAIN = 'auth.neuronest.cc';
const FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export type FlowState = 'idle' | 'registering' | 'logging-in';

export interface FlowControllerEvents {
  onAuthSuccess?: (token: string) => void;
  onFlowTimeout?: () => void;
  onError?: (error: Error) => void;
}

export class WebAuthnFlowController {
  private certManager: CertificateManager;
  private authServer: AuthServer;
  private deepLinkHandler: DeepLinkHandler;
  private sessionManager: AuthSessionManager;
  private events: FlowControllerEvents;

  private flowState: FlowState = 'idle';
  private flowTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    certManager: CertificateManager,
    authServer: AuthServer,
    deepLinkHandler: DeepLinkHandler,
    sessionManager: AuthSessionManager,
    events?: FlowControllerEvents,
  ) {
    this.certManager = certManager;
    this.authServer = authServer;
    this.deepLinkHandler = deepLinkHandler;
    this.sessionManager = sessionManager;
    this.events = events ?? {};
  }

  /**
   * Initialize the auth system: provision cert if needed, start auth server,
   * register deep link handler, and wire up the token callback.
   */
  async initialize(): Promise<void> {
    // Ensure a valid TLS certificate exists
    if (!this.certManager.hasValidCert()) {
      await this.certManager.provisionCert();
    }

    const certInfo = this.certManager.getCertInfo();
    if (!certInfo) {
      throw new Error('No valid certificate available after provisioning');
    }

    // Start the local HTTPS auth server
    await this.authServer.start(certInfo);

    // Register the deep link protocol handler
    this.deepLinkHandler.register();

    // Wire up the deep link token callback
    this.deepLinkHandler.onAuthToken((token: string) => {
      this.handleAuthToken(token);
    });
  }

  /**
   * Open the system browser to the registration page.
   * WebAuthn navigator.credentials calls execute in the system browser, NOT in Electron.
   */
  async startRegistration(userInfo: { firstName: string; lastName: string; email: string }): Promise<void> {
    // Reset any stale flow state (e.g., user closed browser tab without completing)
    if (this.flowState !== 'idle') {
      this.resetFlow();
    }

    this.flowState = 'registering';
    this.startFlowTimeout();

    const appId = this.getOrCreateAppId();
    const deviceId = this.getDeviceId();

    const encrypted = this.encryptParams({
      firstName: userInfo.firstName,
      lastName: userInfo.lastName,
      email: userInfo.email,
      appId,
      deviceId,
    });

    try {
      await shell.openExternal(`${this.getAuthBaseUrl()}/register?data=${encrypted}`);
    } catch (err) {
      this.resetFlow();
      this.notifyBrowserError();
      throw new Error('Could not open system browser. Please open https://auth.neuronest.cc:8443/register manually.');
    }
  }

  /**
   * Open the system browser to the login page.
   * WebAuthn navigator.credentials calls execute in the system browser, NOT in Electron.
   */
  async startLogin(userInfo: { email: string }): Promise<void> {
    // Reset any stale flow state (e.g., user closed browser tab without completing)
    if (this.flowState !== 'idle') {
      this.resetFlow();
    }

    this.flowState = 'logging-in';
    this.startFlowTimeout();

    const appId = this.getOrCreateAppId();
    const deviceId = this.getDeviceId();

    const encrypted = this.encryptParams({
      email: userInfo.email,
      appId,
      deviceId,
    });

    try {
      await shell.openExternal(`${this.getAuthBaseUrl()}/login?data=${encrypted}`);
    } catch (err) {
      this.resetFlow();
      this.notifyBrowserError();
      throw new Error('Could not open system browser. Please open https://auth.neuronest.cc:8443/login manually.');
    }
  }

  /**
   * Shut down the auth server and clean up all resources.
   */
  async shutdown(): Promise<void> {
    this.clearFlowTimeout();
    this.flowState = 'idle';
    await this.authServer.stop();
  }

  /**
   * Current flow state.
   */
  getFlowState(): FlowState {
    return this.flowState;
  }

  /**
   * Build the auth base URL using the actual port the auth server is bound to.
   */
  private getAuthBaseUrl(): string {
    const status = this.authServer.getStatus();
    const port = status.port;
    if (port === 443) {
      return `https://${AUTH_DOMAIN}`;
    }
    return `https://${AUTH_DOMAIN}:${port}`;
  }

  // ── Internal helpers ──────────────────────────────────────────────

  private handleAuthToken(token: string): void {
    this.clearFlowTimeout();
    this.flowState = 'idle';
    this.events.onAuthSuccess?.(token);
  }

  private startFlowTimeout(): void {
    this.clearFlowTimeout();
    this.flowTimeout = setTimeout(() => {
      this.flowState = 'idle';
      this.flowTimeout = null;
      this.events.onFlowTimeout?.();
    }, FLOW_TIMEOUT_MS);
  }

  private clearFlowTimeout(): void {
    if (this.flowTimeout) {
      clearTimeout(this.flowTimeout);
      this.flowTimeout = null;
    }
  }

  private resetFlow(): void {
    this.clearFlowTimeout();
    this.flowState = 'idle';
  }

  private getOrCreateAppId(): string {
    const appIdPath = path.join(os.homedir(), '.neuronest', 'app-id');
    if (fs.existsSync(appIdPath)) {
      return fs.readFileSync(appIdPath, 'utf-8').trim();
    }
    const appId = crypto.randomUUID();
    fs.mkdirSync(path.dirname(appIdPath), { recursive: true });
    fs.writeFileSync(appIdPath, appId, { mode: 0o600 });
    return appId;
  }

  private getDeviceId(): string {
    return `${os.hostname()}-${os.platform()}-${os.arch()}`;
  }

  /**
   * Encrypt a JSON payload using AES-256-GCM.
   * Key: SHA-256 hash of 'certs.neuronest.cc'
   * IV: random 12 bytes
   * Output: base64url-encoded string of iv + ciphertext + authTag
   */
  private encryptParams(payload: Record<string, string>): string {
    const key = crypto.createHash('sha256').update('certs.neuronest.cc').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(payload);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const combined = Buffer.concat([iv, encrypted, authTag]);
    return combined.toString('base64url');
  }

  private notifyBrowserError(): void {
    const error = new Error(
      'Could not open system browser. WebAuthn requires a system browser with platform authenticator support.'
    );
    this.events.onError?.(error);

    // Attempt to notify all open Electron windows
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send('auth-status-update', {
          type: 'error',
          message: 'Could not open system browser. Please ensure a default browser is configured.',
        });
      }
    } catch {
      // BrowserWindow may not be available in all contexts
    }
  }
}
