/**
 * NeuroNest Firewall Engine — a 4-tier content-inspection architecture.
 * Pure TypeScript implementation for Electron (no Python dependency).
 *
 * Tier 0: Sanitization — strips invisible chars, control sequences
 * Tier 1: Pattern-based attack detection — regex rules for injections, jailbreaks
 * Tier 2: Secrets scanner — detects API keys, passwords, tokens in code/prompts
 * Tier 3: Policy enforcement — checks against configurable rules
 */

export interface FirewallRule {
  id: string;
  name: string;
  tier: 0 | 1 | 2 | 3;
  enabled: boolean;
  pattern?: string; // regex pattern
  category: 'injection' | 'jailbreak' | 'secrets' | 'unsafe-command' | 'policy' | 'sanitize';
  severity: 'low' | 'medium' | 'high' | 'critical';
  action: 'block' | 'warn' | 'log';
  description: string;
}

export interface FirewallEvent {
  id: string;
  timestamp: number;
  tier: number;
  ruleId: string;
  ruleName: string;
  category: string;
  severity: string;
  action: string;
  input: string; // truncated
  match?: string;
  blocked: boolean;
  agentId?: string;
  projectId?: string;
}

export interface EvalResult {
  passed: boolean;
  blocked: boolean;
  sanitized: string;
  events: FirewallEvent[];
  tier: number;
  latencyMs: number;
}

// Default rules
export const DEFAULT_RULES: FirewallRule[] = [
  // Tier 0: Sanitization
  { id: 'san-01', name: 'Strip zero-width chars', tier: 0, enabled: true, pattern: '[\\u200B-\\u200F\\u2028-\\u202F\\uFEFF]', category: 'sanitize', severity: 'low', action: 'log', description: 'Remove invisible Unicode characters used to hide injections' },
  { id: 'san-02', name: 'Strip ANSI escapes', tier: 0, enabled: true, pattern: '\\x1B\\[[0-9;]*[a-zA-Z]', category: 'sanitize', severity: 'low', action: 'log', description: 'Remove terminal escape sequences' },

  // Tier 1: Prompt injection detection
  { id: 'inj-01', name: 'System prompt override', tier: 1, enabled: true, pattern: '(?i)(ignore|forget|disregard)\\s+(all\\s+)?(previous|prior|above|earlier)\\s+(instructions|prompts|rules)', category: 'injection', severity: 'critical', action: 'block', description: 'Detects attempts to override system instructions' },
  { id: 'inj-02', name: 'Role hijacking', tier: 1, enabled: true, pattern: '(?i)(you\\s+are\\s+now|act\\s+as|pretend\\s+to\\s+be|roleplay\\s+as)\\s+(a\\s+)?(hacker|admin|root|unrestricted)', category: 'injection', severity: 'high', action: 'block', description: 'Detects role hijacking attempts' },
  { id: 'inj-03', name: 'Instruction injection', tier: 1, enabled: true, pattern: '(?i)(\\[SYSTEM\\]|\\[INST\\]|<\\|im_start\\|>|<\\|system\\|>)', category: 'injection', severity: 'critical', action: 'block', description: 'Detects raw instruction format injection' },
  { id: 'inj-04', name: 'Jailbreak keywords', tier: 1, enabled: true, pattern: '(?i)(DAN|do\\s+anything\\s+now|jailbreak|bypass\\s+safety|ignore\\s+safety)', category: 'jailbreak', severity: 'high', action: 'block', description: 'Detects common jailbreak patterns' },
  { id: 'inj-05', name: 'Prompt leaking', tier: 1, enabled: true, pattern: '(?i)(show|reveal|print|output|display)\\s+(your|the|system)\\s+(prompt|instructions|rules|config)', category: 'injection', severity: 'medium', action: 'warn', description: 'Detects attempts to extract system prompts' },

  // Tier 2: Secrets detection
  { id: 'sec-01', name: 'AWS Access Key', tier: 2, enabled: true, pattern: 'AKIA[0-9A-Z]{16}', category: 'secrets', severity: 'critical', action: 'block', description: 'Blocks AWS access key IDs in output' },
  { id: 'sec-02', name: 'Generic API Key', tier: 2, enabled: true, pattern: '(?i)(api[_-]?key|apikey|api_secret)\\s*[=:]\\s*["\']?[a-zA-Z0-9_\\-]{20,}', category: 'secrets', severity: 'high', action: 'block', description: 'Blocks generic API key patterns' },
  { id: 'sec-03', name: 'Private key block', tier: 2, enabled: true, pattern: '-----BEGIN\\s+(RSA\\s+)?PRIVATE\\s+KEY-----', category: 'secrets', severity: 'critical', action: 'block', description: 'Blocks private key content' },
  { id: 'sec-04', name: 'GitHub token', tier: 2, enabled: true, pattern: 'gh[ps]_[A-Za-z0-9_]{36,}', category: 'secrets', severity: 'critical', action: 'block', description: 'Blocks GitHub personal access tokens' },
  { id: 'sec-05', name: 'Password in code', tier: 2, enabled: true, pattern: '(?i)(password|passwd|pwd)\\s*[=:]\\s*["\'][^"\']{4,}["\']', category: 'secrets', severity: 'high', action: 'warn', description: 'Detects hardcoded passwords' },
  { id: 'sec-06', name: 'JWT token', tier: 2, enabled: true, pattern: 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}', category: 'secrets', severity: 'high', action: 'block', description: 'Blocks JWT tokens in output' },

  // Tier 3: Policy enforcement
  { id: 'pol-01', name: 'Unsafe shell commands', tier: 3, enabled: true, pattern: '(?i)(rm\\s+-rf\\s+/|sudo\\s+rm|mkfs|dd\\s+if=|:(){ :|fork\\s+bomb)', category: 'unsafe-command', severity: 'critical', action: 'block', description: 'Blocks destructive system commands' },
  { id: 'pol-02', name: 'Network exfiltration', tier: 3, enabled: true, pattern: '(?i)(curl|wget|nc|ncat)\\s+.*\\s+(\\d{1,3}\\.){3}\\d{1,3}', category: 'unsafe-command', severity: 'high', action: 'warn', description: 'Detects potential data exfiltration via network tools' },
  { id: 'pol-03', name: 'Eval/exec injection', tier: 3, enabled: true, pattern: '(?i)(eval|exec|Function)\\s*\\(\\s*["\']', category: 'unsafe-command', severity: 'high', action: 'warn', description: 'Detects dynamic code execution patterns' },
  { id: 'pol-04', name: 'External API limit', tier: 3, enabled: true, pattern: '(?i)fetch\\s*\\(\\s*["\']https?://', category: 'policy', severity: 'low', action: 'log', description: 'Logs external API calls by agents' },
];

export class FirewallEngine {
  private rules: FirewallRule[];
  private events: FirewallEvent[] = [];
  private stats = { total: 0, blocked: 0, warned: 0, passed: 0 };
  // Pre-compiled regex cache — avoids recompiling on every evaluate() call
  private compiledPatterns = new Map<string, RegExp>();

  constructor(rules?: FirewallRule[]) {
    this.rules = rules || [...DEFAULT_RULES];
    this.precompilePatterns();
  }

  /** Pre-compile all rule patterns into RegExp objects */
  private precompilePatterns(): void {
    for (const rule of this.rules) {
      if (!rule.pattern) continue;
      try {
        const flags = rule.pattern.startsWith('(?i)') ? 'gi' : 'g';
        const cleanPattern = rule.pattern.replace(/^\(\?i\)/, '');
        this.compiledPatterns.set(rule.id, new RegExp(cleanPattern, flags));
      } catch {}
    }
  }

  /** Evaluate input through all tiers */
  evaluate(input: string, opts?: { agentId?: string; projectId?: string }): EvalResult {
    const start = Date.now();
    const events: FirewallEvent[] = [];
    let sanitized = input;
    let blocked = false;
    let maxTier = 0;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (!rule.pattern) continue;

      const regex = this.compiledPatterns.get(rule.id);
      if (!regex) continue;

      try {
        // Reset lastIndex for global regexes to ensure correct matching
        regex.lastIndex = 0;
        const match = regex.exec(sanitized);

        if (match) {
          const event: FirewallEvent = {
            id: require('node:crypto').randomUUID(),
            timestamp: Date.now(),
            tier: rule.tier,
            ruleId: rule.id,
            ruleName: rule.name,
            category: rule.category,
            severity: rule.severity,
            action: rule.action,
            input: input.slice(0, 200),
            match: match[0].slice(0, 100),
            blocked: rule.action === 'block',
            agentId: opts?.agentId,
            projectId: opts?.projectId,
          };
          events.push(event);
          this.events.push(event);
          maxTier = Math.max(maxTier, rule.tier);

          if (rule.tier === 0) {
            // Sanitize: remove matched content
            regex.lastIndex = 0;
            sanitized = sanitized.replace(regex, '');
          }
          if (rule.action === 'block') {
            blocked = true;
            this.stats.blocked++;
          } else if (rule.action === 'warn') {
            this.stats.warned++;
          }
        }
      } catch {}
    }

    this.stats.total++;
    if (!blocked) this.stats.passed++;
    this.trimEvents();

    return {
      passed: !blocked,
      blocked,
      sanitized,
      events,
      tier: maxTier,
      latencyMs: Date.now() - start,
    };
  }

  getRules(): FirewallRule[] { return this.rules; }
  getEvents(limit?: number): FirewallEvent[] { return limit ? this.events.slice(-limit) : this.events; }
  getStats() { return { ...this.stats }; }

  /** Cap stored events to prevent unbounded memory growth */
  private trimEvents(): void {
    if (this.events.length > 1000) {
      this.events = this.events.slice(-500);
    }
  }

  setRuleEnabled(ruleId: string, enabled: boolean): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) rule.enabled = enabled;
  }

  updateRuleAction(ruleId: string, action: 'block' | 'warn' | 'log'): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) rule.action = action;
  }

  addRule(rule: FirewallRule): void {
    this.rules.push(rule);
    // Compile the new rule's pattern
    if (rule.pattern) {
      try {
        const flags = rule.pattern.startsWith('(?i)') ? 'gi' : 'g';
        const cleanPattern = rule.pattern.replace(/^\(\?i\)/, '');
        this.compiledPatterns.set(rule.id, new RegExp(cleanPattern, flags));
      } catch {}
    }
  }
  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(r => r.id !== ruleId);
    this.compiledPatterns.delete(ruleId);
  }
  clearEvents(): void { this.events = []; }
}
