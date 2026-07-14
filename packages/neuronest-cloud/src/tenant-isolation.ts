/**
 * Tenant Isolation — Multi-tenant data separation
 *
 * Enforces per-project/team data isolation for the cloud agent platform.
 * All data access is scoped to tenant boundaries.
 *
 * Task 22.1
 */

export interface TenantContext {
  tenantId: string;
  projectId: string;
  apiKey: string;
  teamId?: string;
  plan?: 'professional' | 'enterprise';
}

export interface TenantQuota {
  maxTasks: number;
  maxConcurrentTasks: number;
  maxWebhooks: number;
  maxCronTriggers: number;
  maxStorageMb: number;
}

const DEFAULT_QUOTAS: Record<string, TenantQuota> = {
  professional: {
    maxTasks: 1000,
    maxConcurrentTasks: 5,
    maxWebhooks: 10,
    maxCronTriggers: 10,
    maxStorageMb: 500,
  },
  enterprise: {
    maxTasks: 10000,
    maxConcurrentTasks: 50,
    maxWebhooks: 100,
    maxCronTriggers: 100,
    maxStorageMb: 5000,
  },
};

/**
 * Multi-tenant isolation enforcement layer.
 * Ensures all data access is scoped to tenant + project boundaries.
 */
export class TenantIsolation {
  /**
   * Check if a tenant context can access a resource belonging to the given tenant/project.
   */
  static canAccess(ctx: TenantContext, resourceTenantId: string, resourceProjectId: string): boolean {
    // Strict tenant boundary check
    if (ctx.tenantId !== resourceTenantId) {
      return false;
    }

    // Project-level isolation within a tenant
    if (ctx.projectId !== 'default' && ctx.projectId !== resourceProjectId) {
      return false;
    }

    return true;
  }

  /**
   * Create a tenant-scoped key prefix for storage operations.
   */
  static scopeKey(ctx: TenantContext, key: string): string {
    return `tenant:${ctx.tenantId}:project:${ctx.projectId}:${key}`;
  }

  /**
   * Get quota limits for a tenant based on their plan tier.
   */
  static getQuota(ctx: TenantContext): TenantQuota {
    const plan = ctx.plan || 'professional';
    return DEFAULT_QUOTAS[plan] || DEFAULT_QUOTAS.professional;
  }

  /**
   * Validate that a tenant context has the required plan tier.
   */
  static requirePlan(ctx: TenantContext, requiredPlan: 'professional' | 'enterprise'): boolean {
    if (requiredPlan === 'professional') {
      return ctx.plan === 'professional' || ctx.plan === 'enterprise';
    }
    return ctx.plan === 'enterprise';
  }

  /**
   * Sanitize tenant-scoped data for logging (redact sensitive fields).
   */
  static sanitizeForLog(ctx: TenantContext): Record<string, string> {
    return {
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      apiKey: `${ctx.apiKey.slice(0, 4)}****`,
      plan: ctx.plan || 'unknown',
    };
  }
}
