/**
 * IPC handlers for the WebAuthn production auth system.
 *
 * Registers invoke channels:
 *   - auth-start-registration
 *   - auth-start-login
 *   - auth-get-status
 *   - auth-renew-cert
 *   - auth-get-session
 *
 * Provides a helper for the send channel:
 *   - auth-status-update
 */

import { ipcMain, type BrowserWindow } from 'electron';
import type { WebAuthnFlowController } from './flow-controller';
import type { CertificateManager } from './certificate-manager';
import type { AuthServer } from './auth-server';
import type { AuthSessionManager } from './session-manager';
import type { CredentialStore } from './credential-store';

export interface AuthIPCDeps {
  flowController: WebAuthnFlowController;
  certManager: CertificateManager;
  authServer: AuthServer;
  sessionManager: AuthSessionManager;
  credentialStore?: CredentialStore;
  mainWindow: BrowserWindow;
}

/**
 * Send an auth status update to the renderer process.
 */
export function sendAuthStatusUpdate(
  mainWindow: BrowserWindow,
  data: { type: string; message?: string; [key: string]: unknown },
): void {
  mainWindow.webContents.send('auth-status-update', data);
}

/**
 * Register all auth-related IPC handlers.
 */
export function registerAuthIPC(deps: AuthIPCDeps): void {
  const { flowController, certManager, authServer, sessionManager, mainWindow } = deps;

  ipcMain.handle('auth-start-registration', async (_event, args: { firstName: string; lastName: string; email: string }) => {
    try {
      await flowController.startRegistration({ firstName: args.firstName, lastName: args.lastName, email: args.email });
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-start-registration error:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('auth-start-login', async (_event, args: { email: string }) => {
    try {
      await flowController.startLogin({ email: args.email });
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-start-login error:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('auth-get-status', async () => {
    try {
      const certInfo = certManager.getCertInfo();
      const serverStatus = authServer.getStatus();
      return {
        success: true,
        cert: certInfo
          ? {
              issuer: certInfo.issuer,
              domain: certInfo.domain,
              expiryDate: certInfo.expiryDate.toISOString(),
              daysRemaining: certInfo.daysRemaining,
            }
          : null,
        server: serverStatus,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-get-status error:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('auth-renew-cert', async () => {
    try {
      await certManager.provisionCert();
      sendAuthStatusUpdate(mainWindow, { type: 'cert-renewed' });
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-renew-cert error:', message);
      sendAuthStatusUpdate(mainWindow, { type: 'cert-renewal-failed', message });
      return { success: false, error: message };
    }
  });

  ipcMain.handle('auth-get-session', async () => {
    try {
      const secret = await sessionManager.ensureSecret();
      const flowState = flowController.getFlowState();
      return {
        success: true,
        flowState,
        hasSecret: secret.length > 0,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-get-session error:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('auth-get-registered-emails', async () => {
    try {
      if (!deps.credentialStore) {
        return { success: true, emails: [] };
      }
      const credentials = deps.credentialStore.getCredentialsByRpId('neuronest.cc');
      const uniqueEmails = [...new Set(credentials.map(c => c.userId))];
      return { success: true, emails: uniqueEmails };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-get-registered-emails error:', message);
      return { success: false, emails: [] };
    }
  });

  ipcMain.handle('auth-restart-server', async () => {
    try {
      // Re-provision cert if needed and restart the auth server
      if (!certManager.hasValidCert()) {
        await certManager.provisionCert();
      }
      const certInfo = certManager.getCertInfo();
      if (!certInfo) {
        return { success: false, error: 'No valid certificate available' };
      }
      await authServer.start(certInfo);
      certManager.startHealthMonitor();
      console.log('[AuthIPC] Auth server restarted for login');
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[AuthIPC] auth-restart-server error:', message);
      return { success: false, error: message };
    }
  });
}
