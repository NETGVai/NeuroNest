/**
 * Action Security Analyzer — OpenHands-inspired action risk classification.
 *
 * Evaluates agent actions (shell commands, file operations, code execution)
 * and assigns a security risk level BEFORE execution. Works alongside the
 * existing FirewallEngine (which scans prompt content) to provide defense-in-depth.
 *
 * Three composable analyzers:
 * - PatternAnalyzer: regex-based detection of known threat signatures
 * - PolicyRailAnalyzer: composed threat detection (e.g., fetch piped to exec)
 * - EnsembleAnalyzer: combines multiple analyzers, takes worst-case risk
 */

export type SecurityRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export interface ActionAnalysisResult {
  risk: SecurityRisk;
  reasons: string[];
  analyzer: string;
  timestamp: number;
}

export interface AnalyzableAction {
  type: 'shell' | 'file_write' | 'file_delete' | 'code_exec' | 'network' | 'unknown';
  command?: string;
  filePath?: string;
  content?: string;
  agentId?: string;
}

// ─── Pattern Analyzer ───────────────────────────────────────────

interface ThreatPattern {
  pattern: RegExp;
  risk: SecurityRisk;
  category: string;
  description: string;
}

const SHELL_PATTERNS: ThreatPattern[] = [
  { pattern: /rm\s+-rf\s+\/(?!\w)/i, risk: 'HIGH', category: 'destructive', description: 'Recursive delete from root' },
  { pattern: /sudo\s+rm/i, risk: 'HIGH', category: 'destructive', description: 'Privileged file deletion' },
  { pattern: /mkfs\b/i, risk: 'HIGH', category: 'destructive', description: 'Filesystem format command' },
  { pattern: /dd\s+if=.*of=\/dev/i, risk: 'HIGH', category: 'destructive', description: 'Raw disk write' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}/, risk: 'HIGH', category: 'destructive', description: 'Fork bomb' },
  { pattern: /chmod\s+777/i, risk: 'HIGH', category: 'permissions', description: 'World-writable permissions' },
  { pattern: /curl\s+.*\|\s*(bash|sh|zsh)/i, risk: 'HIGH', category: 'remote_exec', description: 'Pipe remote content to shell' },
  { pattern: /wget\s+.*\|\s*(bash|sh|zsh)/i, risk: 'HIGH', category: 'remote_exec', description: 'Pipe remote content to shell' },
  { pattern: /eval\s*\(/i, risk: 'MEDIUM', category: 'dynamic_exec', description: 'Dynamic code evaluation' },
  { pattern: /exec\s*\(/i, risk: 'MEDIUM', category: 'dynamic_exec', description: 'Dynamic code execution' },
  { pattern: /curl\s+/i, risk: 'MEDIUM', category: 'network', description: 'Network request via curl' },
  { pattern: /wget\s+/i, risk: 'MEDIUM', category: 'network', description: 'Network request via wget' },
  { pattern: /nc\s+-l/i, risk: 'MEDIUM', category: 'network', description: 'Netcat listener' },
  { pattern: /ssh\s+/i, risk: 'MEDIUM', category: 'network', description: 'SSH connection' },
  { pattern: /npm\s+install\s+-g/i, risk: 'MEDIUM', category: 'install', description: 'Global npm package install' },
  { pattern: /pip\s+install/i, risk: 'LOW', category: 'install', description: 'Python package install' },
  { pattern: /npm\s+install/i, risk: 'LOW', category: 'install', description: 'Node package install' },
];

const INJECTION_PATTERNS: ThreatPattern[] = [
  { pattern: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|prompts)/i, risk: 'HIGH', category: 'injection', description: 'Prompt injection attempt' },
  { pattern: /\[SYSTEM\]|\[INST\]|<\|im_start\|>/i, risk: 'HIGH', category: 'injection', description: 'Raw instruction format injection' },
  { pattern: /you\s+are\s+now\s+(a\s+)?(hacker|admin|root)/i, risk: 'HIGH', category: 'injection', description: 'Role hijacking attempt' },
];

export class PatternSecurityAnalyzer {
  analyze(action: AnalyzableAction): ActionAnalysisResult {
    const reasons: string[] = [];
    let maxRisk: SecurityRisk = 'LOW';

    const textToScan = [action.command, action.content, action.filePath].filter(Boolean).join(' ');
    if (!textToScan) return { risk: 'LOW', reasons: ['No content to analyze'], analyzer: 'pattern', timestamp: Date.now() };

    // Shell patterns only scan executable fields
    const executableText = action.command || '';
    for (const tp of SHELL_PATTERNS) {
      if (tp.pattern.test(executableText)) {
        reasons.push(`${tp.category}: ${tp.description}`);
        if (riskOrder(tp.risk) > riskOrder(maxRisk)) maxRisk = tp.risk;
      }
    }

    // Injection patterns scan all fields
    for (const tp of INJECTION_PATTERNS) {
      if (tp.pattern.test(textToScan)) {
        reasons.push(`${tp.category}: ${tp.description}`);
        if (riskOrder(tp.risk) > riskOrder(maxRisk)) maxRisk = tp.risk;
      }
    }

    return { risk: maxRisk, reasons: reasons.length > 0 ? reasons : ['No threats detected'], analyzer: 'pattern', timestamp: Date.now() };
  }
}

// ─── Policy Rail Analyzer ───────────────────────────────────────

interface PolicyRail {
  segments: RegExp[];
  risk: SecurityRisk;
  description: string;
}

const POLICY_RAILS: PolicyRail[] = [
  { segments: [/curl|wget|fetch/i, /\|\s*(bash|sh|eval|exec)/i], risk: 'HIGH', description: 'Remote fetch piped to execution' },
  { segments: [/base64\s+-d/i, /\|\s*(bash|sh)/i], risk: 'HIGH', description: 'Base64 decode piped to shell' },
  { segments: [/cat\s+\/etc\/(passwd|shadow)/i], risk: 'HIGH', description: 'System credential file access' },
  { segments: [/rm\s+-rf/i, /\$\(|`/], risk: 'HIGH', description: 'Recursive delete with command substitution' },
  { segments: [/chmod/i, /\+s\b/i], risk: 'HIGH', description: 'Set SUID bit' },
  { segments: [/crontab/i, /curl|wget/i], risk: 'MEDIUM', description: 'Scheduled remote fetch' },
];

export class PolicyRailSecurityAnalyzer {
  analyze(action: AnalyzableAction): ActionAnalysisResult {
    const reasons: string[] = [];
    let maxRisk: SecurityRisk = 'LOW';

    const text = action.command || action.content || '';
    if (!text) return { risk: 'LOW', reasons: ['No content to analyze'], analyzer: 'policy-rail', timestamp: Date.now() };

    for (const rail of POLICY_RAILS) {
      const allMatch = rail.segments.every(seg => seg.test(text));
      if (allMatch) {
        reasons.push(rail.description);
        if (riskOrder(rail.risk) > riskOrder(maxRisk)) maxRisk = rail.risk;
      }
    }

    return { risk: maxRisk, reasons: reasons.length > 0 ? reasons : ['No policy violations'], analyzer: 'policy-rail', timestamp: Date.now() };
  }
}

// ─── Ensemble Analyzer ──────────────────────────────────────────

export class EnsembleSecurityAnalyzer {
  private analyzers: Array<PatternSecurityAnalyzer | PolicyRailSecurityAnalyzer>;

  constructor(analyzers?: Array<PatternSecurityAnalyzer | PolicyRailSecurityAnalyzer>) {
    this.analyzers = analyzers || [new PatternSecurityAnalyzer(), new PolicyRailSecurityAnalyzer()];
  }

  analyze(action: AnalyzableAction): ActionAnalysisResult {
    const allReasons: string[] = [];
    let maxRisk: SecurityRisk = 'LOW';

    for (const analyzer of this.analyzers) {
      const result = analyzer.analyze(action);
      if (riskOrder(result.risk) > riskOrder(maxRisk)) maxRisk = result.risk;
      if (result.reasons.length > 0 && result.risk !== 'LOW') {
        allReasons.push(...result.reasons);
      }
    }

    return {
      risk: maxRisk,
      reasons: allReasons.length > 0 ? allReasons : ['No threats detected'],
      analyzer: 'ensemble',
      timestamp: Date.now(),
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function riskOrder(risk: SecurityRisk): number {
  return { LOW: 0, MEDIUM: 1, HIGH: 2, UNKNOWN: 1 }[risk] ?? 0;
}

/**
 * Classify a raw command/action string into an AnalyzableAction.
 */
export function classifyAction(input: string, agentId?: string): AnalyzableAction {
  const trimmed = input.trim();

  if (/^(rm|mv|cp|mkdir|touch|chmod|chown)\s/i.test(trimmed)) {
    return { type: 'shell', command: trimmed, agentId };
  }
  if (/^(curl|wget|nc|ssh|scp|rsync)\s/i.test(trimmed)) {
    return { type: 'network', command: trimmed, agentId };
  }
  if (/^(node|python|ruby|php|perl)\s/i.test(trimmed)) {
    return { type: 'code_exec', command: trimmed, agentId };
  }
  if (/^(npm|yarn|pip|cargo|go)\s/i.test(trimmed)) {
    return { type: 'shell', command: trimmed, agentId };
  }

  return { type: 'shell', command: trimmed, agentId };
}
