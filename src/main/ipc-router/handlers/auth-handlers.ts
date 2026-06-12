/**
 * Auth Domain IPC Handlers
 *
 * Handles authentication and licensing IPC operations: license validation,
 * activation, pro-mode state management, and referral system.
 *
 * Migrated from src/main/ipc.ts — preserves backward-compatible channel names.
 */

import { z } from 'zod';
import type { IPCRegistry } from '../registry.js';

// ─── Request/Response Schemas ───────────────────────────────────

const EmptyRequest = z.object({}).passthrough();

const LicenseFetchByCodeRequest = z.object({
  code: z.string(),
});

const LicenseFetchByCodeResponse = z.object({
  success: z.boolean(),
  license: z.unknown().optional(),
  error: z.string().optional(),
});

const LicenseValidateRequest = z.object({
  key: z.string().optional(),
}).passthrough();

const LicenseValidateResponse = z.object({
  valid: z.boolean(),
  features: z.array(z.string()).optional(),
  expiresAt: z.string().optional(),
  error: z.string().optional(),
});

const LicenseGenerateRequest = z.object({
  plan: z.string().optional(),
}).passthrough();

const LicenseGenerateResponse = z.object({
  success: z.boolean(),
  key: z.string().optional(),
  error: z.string().optional(),
});

const LicenseMarkUsedRequest = z.object({
  key: z.string(),
});

const LicenseMarkUsedResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const LicenseGetStoredResponse = z.object({
  key: z.string().optional(),
  valid: z.boolean().optional(),
  features: z.array(z.string()).optional(),
  error: z.string().optional(),
}).nullable();

const LicenseUpdateFeaturesRequest = z.object({
  key: z.string(),
  features: z.array(z.string()),
});

const LicenseUpdateFeaturesResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const LicenseGetAppIdResponse = z.object({
  appId: z.string(),
});

const ReferralSendInviteRequest = z.object({
  email: z.string(),
  referralCode: z.string().optional(),
});

const ReferralSendInviteResponse = z.object({
  success: z.boolean(),
  inviteId: z.string().optional(),
  error: z.string().optional(),
});

const ReferralGetStatsResponse = z.object({
  totalInvites: z.number(),
  acceptedInvites: z.number(),
  pendingInvites: z.number(),
  rewards: z.array(z.unknown()).optional(),
});

const ReferralDeleteInviteRequest = z.object({
  inviteId: z.string(),
});

const ReferralDeleteInviteResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const ReferralGetDeletedInvitesResponse = z.array(z.object({
  id: z.string(),
  email: z.string().optional(),
  deletedAt: z.string().optional(),
}));

const ReferralWithdrawRequest = z.object({
  amount: z.number().optional(),
}).passthrough();

const ReferralWithdrawResponse = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

const ProModeHydrateRequest = z.object({
  enabled: z.boolean().optional(),
  authToken: z.string().optional(),
  endpoint: z.string().optional(),
}).passthrough();

const ProModeHydrateResponse = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const ProModeSetStateRequest = z.object({
  enabled: z.boolean().optional(),
  authToken: z.string().optional(),
  endpoint: z.string().optional(),
}).passthrough();

const ProModeSetStateResponse = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const ProModeGetStateResponse = z.object({
  enabled: z.boolean(),
  authToken: z.string().optional(),
  endpoint: z.string().optional(),
});

// ─── Handler Registration ───────────────────────────────────────

/**
 * Register all auth-domain IPC handlers with the registry.
 *
 * Handlers preserve the original channel names from src/main/ipc.ts
 * to maintain backward compatibility with the renderer process.
 */
export function registerAuthHandlers(registry: IPCRegistry): void {
  // 1. Fetch license by code
  registry.register({
    channel: 'license:fetch-by-code',
    requestSchema: LicenseFetchByCodeRequest,
    responseSchema: LicenseFetchByCodeResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'License service not available in router migration' };
    },
  });

  // 2. Validate license
  registry.register({
    channel: 'license:validate',
    requestSchema: LicenseValidateRequest,
    responseSchema: LicenseValidateResponse,
    handler: async (_event, _req) => {
      return { valid: false, error: 'License service not available in router migration' };
    },
  });

  // 3. Generate license
  registry.register({
    channel: 'license:generate',
    requestSchema: LicenseGenerateRequest,
    responseSchema: LicenseGenerateResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'License service not available in router migration' };
    },
  });

  // 4. Mark license as used
  registry.register({
    channel: 'license:mark-used',
    requestSchema: LicenseMarkUsedRequest,
    responseSchema: LicenseMarkUsedResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'License service not available in router migration' };
    },
  });

  // 5. Get stored license
  registry.register({
    channel: 'license:get-stored',
    requestSchema: EmptyRequest,
    responseSchema: LicenseGetStoredResponse,
    handler: async (_event, _req) => {
      return null;
    },
  });

  // 6. Update license features
  registry.register({
    channel: 'license:update-features',
    requestSchema: LicenseUpdateFeaturesRequest,
    responseSchema: LicenseUpdateFeaturesResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'License service not available in router migration' };
    },
  });

  // 7. Get app ID for licensing
  registry.register({
    channel: 'license:get-app-id',
    requestSchema: EmptyRequest,
    responseSchema: LicenseGetAppIdResponse,
    handler: async (_event, _req) => {
      return { appId: 'unknown' };
    },
  });

  // 8. Send referral invite
  registry.register({
    channel: 'referral:send-invite',
    requestSchema: ReferralSendInviteRequest,
    responseSchema: ReferralSendInviteResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Referral service not available in router migration' };
    },
  });

  // 9. Get referral stats
  registry.register({
    channel: 'referral:get-stats',
    requestSchema: EmptyRequest,
    responseSchema: ReferralGetStatsResponse,
    handler: async (_event, _req) => {
      return { totalInvites: 0, acceptedInvites: 0, pendingInvites: 0 };
    },
  });

  // 10. Delete a referral invite
  registry.register({
    channel: 'referral:delete-invite',
    requestSchema: ReferralDeleteInviteRequest,
    responseSchema: ReferralDeleteInviteResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Referral service not available in router migration' };
    },
  });

  // 11. Get deleted invites
  registry.register({
    channel: 'referral:get-deleted-invites',
    requestSchema: EmptyRequest,
    responseSchema: ReferralGetDeletedInvitesResponse,
    handler: async (_event, _req) => {
      return [];
    },
  });

  // 12. Withdraw referral rewards
  registry.register({
    channel: 'referral:withdraw',
    requestSchema: ReferralWithdrawRequest,
    responseSchema: ReferralWithdrawResponse,
    handler: async (_event, _req) => {
      return { success: false, error: 'Referral service not available in router migration' };
    },
  });

  // 13. Pro-mode state hydration (renderer → main on boot)
  registry.register({
    channel: 'pro-mode:hydrate',
    requestSchema: ProModeHydrateRequest,
    responseSchema: ProModeHydrateResponse,
    handler: async (_event, _req) => {
      return { ok: true };
    },
  });

  // 14. Pro-mode set state (partial updates)
  registry.register({
    channel: 'pro-mode:set-state',
    requestSchema: ProModeSetStateRequest,
    responseSchema: ProModeSetStateResponse,
    handler: async (_event, _req) => {
      return { ok: true };
    },
  });

  // 15. Pro-mode get state
  registry.register({
    channel: 'pro-mode:get-state',
    requestSchema: EmptyRequest,
    responseSchema: ProModeGetStateResponse,
    handler: async (_event, _req) => {
      return { enabled: false, authToken: '', endpoint: '' };
    },
  });
}
