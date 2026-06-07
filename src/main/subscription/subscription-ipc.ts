/**
 * IPC handlers for Stripe subscription management.
 *
 * Registers invoke channels:
 *   - stripe:create-checkout-session
 *   - stripe:poll-license
 *   - stripe:cancel-subscription
 *   - stripe:validate-license
 *
 * Requirements: 1.1, 1.2, 1.4, 1.5, 6.3, 6.4
 */

import { ipcMain } from 'electron';
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
 * Helper to make authenticated requests to the Stripe Worker.
 */
async function workerFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${WORKER_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getBearerToken()}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = (data as { error?: string }).error ?? `Worker returned ${response.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

/**
 * Register all subscription-related IPC handlers.
 */
export function registerSubscriptionIPC(): void {
  // stripe:create-checkout-session
  // Requirement 1.1, 1.2, 1.4, 1.5
  ipcMain.handle(
    'stripe:create-checkout-session',
    async (_event, args: { email: string; appId: string; deviceId: string }) => {
      try {
        const data = (await workerFetch('/api/checkout/create-session', {
          email: args.email,
          appId: args.appId,
          deviceId: args.deviceId,
          plan: 'professional',
        })) as { url: string };

        return { success: true, url: data.url };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[SubscriptionIPC] stripe:create-checkout-session error:', message);
        return { success: false, error: message };
      }
    },
  );

  // stripe:poll-license
  // Requirement 1.1
  ipcMain.handle('stripe:poll-license', async (_event, args: { appId: string }) => {
    try {
      const data = (await workerFetch('/api/license/validate', {
        appId: args.appId,
      })) as {
        valid: boolean;
        plan?: string;
        licenseKey?: string;
        subscriptionId?: string;
        customerId?: string;
        currentPeriodEnd?: string;
      };

      return { success: true, ...data };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[SubscriptionIPC] stripe:poll-license error:', message);
      return { success: false, error: message };
    }
  });

  // stripe:cancel-subscription
  // Requirement 6.3, 6.4
  ipcMain.handle(
    'stripe:cancel-subscription',
    async (_event, args: { licenseKey: string; subscriptionId: string }) => {
      try {
        await workerFetch('/api/license/revoke', {
          licenseKey: args.licenseKey,
          subscriptionId: args.subscriptionId,
        });

        return { success: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[SubscriptionIPC] stripe:cancel-subscription error:', message);
        return { success: false, error: message };
      }
    },
  );

  // stripe:validate-license
  // Requirement 1.1
  ipcMain.handle(
    'stripe:validate-license',
    async (_event, args: { licenseKey: string; appId: string }) => {
      try {
        const data = (await workerFetch('/api/license/validate', {
          licenseKey: args.licenseKey,
          appId: args.appId,
        })) as {
          valid: boolean;
          plan?: string;
          status?: string;
        };

        return { success: true, ...data };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[SubscriptionIPC] stripe:validate-license error:', message);
        return { success: false, error: message };
      }
    },
  );

  // enterprise:contact-sales
  // Requirement 7.1, 7.3, 7.4
  ipcMain.handle(
    'enterprise:contact-sales',
    async (
      _event,
      args: {
        firstName: string;
        lastName: string;
        email: string;
        phone?: string;
        appId: string;
        role: string;
        deviceId: string;
        currentPlan: string;
      },
    ) => {
      try {
        await workerFetch('/api/enterprise/contact-sales', {
          firstName: args.firstName,
          lastName: args.lastName,
          email: args.email,
          phone: args.phone,
          appId: args.appId,
          role: args.role,
          deviceId: args.deviceId,
          currentPlan: args.currentPlan,
        });

        return { success: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[SubscriptionIPC] enterprise:contact-sales error:', message);
        return { success: false, error: message };
      }
    },
  );
}
