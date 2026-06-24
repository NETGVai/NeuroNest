/**
 * SuperagentConfig — Top-level configuration type for all Superagent features.
 *
 * Combines feature flags (Partial<FeatureGateFlags>) with subsystem-specific
 * configuration blocks. When passed in AgentLoopConfig, it triggers instantiation
 * of the FeatureGateSystem in the AgentLoopController constructor.
 *
 * When this config is absent, the Agent Loop behaves identically to the current version
 * with zero additional overhead (Req 0.6).
 *
 * Requirements: 0.1, 0.2, 0.3, 0.6
 */

import type { FeatureGateFlags } from './feature-gate-config.js';
import type { ThreatModelProfile } from '../runtime-security/threat-modeler.js';

// ─── Subsystem-specific config blocks ───────────────────────────

/** Configuration for cost tracking subsystem (Req 1) */
export interface CostTrackingConfig {
  pricingTablePath?: string;
  sessionLimitUsd?: number;
  dailyLimitUsd?: number;
  warningThreshold?: number; // 0.0–1.0, default 0.8
}

/** Configuration for checkpoint/durability subsystem (Req 2) */
export interface CheckpointConfig {
  directory?: string;
  maxDiskUsageMb?: number; // default 500
}

/** Configuration for vulnerability blocking subsystem (Req 3) */
export interface VulnerabilityBlockingConfig {
  fallbackDatabaseUrl?: string;
  cacheTtlHours?: number; // default 24
}

/** Configuration for dependency grounding subsystem (Req 4) */
export interface DependencyGroundingConfig {
  cacheTtlDays?: number; // default 7
  maxCacheSizeMb?: number; // default 200
}

/** Configuration for memory persistence subsystem (Req 5) */
export interface MemoryPersistenceConfig {
  directory?: string; // default '.neuronest/memory/'
  maxFileSizeKb?: number; // default 50
  totalDiskBudgetMb?: number; // default 10
}

/** Configuration for LSP intelligence subsystem (Req 6) */
export interface LspIntelligenceConfig {
  preferLspOverGrep?: boolean; // default true
}

/** Configuration for worktree isolation subsystem (Req 7) */
export interface WorktreeIsolationConfig {
  cleanupOnFailure?: boolean; // default true
}

/** Configuration for AST locking subsystem (Req 8) */
export interface AstLockingConfig {
  lockTimeoutSeconds?: number; // default 300
}

/** Configuration for credential vault subsystem (Req 9) */
export interface CredentialVaultConfig {
  keySource?: 'os-keychain' | 'master-password';
}

/** Configuration for model routing subsystem (Req 10) */
export interface ModelRoutingConfig {
  routingTable?: Record<string, { model: string; provider: string }[]>;
}

/** Configuration for self-improvement / behavioral rules subsystem (Req 11) */
export interface SelfImprovementConfig {
  rulesFilePath?: string;
  minSessionsBeforeRule?: number; // default 3
}

/** Configuration for parallel agents subsystem (Req 13) */
export interface ParallelAgentsConfig {
  maxConcurrent?: number; // default 4
}

/** Configuration for sandbox subsystem (Req 18) */
export interface SandboxConfig {
  cpuLimitMs?: number;
  memoryLimitMb?: number;
  diskLimitMb?: number;
  networkPolicy?: 'deny-all' | 'allowlist';
  allowedDomains?: string[];
}

/** Configuration for headless mode subsystem (Req 19) */
export interface HeadlessModeConfig {
  permissionPolicy?: 'deny-all' | 'auto-approve-read' | 'auto-approve-all';
  outputFormat?: 'json' | 'text';
  timeoutMs?: number;
}

/** Configuration for provider failover subsystem (Req 17) */
export interface ProviderFailoverConfig {
  failoverChain?: { provider: string; model: string }[];
  initialBackoffMs?: number; // default 1000
  maxBackoffMs?: number; // default 30000
  backoffFactor?: number; // default 2
}

/** Configuration for specialist roles subsystem (Req 15) */
export interface SpecialistRolesConfig {
  customRoles?: {
    id: string;
    name: string;
    systemPrompt: string;
    allowedTools: string[];
    filePermissions: string[];
  }[];
}

// ─── Runtime Security subsystem config blocks (Req 8.1, 8.2) ───

/** Configuration for hackability scoring runtime security subsystem */
export interface RuntimeSecurityHackabilityConfig {
  configPath?: string;           // default: '.neuronest-hackability.json'
  criticalThreshold?: number;    // default: 75
  warningThreshold?: number;     // default: 40
}

/** Configuration for AI-aware threat modeling runtime security subsystem */
export interface RuntimeSecurityThreatModelingConfig {
  profile?: ThreatModelProfile;
}

/** Configuration for real-time code analysis runtime security subsystem */
export interface RuntimeSecurityRealtimeConfig {
  maxLatencyMs?: number;         // default: 200
  blockOnCriticalOnly?: boolean; // default: false
}

/** Configuration for attack path mapping runtime security subsystem */
export interface RuntimeSecurityAttackPathConfig {
  criticalThreshold?: number;    // default: 80
}

/** Configuration for security evidence store runtime security subsystem */
export interface RuntimeSecurityEvidenceConfig {
  retentionDays?: number;        // default: 90
}

/** Configuration for AI security rule engine runtime security subsystem */
export interface RuntimeSecurityAIRulesConfig {
  rulesPath?: string;            // default: '.neuronest-ai-security-rules.json'
}

// ─── SuperagentConfig (top-level) ───────────────────────────────

/**
 * Top-level configuration for the Superagent Upgrade.
 *
 * - Feature flags: Partial<FeatureGateFlags> determines which subsystems are active
 * - Subsystem configs: optional detailed configuration per subsystem
 *
 * When no flags are enabled (all default to false), the feature gate system
 * short-circuits with a null-check and imposes zero overhead (Req 0.2).
 */
export interface SuperagentConfig {
  /** Feature flags — all default to false when unspecified */
  flags?: Partial<FeatureGateFlags>;

  /** Subsystem-specific configuration blocks */
  costTracking?: CostTrackingConfig;
  checkpoint?: CheckpointConfig;
  vulnerabilityBlocking?: VulnerabilityBlockingConfig;
  dependencyGrounding?: DependencyGroundingConfig;
  memoryPersistence?: MemoryPersistenceConfig;
  lspIntelligence?: LspIntelligenceConfig;
  worktreeIsolation?: WorktreeIsolationConfig;
  astLocking?: AstLockingConfig;
  credentialVault?: CredentialVaultConfig;
  modelRouting?: ModelRoutingConfig;
  selfImprovement?: SelfImprovementConfig;
  parallelAgents?: ParallelAgentsConfig;
  sandbox?: SandboxConfig;
  headlessMode?: HeadlessModeConfig;
  providerFailover?: ProviderFailoverConfig;
  specialistRoles?: SpecialistRolesConfig;

  /** Runtime security subsystem configuration blocks */
  runtimeSecurityHackability?: RuntimeSecurityHackabilityConfig;
  runtimeSecurityThreatModeling?: RuntimeSecurityThreatModelingConfig;
  runtimeSecurityRealtime?: RuntimeSecurityRealtimeConfig;
  runtimeSecurityAttackPath?: RuntimeSecurityAttackPathConfig;
  runtimeSecurityEvidence?: RuntimeSecurityEvidenceConfig;
  runtimeSecurityAIRules?: RuntimeSecurityAIRulesConfig;
}
