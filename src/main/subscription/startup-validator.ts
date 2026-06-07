/**
 * Startup license validation for NeuroNest.
 *
 * On app start, validates the user's license key against the Stripe Worker.
 * Sends subscription status updates to the Renderer via BrowserWindow.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import { BrowserWindow } from 'electron';
import crypto from 'node:crypto';

const WORKER_URL = 'https://payments.neuronest.cc';
const BEARER_TOKEN_KEY = 'payments.neuronest.cc';

function getBearerToken(): string {
  return crypto
    .createHmac('sha256', BEARER_TOKEN_KEY)
    .update(BEARER_TOKEN_KEY)
    .digest('hex');
}

/**
 * Validates the user's license key on startup and sends the result to the Renderer.
 *
 * This function is designed to be fire-and-forget: it never throws and handles
 * all errors internally. Network errors are logged and silently ignored so the
 * app retains the existing plan until the next startup.
 *
 * @param mainWindow - The BrowserWindow to send status updates to
 * @param licenseKey - The user's license key from User_Profile
 * @param appId - The app instance ID from User_Profile
 */
export async function validateLicenseOnStartup(
  mainWindow: BrowserWindow,
  licenseKey: string,
  appId: string,
): Promise<void> {
  try {
    const response = await fetch(`${WORKER_URL}/api/license/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getBearerToken()}`,
      },
      body: JSON.stringify({ licenseKey, appId }),
    });

    const data = (await response.json()) as {
      valid?: boolean;
      plan?: string;
      status?: string;
      email?: string;
      licenseKey?: string;
      subscriptionId?: string;
      currentPeriodEnd?: string;
    };

    if (data.status === 'active' || data.valid === true) {
      // License is valid (either active Stripe subscription or valid activation code)
      // Send the plan from the API response, or default to professional if valid
      const validPlan = data.plan || 'professional';
      mainWindow.webContents.send('subscription-status-update', {
        status: 'active',
        plan: validPlan === 'enterprise' ? 'enterprise' : validPlan === 'community' ? 'community' : 'professional',
      });
    } else {
      // Only downgrade if the API explicitly says the license is invalid
      // Network errors are handled in the catch block (retain existing plan)
      mainWindow.webContents.send('subscription-status-update', {
        status: data.status ?? 'invalid',
        plan: data.plan || 'community',
      });
    }
  } catch (err: unknown) {
    // Requirement 7.4: network error — retain existing plan, log warning, retry next startup
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[StartupValidator] License validation failed (will retry next startup):', message);
  }
}
