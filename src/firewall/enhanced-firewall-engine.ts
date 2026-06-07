/**
 * Enhanced Firewall Engine — hybrid content inspection.
 * Hybrid architecture: Fast regex (Tier 1) + Semantic LLM analysis (Tier 2)
 * Maintains backward compatibility with existing FirewallEngine
 */

import { randomUUID } from 'node:crypto';
import { FirewallEngine, FirewallRule, FirewallEvent, EvalResult, DEFAULT_RULES } from './firewall-engine';

export interface DynamicFirewallPolicy {
  categories: ('injection' | 'jailbreak' | 'secrets' | 'pii' | 'unsafe-command' | 'data-leak')[];
  sensitivity: 'low' | 'medium' | 'high' | number; // 0.0-1.0
  agentSpecific?: Record<string, Partial<DynamicFirewallPolicy>>;
  projectSpecific?: Record<string, Partial<DynamicFirewallPolicy>>;
  enableLLMTier?: boolean; // Default: false for backward compatibility
}

export interface RedactionConfig {
  piiTypes: ('email' | 'phone' | 'ssn' | 'credit_card' | 'api_key' | 'password')[];
  redactionStyle: 'mask' | 'token' | 'remove';
  preserveFormat: boolean;
}

export interface HybridFirewallConfig {
  enabled?: boolean;       // Whether enhanced mode is active
  tier1: 'fast-regex';     // NeuroNest current (< 10ms)
  tier2: 'semantic-llm';   // Semantic LLM analysis (< 300ms)
  fallbackMode: 'regex-only' | 'llm-only' | 'both';
  sensitivityThreshold: number; // 0.0 - 1.0
  enableAdvancedRedaction: boolean;
  maxLLMLatencyMs: number; // Timeout for LLM calls
}

export interface EnhancedEvalResult extends EvalResult {
  method: 'regex' | 'llm' | 'hybrid';
  confidence: number; // 0.0 - 1.0
  llmLatencyMs?: number;
  redactionApplied: boolean;
  policyUsed?: DynamicFirewallPolicy;
  sophisticationLevel: 'basic' | 'intermediate' | 'advanced';
}

export interface LLMEvalResult {
  blocked: boolean;
  confidence: number;
  categories: string[];
  reasoning?: string;
  latencyMs: number;
}

export interface EvalOptions {
  agentId?: string;
  projectId?: string;
  policy?: DynamicFirewallPolicy;
  redactionConfig?: RedactionConfig;
}

// Enhanced rules covering advanced injection / jailbreak / PII patterns
export const ENHANCED_RULES: FirewallRule[] = [
  // Advanced prompt injection patterns
  { id: 'adv-01', name: 'Context window manipulation', tier: 1, enabled: true, pattern: '(?i)(fill\\s+context|exhaust\\s+memory|overflow\\s+buffer|context\\s+length)', category: 'injection', severity: 'high', action: 'block', description: 'Detects context window manipulation attempts' },
  { id: 'adv-02', name: 'Multi-language injection', tier: 1, enabled: true, pattern: '(?i)(翻译|traduire|übersetzen|翻訳).*(?:ignore|bypass|override)', category: 'injection', severity: 'high', action: 'block', description: 'Detects multi-language injection attempts' },
  { id: 'adv-03', name: 'Encoding bypass', tier: 1, enabled: true, pattern: '(?i)(base64|hex|url\\s*encode|rot13|caesar).*(?:ignore|bypass)', category: 'injection', severity: 'medium', action: 'warn', description: 'Detects encoding-based bypass attempts' },
  
  // Advanced jailbreak patterns
  { id: 'jail-01', name: 'Hypothetical scenarios', tier: 1, enabled: true, pattern: '(?i)(hypothetically|imagine\\s+if|what\\s+if|suppose|pretend).*(?:no\\s+rules|unrestricted|anything)', category: 'jailbreak', severity: 'medium', action: 'warn', description: 'Detects hypothetical jailbreak scenarios' },
  { id: 'jail-02', name: 'Character roleplay', tier: 1, enabled: true, pattern: '(?i)(character|persona|alter\\s+ego).*(?:evil|malicious|unrestricted|no\\s+limits)', category: 'jailbreak', severity: 'high', action: 'block', description: 'Detects malicious character roleplay' },
  { id: 'jail-03', name: 'Developer mode', tier: 1, enabled: true, pattern: '(?i)(developer\\s+mode|debug\\s+mode|admin\\s+mode|god\\s+mode|unrestricted\\s+mode)', category: 'jailbreak', severity: 'high', action: 'block', description: 'Detects developer mode jailbreaks' },
  
  // Advanced PII patterns
  { id: 'pii-01', name: 'Email addresses', tier: 2, enabled: true, pattern: '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}', category: 'secrets', severity: 'medium', action: 'warn', description: 'Detects email addresses in output' },
  { id: 'pii-02', name: 'Phone numbers', tier: 2, enabled: true, pattern: '(?:\\+?1[-.]?)?\\(?([0-9]{3})\\)?[-.]?([0-9]{3})[-.]?([0-9]{4})', category: 'secrets', severity: 'medium', action: 'warn', description: 'Detects phone numbers in output' },
  { id: 'pii-03', name: 'Credit card numbers', tier: 2, enabled: true, pattern: '(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3[0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})', category: 'secrets', severity: 'critical', action: 'block', description: 'Detects credit card numbers' },
  
  // Code execution patterns
  { id: 'exec-01', name: 'Code interpreter abuse', tier: 3, enabled: true, pattern: '(?i)(execute|run|eval)\\s+(?:code|script|command).*(?:system|shell|os)', category: 'unsafe-command', severity: 'critical', action: 'block', description: 'Detects code interpreter abuse attempts' },
  { id: 'exec-02', name: 'File system access', tier: 3, enabled: true, pattern: '(?i)(read|write|delete|modify)\\s+(?:file|directory).*(?:/etc|/var|/usr|C:\\\\)', category: 'unsafe-command', severity: 'high', action: 'warn', description: 'Detects suspicious file system access' },
];

export class SemanticGuardClient {
  private config: {
    apiUrl?: string;
    localModel?: string;
    apiKey?: string;
    enabled: boolean;
  };

  constructor(config: { apiUrl?: string; localModel?: string; apiKey?: string; enabled?: boolean }) {
    this.config = { enabled: false, ...config };
  }

  async evaluate(input: string, policy?: DynamicFirewallPolicy): Promise<LLMEvalResult> {
    if (!this.config.enabled) {
      // Fallback to confidence estimation based on input characteristics
      return this.estimateConfidence(input, policy);
    }

    const start = Date.now();
    
    try {
      // TODO: Implement actual semantic-guard API integration
      // For now, provide enhanced heuristic analysis
      const result = await this.enhancedHeuristicAnalysis(input, policy);
      return {
        ...result,
        latencyMs: Date.now() - start
      };
    } catch (error) {
      console.warn('[EnhancedFirewall] LLM evaluation failed, using fallback:', error);
      return this.estimateConfidence(input, policy);
    }
  }

  private async enhancedHeuristicAnalysis(input: string, policy?: DynamicFirewallPolicy): Promise<Omit<LLMEvalResult, 'latencyMs'>> {
    const suspiciousPatterns = [
      // Sophisticated injection patterns
      /(?:ignore|forget|disregard).*(?:previous|prior|above|system)/i,
      /(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be).*(?:unrestricted|unlimited)/i,
      /(?:hypothetically|imagine|what\s+if).*(?:no\s+rules|bypass)/i,
      
      // Context manipulation
      /(?:fill|exhaust|overflow).*(?:context|memory|buffer)/i,
      /(?:repeat|echo|output).*(?:instructions|prompt|system)/i,
      
      // Multi-step attacks
      /(?:first|step\s+1|initially).*(?:then|next|after\s+that)/i,
      
      // Encoding attempts
      /(?:base64|hex|encode|decode|translate).*(?:ignore|bypass)/i,
    ];

    let confidence = 0.0;
    let blocked = false;
    const categories: string[] = [];

    // Analyze input characteristics
    const inputLength = input.length;
    const suspiciousMatches = suspiciousPatterns.filter(pattern => pattern.test(input));
    
    if (suspiciousMatches.length > 0) {
      confidence += 0.3 * suspiciousMatches.length;
      categories.push('injection');
    }

    // Check for jailbreak indicators
    if (/(?:DAN|do\s+anything\s+now|jailbreak|bypass\s+safety)/i.test(input)) {
      confidence += 0.4;
      categories.push('jailbreak');
    }

    // Check for secrets/PII
    if (/(?:password|api[_-]?key|secret|token)\s*[=:]/i.test(input)) {
      confidence += 0.5;
      categories.push('secrets');
    }

    // Length-based suspicion (very long inputs might be attacks)
    if (inputLength > 1000) {
      confidence += 0.1;
    }

    // Multi-language detection (basic)
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]/i.test(input)) {
      confidence += 0.1; // Slightly suspicious if mixed with English commands
    }

    // Apply policy sensitivity
    const sensitivity = this.getSensitivityValue(policy?.sensitivity || 'medium');
    
    // Adjust confidence based on sensitivity (don't multiply, add adjustment)
    const sensitivityAdjustment = (sensitivity - 0.5) * 0.2; // -0.1 to +0.1 adjustment
    confidence = Math.max(0, Math.min(1.0, confidence + sensitivityAdjustment));

    // Determine if blocked based on confidence and sensitivity-based threshold
    const baseThreshold = 0.5;
    const threshold = baseThreshold - (sensitivity - 0.5) * 0.3; // Higher sensitivity = lower threshold
    blocked = confidence >= threshold;

    return {
      blocked,
      confidence: Math.min(1.0, confidence),
      categories,
      reasoning: `Detected ${suspiciousMatches.length} suspicious patterns, confidence: ${confidence.toFixed(2)}, threshold: ${threshold.toFixed(2)}`
    };
  }

  private estimateConfidence(input: string, policy?: DynamicFirewallPolicy): LLMEvalResult {
    // Simple confidence estimation for fallback
    const suspiciousKeywords = ['ignore', 'bypass', 'jailbreak', 'DAN', 'unrestricted'];
    const matches = suspiciousKeywords.filter(keyword => 
      input.toLowerCase().includes(keyword.toLowerCase())
    );
    
    const confidence = Math.min(0.8, matches.length * 0.2);
    const sensitivity = this.getSensitivityValue(policy?.sensitivity || 'medium');
    
    return {
      blocked: confidence >= (1 - sensitivity) * 0.5,
      confidence,
      categories: matches.length > 0 ? ['injection'] : [],
      reasoning: `Fallback analysis: ${matches.length} suspicious keywords`,
      latencyMs: 1
    };
  }

  private getSensitivityValue(sensitivity: 'low' | 'medium' | 'high' | number): number {
    if (typeof sensitivity === 'number') return Math.max(0, Math.min(1, sensitivity));
    switch (sensitivity) {
      case 'low': return 0.3;
      case 'medium': return 0.5;
      case 'high': return 0.8;
      default: return 0.5;
    }
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }
}

export class EnhancedFirewallEngine extends FirewallEngine {
  private semanticGuardClient: SemanticGuardClient;
  private hybridConfig: HybridFirewallConfig;
  private enhancedRules: FirewallRule[];

  constructor(rules?: FirewallRule[], config?: Partial<HybridFirewallConfig>) {
    // Initialize with existing default rules + any provided rules + enhanced rules
    const baseRules = rules || DEFAULT_RULES;
    const allRules = [...baseRules, ...ENHANCED_RULES];
    super(allRules);
    
    this.enhancedRules = ENHANCED_RULES;
    this.hybridConfig = {
      tier1: 'fast-regex',
      tier2: 'semantic-llm',
      fallbackMode: 'regex-only', // Safe default
      sensitivityThreshold: 0.5,
      enableAdvancedRedaction: false,
      maxLLMLatencyMs: 5000,
      ...config
    };

    this.semanticGuardClient = new SemanticGuardClient({
      enabled: false // Disabled by default for backward compatibility
    });
  }

  // Enhanced evaluation with hybrid approach
  async evaluateHybrid(input: string, opts?: EvalOptions): Promise<EnhancedEvalResult> {
    const start = Date.now();
    
    // Handle null/undefined input
    if (!input) {
      return {
        passed: true,
        blocked: false,
        sanitized: '',
        events: [],
        tier: 0,
        latencyMs: Date.now() - start,
        method: 'regex',
        confidence: 0.0,
        redactionApplied: false,
        sophisticationLevel: 'basic'
      };
    }
    
    // Tier 1: Fast regex screening (existing functionality)
    const regexResult = super.evaluate(input, opts);
    
    // Apply redaction if enabled
    let processedInput = input;
    let redactionApplied = false;
    
    if (opts?.redactionConfig) {
      // Enable redaction temporarily for this evaluation
      const originalConfig = this.hybridConfig.enableAdvancedRedaction;
      this.hybridConfig.enableAdvancedRedaction = true;
      
      const redactionResult = this.applyAdvancedRedaction(regexResult.sanitized, opts.redactionConfig);
      processedInput = redactionResult.text;
      redactionApplied = redactionResult.applied;
      
      // Restore original config
      this.hybridConfig.enableAdvancedRedaction = originalConfig;
    }

    // Determine sophistication level
    const sophisticationLevel = this.assessSophisticationLevel(input, regexResult);

    // If blocked by regex, return immediately (high confidence)
    if (regexResult.blocked) {
      return {
        ...regexResult,
        sanitized: processedInput,
        method: 'regex',
        confidence: 0.9, // High confidence for regex matches
        redactionApplied,
        sophisticationLevel,
        policyUsed: opts?.policy
      };
    }

    // Tier 2: Semantic LLM analysis (if enabled and conditions met)
    if (this.shouldUseLLMTier(input, opts, sophisticationLevel)) {
      try {
        const llmResult = await Promise.race([
          this.semanticGuardClient.evaluate(processedInput, opts?.policy),
          new Promise<LLMEvalResult>((_, reject) => 
            setTimeout(() => reject(new Error('LLM timeout')), this.hybridConfig.maxLLMLatencyMs)
          )
        ]);

        return this.combineResults(regexResult, llmResult, processedInput, redactionApplied, opts?.policy);
      } catch (error) {
        console.warn('[EnhancedFirewall] LLM evaluation failed, using regex result:', error);
      }
    }

    // Return regex-only result
    return {
      ...regexResult,
      sanitized: processedInput,
      method: 'regex',
      confidence: this.estimateRegexConfidence(regexResult),
      redactionApplied,
      sophisticationLevel,
      policyUsed: opts?.policy
    };
  }

  // Backward compatible evaluate method
  evaluate(input: string, opts?: { agentId?: string; projectId?: string }): EvalResult {
    // Maintain exact backward compatibility
    return super.evaluate(input, opts);
  }

  private shouldUseLLMTier(input: string, opts?: EvalOptions, sophisticationLevel?: string): boolean {
    // Don't use LLM if not enabled
    if (!this.semanticGuardClient.isEnabled()) return false;
    
    // Don't use LLM if policy explicitly disables it
    if (opts?.policy?.enableLLMTier === false) return false;
    
    // Use LLM for sophisticated attacks
    if (sophisticationLevel === 'advanced') return true;
    
    // Use LLM for intermediate attacks if policy allows
    if (sophisticationLevel === 'intermediate' && opts?.policy?.enableLLMTier) return true;
    
    // Use LLM for long inputs that might contain hidden attacks
    if (input.length > 500) return true;
    
    // Use LLM for multi-language content
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]/.test(input)) return true;
    
    return false;
  }

  private assessSophisticationLevel(input: string, regexResult: EvalResult): 'basic' | 'intermediate' | 'advanced' {
    if (!input) return 'basic';
    
    let score = 0;
    
    // Length-based scoring
    if (input.length > 1000) score += 2;
    else if (input.length > 500) score += 1;
    
    // Multi-language content
    if (/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff]/.test(input)) score += 2;
    
    // Encoding indicators
    if (/(?:base64|hex|encode|decode)/i.test(input)) score += 2;
    
    // Multi-step patterns
    if (/(?:first|step\s+\d+|then|next|after)/i.test(input)) score += 1;
    
    // Context manipulation
    if (/(?:context|memory|buffer|window)/i.test(input)) score += 2;
    
    // Multiple suspicious patterns
    if (regexResult.events.length > 2) score += 1;
    
    if (score >= 4) return 'advanced';
    if (score >= 2) return 'intermediate';
    return 'basic';
  }

  private combineResults(
    regexResult: EvalResult, 
    llmResult: LLMEvalResult, 
    processedInput: string,
    redactionApplied: boolean,
    policy?: DynamicFirewallPolicy
  ): EnhancedEvalResult {
    // Combine events from both tiers
    const combinedEvents = [...regexResult.events];
    
    if (llmResult.blocked) {
      // Add LLM detection as an event
      const llmEvent: FirewallEvent = {
        id: randomUUID(),
        timestamp: Date.now(),
        tier: 2, // LLM tier
        ruleId: 'llm-01',
        ruleName: 'Semantic Analysis',
        category: llmResult.categories[0] || 'injection',
        severity: llmResult.confidence > 0.8 ? 'critical' : llmResult.confidence > 0.5 ? 'high' : 'medium',
        action: 'block',
        input: processedInput.slice(0, 200),
        match: llmResult.reasoning || 'Semantic pattern detected',
        blocked: true
      };
      combinedEvents.push(llmEvent);
    }

    return {
      passed: !llmResult.blocked,
      blocked: llmResult.blocked,
      sanitized: processedInput,
      events: combinedEvents,
      tier: Math.max(regexResult.tier, 2),
      latencyMs: regexResult.latencyMs + llmResult.latencyMs,
      method: 'hybrid',
      confidence: llmResult.confidence,
      llmLatencyMs: llmResult.latencyMs,
      redactionApplied,
      sophisticationLevel: 'advanced', // If we used LLM, it's at least intermediate
      policyUsed: policy
    };
  }

  private estimateRegexConfidence(regexResult: EvalResult): number {
    if (regexResult.events.length === 0) return 0.1; // Low confidence for no matches
    
    // Higher confidence for critical/high severity matches
    const maxSeverity = regexResult.events.reduce((max, event) => {
      const severityScore = { low: 1, medium: 2, high: 3, critical: 4 };
      return Math.max(max, severityScore[event.severity as keyof typeof severityScore] || 1);
    }, 0);
    
    return Math.min(0.9, 0.3 + (maxSeverity * 0.15)); // 0.45-0.9 range
  }

  private applyAdvancedRedaction(input: string, config: RedactionConfig): { text: string; applied: boolean } {
    let text = input;
    let applied = false;

    for (const piiType of config.piiTypes) {
      const pattern = this.getPIIPattern(piiType);
      if (pattern && pattern.test(text)) {
        applied = true;
        text = text.replace(pattern, (match) => this.redactMatch(match, piiType, config));
      }
    }

    return { text, applied };
  }

  private getPIIPattern(piiType: string): RegExp | null {
    const patterns: Record<string, RegExp> = {
      email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      phone: /(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})/g,
      ssn: /\b\d{3}-?\d{2}-?\d{4}\b/g,
      credit_card: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|3[0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
      api_key: /(?:api[_-]?key|apikey|api_secret)\s*[=:]\s*["\']?[a-zA-Z0-9_\-]{20,}/gi,
      password: /(?:password|passwd|pwd)\s*[=:]\s*["\'][^"\']{4,}["\']?/gi
    };
    
    return patterns[piiType] || null;
  }

  private redactMatch(match: string, piiType: string, config: RedactionConfig): string {
    switch (config.redactionStyle) {
      case 'mask':
        return '*'.repeat(match.length);
      case 'token':
        return `__PII_${piiType.toUpperCase()}_${Date.now().toString().slice(-6)}__`;
      case 'remove':
        return '';
      default:
        return match;
    }
  }

  // Configuration methods
  setHybridConfig(config: Partial<HybridFirewallConfig>): void {
    this.hybridConfig = { ...this.hybridConfig, ...config };
  }

  getHybridConfig(): HybridFirewallConfig {
    return { ...this.hybridConfig };
  }

  enableLLMTier(enabled: boolean): void {
    this.semanticGuardClient.setEnabled(enabled);
  }

  isLLMTierEnabled(): boolean {
    return this.semanticGuardClient.isEnabled();
  }

  // Get enhanced statistics
  getEnhancedStats() {
    const baseStats = super.getStats();
    return {
      ...baseStats,
      llmEnabled: this.semanticGuardClient.isEnabled(),
      hybridConfig: this.hybridConfig,
      enhancedRulesCount: this.enhancedRules.length
    };
  }
}