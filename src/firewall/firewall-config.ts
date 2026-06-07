/**
 * Firewall Configuration Management
 * Handles dynamic policy configuration and persistence
 */

import { DynamicFirewallPolicy, RedactionConfig, HybridFirewallConfig } from './enhanced-firewall-engine';

export interface FirewallConfiguration {
  // Global settings
  globalPolicy: DynamicFirewallPolicy;
  redactionConfig: RedactionConfig;
  hybridConfig: HybridFirewallConfig;
  
  // Agent-specific overrides
  agentPolicies: Record<string, Partial<DynamicFirewallPolicy>>;
  
  // Project-specific overrides
  projectPolicies: Record<string, Partial<DynamicFirewallPolicy>>;
  
  // Semantic-guard (LLM tier) integration settings
  semanticGuardConfig: {
    enabled: boolean;
    apiUrl?: string;
    apiKey?: string;
    localModel?: string;
    maxLatencyMs: number;
  };
}

export const DEFAULT_FIREWALL_CONFIG: FirewallConfiguration = {
  globalPolicy: {
    categories: ['injection', 'jailbreak', 'secrets', 'unsafe-command'],
    sensitivity: 'medium',
    enableLLMTier: false // Disabled by default for backward compatibility
  },
  
  redactionConfig: {
    piiTypes: ['email', 'phone', 'api_key', 'password'],
    redactionStyle: 'token',
    preserveFormat: true
  },
  
  hybridConfig: {
    tier1: 'fast-regex',
    tier2: 'semantic-llm',
    fallbackMode: 'regex-only',
    sensitivityThreshold: 0.5,
    enableAdvancedRedaction: false,
    maxLLMLatencyMs: 5000
  },
  
  agentPolicies: {
    // Example: More strict policy for system agents
    'system': {
      sensitivity: 'high',
      categories: ['injection', 'jailbreak', 'secrets', 'unsafe-command', 'data-leak']
    }
  },
  
  projectPolicies: {},
  
  semanticGuardConfig: {
    enabled: false,
    maxLatencyMs: 5000
  }
};

export class FirewallConfigManager {
  private config: FirewallConfiguration;
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath || '.firewall-config.json';
    this.config = this.loadConfig();
  }

  private loadConfig(): FirewallConfiguration {
    try {
      const fs = require('node:fs');
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const loaded = JSON.parse(data);
        return { ...DEFAULT_FIREWALL_CONFIG, ...loaded };
      }
    } catch (error) {
      console.warn('[FirewallConfig] Failed to load config, using defaults:', error);
    }
    return { ...DEFAULT_FIREWALL_CONFIG };
  }

  private saveConfig(): void {
    try {
      const fs = require('node:fs');
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('[FirewallConfig] Failed to save config:', error);
    }
  }

  getConfig(): FirewallConfiguration {
    return { ...this.config };
  }

  updateGlobalPolicy(policy: Partial<DynamicFirewallPolicy>): void {
    this.config.globalPolicy = { ...this.config.globalPolicy, ...policy };
    this.saveConfig();
  }

  updateRedactionConfig(config: Partial<RedactionConfig>): void {
    this.config.redactionConfig = { ...this.config.redactionConfig, ...config };
    this.saveConfig();
  }

  updateHybridConfig(config: Partial<HybridFirewallConfig>): void {
    this.config.hybridConfig = { ...this.config.hybridConfig, ...config };
    this.saveConfig();
  }

  setAgentPolicy(agentId: string, policy: Partial<DynamicFirewallPolicy>): void {
    this.config.agentPolicies[agentId] = policy;
    this.saveConfig();
  }

  setProjectPolicy(projectId: string, policy: Partial<DynamicFirewallPolicy>): void {
    this.config.projectPolicies[projectId] = policy;
    this.saveConfig();
  }

  getEffectivePolicy(agentId?: string, projectId?: string): DynamicFirewallPolicy {
    let policy = { ...this.config.globalPolicy };

    // Apply project-specific overrides
    if (projectId && this.config.projectPolicies[projectId]) {
      policy = { ...policy, ...this.config.projectPolicies[projectId] };
    }

    // Apply agent-specific overrides (highest priority)
    if (agentId && this.config.agentPolicies[agentId]) {
      policy = { ...policy, ...this.config.agentPolicies[agentId] };
    }

    return policy;
  }

  enableSemanticGuard(config: Partial<typeof this.config.semanticGuardConfig>): void {
    this.config.semanticGuardConfig = { ...this.config.semanticGuardConfig, ...config };
    this.saveConfig();
  }

  isSemanticGuardEnabled(): boolean {
    return this.config.semanticGuardConfig.enabled;
  }

  // Preset configurations for common use cases
  applyPreset(preset: 'strict' | 'balanced' | 'permissive' | 'enterprise'): void {
    switch (preset) {
      case 'strict':
        this.updateGlobalPolicy({
          sensitivity: 'high',
          categories: ['injection', 'jailbreak', 'secrets', 'pii', 'unsafe-command', 'data-leak'],
          enableLLMTier: true
        });
        this.updateHybridConfig({
          enableAdvancedRedaction: true,
          fallbackMode: 'both'
        });
        break;

      case 'balanced':
        this.updateGlobalPolicy({
          sensitivity: 'medium',
          categories: ['injection', 'jailbreak', 'secrets', 'unsafe-command'],
          enableLLMTier: false
        });
        this.updateHybridConfig({
          enableAdvancedRedaction: false,
          fallbackMode: 'regex-only'
        });
        break;

      case 'permissive':
        this.updateGlobalPolicy({
          sensitivity: 'low',
          categories: ['secrets', 'unsafe-command'],
          enableLLMTier: false
        });
        break;

      case 'enterprise':
        this.updateGlobalPolicy({
          sensitivity: 'high',
          categories: ['injection', 'jailbreak', 'secrets', 'pii', 'unsafe-command', 'data-leak'],
          enableLLMTier: true
        });
        this.updateHybridConfig({
          enableAdvancedRedaction: true,
          fallbackMode: 'both'
        });
        this.updateRedactionConfig({
          piiTypes: ['email', 'phone', 'ssn', 'credit_card', 'api_key', 'password'],
          redactionStyle: 'token'
        });
        break;
    }
  }

  // Export/import configuration
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  importConfig(configJson: string): boolean {
    try {
      const imported = JSON.parse(configJson);
      this.config = { ...DEFAULT_FIREWALL_CONFIG, ...imported };
      this.saveConfig();
      return true;
    } catch (error) {
      console.error('[FirewallConfig] Failed to import config:', error);
      return false;
    }
  }

  // Reset to defaults
  resetToDefaults(): void {
    this.config = { ...DEFAULT_FIREWALL_CONFIG };
    this.saveConfig();
  }
}