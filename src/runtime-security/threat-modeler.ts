/**
 * ThreatModeler — AI-Aware Threat Modeling subsystem.
 *
 * Analyzes AI-generated code for attack vectors specific to AI/LLM patterns:
 * - Prompt injection entry points
 * - PII leakage paths to AI providers
 * - Insecure AI integration patterns
 * - Unvalidated AI output consumption
 *
 * Threats are ranked by exploitability × blastRadius, filtered against
 * FirewallEngine coverage, and critical threats emit blocking events
 * via CallbackEngine.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import type { ThreatSeverity } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface ThreatAssessment {
  id: string;
  severity: ThreatSeverity;
  attackVector: string;
  affectedLocations: Array<{ file: string; line: number; column?: number }>;
  prerequisites: string[];
  potentialImpact: string;
  blastRadius: number;           // 0–100
  exploitability: number;        // 0–100
  mitigation: string;
  isNovelAIThreat: boolean;      // true if not covered by FirewallEngine
}

export interface ThreatModelProfile {
  usesExternalLLMApis: boolean;
  acceptsUserPrompts: boolean;
  storesConversationHistory: boolean;
  handlesFinancialData: boolean;
  handlesPII: boolean;
  customPatterns?: string[];
}

export interface ThreatModelResult {
  threats: ThreatAssessment[];    // sorted by exploitability * blastRadius desc
  coveredByFirewall: string[];    // threat IDs already handled by FirewallEngine
  sessionId: string;
  analyzedFiles: string[];
}

// ─── Internal Types ─────────────────────────────────────────────

interface DetectedPattern {
  category: 'prompt-injection' | 'pii-leakage' | 'insecure-ai-integration' | 'unvalidated-ai-output';
  line: number;
  column?: number;
  match: string;
}

// ─── Firewall Interface ─────────────────────────────────────────

interface FirewallLike {
  evaluate?: (content: string) => { passed: boolean; findings?: string[] };
}

// ─── CallbackEngine Interface ───────────────────────────────────

interface CallbackEngineLike {
  emit: (event: string, context: unknown) => void;
}

// ─── Pattern Definitions ────────────────────────────────────────

/**
 * Patterns for detecting prompt injection vectors:
 * User input being concatenated/interpolated into prompt strings.
 */
const PROMPT_INJECTION_PATTERNS: RegExp[] = [
  // Template literals with user/input variables in prompt context
  /(?:prompt|message|instruction|system_prompt|systemPrompt)\s*(?:=|\+=)\s*`[^`]*\$\{[^}]*(?:user|input|query|request|body|param)[^}]*\}/i,
  // String concatenation with user input in prompt context
  /(?:prompt|message|instruction)\s*(?:=|\+=)\s*.*\+\s*(?:user|input|query|request|body|param)/i,
  // Direct user input passed into prompt arrays or messages
  /messages\s*[.:=].*(?:content|role).*(?:user_input|userInput|req\.body|request\.body|params\[)/i,
  // f-string style prompt injection (Python-like in comments/strings)
  /(?:prompt|message)\s*=\s*f?["'].*\{(?:user|input|query)[^}]*\}/i,
];

/**
 * Patterns for detecting PII leakage to AI providers:
 * PII data passed directly to external AI API calls.
 */
const PII_LEAKAGE_PATTERNS: RegExp[] = [
  // Email/phone/SSN variables passed to AI API calls
  /(?:openai|anthropic|cohere|ai|llm|gpt|claude|chat).*(?:email|phone|ssn|social_security|socialSecurity|phoneNumber|phone_number)/i,
  // PII variables in prompt/message content
  /(?:prompt|message|content)\s*[=:+].*(?:email|phone|ssn|social_security|socialSecurity|dateOfBirth|date_of_birth|address|creditCard|credit_card)/i,
  // User personal data sent to completion/chat endpoints
  /(?:createCompletion|createChatCompletion|complete|generate|invoke)\s*\(.*(?:email|phone|ssn|personalData|personal_data)/i,
];

/**
 * Patterns for detecting insecure AI integrations:
 * AI responses used without validation or error handling.
 */
const INSECURE_AI_INTEGRATION_PATTERNS: RegExp[] = [
  // AI response used directly without try/catch or validation
  /(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:openai|anthropic|cohere|ai|llm)\.\w+\([^)]*\)(?:\.\w+)*\s*;?\s*$/im,
  // Missing error handling on AI API calls (no catch/try nearby)
  /(?:response|result|completion)\s*=\s*(?:await\s+)?(?:fetch|axios|got)\s*\(\s*['"`].*(?:openai|anthropic|cohere|api\.ai|generative)/i,
  // AI response fields accessed without null checks
  /(?:response|result|completion)\.(?:choices|data|content|text)\[0\](?!\s*\?\s*\.)/i,
];

/**
 * Patterns for detecting unvalidated AI output in sensitive operations:
 * AI output used directly in exec/eval/SQL/filesystem operations.
 */
const UNVALIDATED_AI_OUTPUT_PATTERNS: RegExp[] = [
  // AI output used in exec/eval/spawn
  /(?:exec|eval|execSync|spawn|execFile)\s*\(.*(?:response|result|completion|output|generated|aiResult|ai_result)/i,
  // AI output in SQL queries
  /(?:query|execute|run|prepare)\s*\(.*(?:response|result|completion|output|generated|aiResult|ai_result)/i,
  // AI output in filesystem operations
  /(?:writeFile|writeFileSync|appendFile|createWriteStream|fs\.write)\s*\(.*(?:response|result|completion|output|generated|aiResult|ai_result)/i,
  // AI output used in dynamic imports or require
  /(?:require|import)\s*\(.*(?:response|result|completion|output|generated|aiResult|ai_result)/i,
];

// ─── Threat Metadata ────────────────────────────────────────────

const CATEGORY_METADATA: Record<DetectedPattern['category'], {
  attackVector: string;
  severity: ThreatSeverity;
  exploitability: number;
  blastRadius: number;
  potentialImpact: string;
  mitigation: string;
  prerequisites: string[];
  firewallCategory: string | null;
}> = {
  'prompt-injection': {
    attackVector: 'User input concatenated into AI prompts without sanitization, enabling prompt injection attacks',
    severity: 'critical',
    exploitability: 90,
    blastRadius: 80,
    potentialImpact: 'Attacker can manipulate AI behavior, bypass safety controls, exfiltrate data, or execute unauthorized actions through crafted prompts',
    mitigation: 'Sanitize and validate all user input before including in prompts. Use parameterized prompt templates or input/output guardrails',
    prerequisites: ['User-controlled input reaches prompt construction'],
    firewallCategory: 'injection',
  },
  'pii-leakage': {
    attackVector: 'Personally identifiable information (PII) sent directly to external AI providers without redaction',
    severity: 'high',
    exploitability: 70,
    blastRadius: 75,
    potentialImpact: 'PII data (email, phone, SSN) exposed to third-party AI providers, violating privacy regulations (GDPR, CCPA) and risking data breaches',
    mitigation: 'Implement PII redaction/masking before sending data to AI providers. Use the existing redaction pipeline for sensitive fields',
    prerequisites: ['Application handles PII data', 'PII reaches AI API call path'],
    firewallCategory: null,
  },
  'insecure-ai-integration': {
    attackVector: 'AI API responses consumed without proper validation or error handling',
    severity: 'medium',
    exploitability: 50,
    blastRadius: 45,
    potentialImpact: 'Application crashes, unexpected behavior, or security bypasses when AI API returns malformed, manipulated, or error responses',
    mitigation: 'Validate AI API responses against expected schemas. Implement proper error handling with try/catch and fallback behavior',
    prerequisites: ['Application calls external AI APIs'],
    firewallCategory: null,
  },
  'unvalidated-ai-output': {
    attackVector: 'AI-generated output used directly in security-sensitive operations (exec, eval, SQL, filesystem) without validation',
    severity: 'critical',
    exploitability: 85,
    blastRadius: 95,
    potentialImpact: 'Remote code execution, SQL injection, arbitrary file write, or privilege escalation through manipulated AI outputs',
    mitigation: 'Never use AI output directly in security-sensitive operations. Validate, sanitize, and constrain AI outputs before use in exec/eval/SQL/filesystem operations',
    prerequisites: ['AI output reaches security-sensitive operation'],
    firewallCategory: null,
  },
};

// ─── ThreatModeler Class ────────────────────────────────────────

let threatIdCounter = 0;

function generateThreatId(): string {
  threatIdCounter += 1;
  return `threat-${Date.now()}-${threatIdCounter}`;
}

export class ThreatModeler {
  private readonly profile: ThreatModelProfile;
  private readonly callbackEngine: CallbackEngineLike;
  private readonly firewall: FirewallLike | null;

  constructor(
    profile: ThreatModelProfile,
    callbackEngine: CallbackEngineLike,
    firewall: FirewallLike | null,
  ) {
    this.profile = profile;
    this.callbackEngine = callbackEngine;
    this.firewall = firewall;
  }

  /**
   * Analyze code changes for AI-specific attack vectors.
   * Filters out threats already covered by FirewallEngine to avoid duplicates.
   * Emits blocking event for critical-severity threats.
   */
  async analyze(
    files: Array<{ path: string; content: string; diff?: string }>,
    sessionId: string,
  ): Promise<ThreatModelResult> {
    const allThreats: ThreatAssessment[] = [];
    const coveredByFirewall: string[] = [];
    const analyzedFiles: string[] = [];

    for (const file of files) {
      analyzedFiles.push(file.path);
      const detectedPatterns = this.scanForPatterns(file.path, file.content);

      for (const pattern of detectedPatterns) {
        const metadata = CATEGORY_METADATA[pattern.category];
        const threat = this.buildThreatAssessment(pattern, file.path, metadata);

        // Check if firewall already covers this threat
        if (this.isFirewallCovered(threat, file.content, metadata.firewallCategory)) {
          coveredByFirewall.push(threat.id);
          threat.isNovelAIThreat = false;
        } else {
          threat.isNovelAIThreat = true;
        }

        allThreats.push(threat);
      }
    }

    // Filter out threats covered by firewall from the main threats list
    const novelThreats = allThreats.filter(
      (t) => !coveredByFirewall.includes(t.id),
    );

    // Sort threats by exploitability * blastRadius descending
    novelThreats.sort(
      (a, b) => (b.exploitability * b.blastRadius) - (a.exploitability * a.blastRadius),
    );

    // Emit blocking event for critical-severity threats
    for (const threat of novelThreats) {
      if (threat.severity === 'critical') {
        this.callbackEngine.emit('security-threat-detected', {
          subsystem: 'threat_modeler',
          severity: threat.severity,
          threat,
          sessionId,
          blocking: true,
          remediationGuidance: threat.mitigation,
        });
      }
    }

    return {
      threats: novelThreats,
      coveredByFirewall,
      sessionId,
      analyzedFiles,
    };
  }

  /**
   * Scan file content for all AI-specific attack patterns,
   * filtered by the configured ThreatModelProfile.
   */
  private scanForPatterns(filePath: string, content: string): DetectedPattern[] {
    const detected: DetectedPattern[] = [];
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      // Check prompt injection patterns (only if project accepts user prompts)
      if (this.profile.acceptsUserPrompts) {
        for (const pattern of PROMPT_INJECTION_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            detected.push({
              category: 'prompt-injection',
              line: lineIndex + 1,
              column: match.index,
              match: match[0],
            });
            break; // Only report one match per line per category
          }
        }
      }

      // Check PII leakage patterns (only if project handles PII)
      if (this.profile.handlesPII) {
        for (const pattern of PII_LEAKAGE_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            detected.push({
              category: 'pii-leakage',
              line: lineIndex + 1,
              column: match.index,
              match: match[0],
            });
            break;
          }
        }
      }

      // Check insecure AI integration patterns (only if project uses external LLM APIs)
      if (this.profile.usesExternalLLMApis) {
        for (const pattern of INSECURE_AI_INTEGRATION_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            detected.push({
              category: 'insecure-ai-integration',
              line: lineIndex + 1,
              column: match.index,
              match: match[0],
            });
            break;
          }
        }
      }

      // Check unvalidated AI output patterns (only if project uses external LLM APIs)
      if (this.profile.usesExternalLLMApis) {
        for (const pattern of UNVALIDATED_AI_OUTPUT_PATTERNS) {
          const match = line.match(pattern);
          if (match) {
            detected.push({
              category: 'unvalidated-ai-output',
              line: lineIndex + 1,
              column: match.index,
              match: match[0],
            });
            break;
          }
        }
      }

      // Check custom patterns from profile
      if (this.profile.customPatterns) {
        for (const customPattern of this.profile.customPatterns) {
          try {
            const regex = new RegExp(customPattern, 'i');
            const match = line.match(regex);
            if (match) {
              detected.push({
                category: 'insecure-ai-integration',
                line: lineIndex + 1,
                column: match.index,
                match: match[0],
              });
            }
          } catch {
            // Skip invalid custom patterns
          }
        }
      }
    }

    return detected;
  }

  /**
   * Build a ThreatAssessment from a detected pattern.
   */
  private buildThreatAssessment(
    pattern: DetectedPattern,
    filePath: string,
    metadata: typeof CATEGORY_METADATA[DetectedPattern['category']],
  ): ThreatAssessment {
    return {
      id: generateThreatId(),
      severity: metadata.severity,
      attackVector: metadata.attackVector,
      affectedLocations: [
        {
          file: filePath,
          line: pattern.line,
          column: pattern.column,
        },
      ],
      prerequisites: metadata.prerequisites,
      potentialImpact: metadata.potentialImpact,
      blastRadius: metadata.blastRadius,
      exploitability: metadata.exploitability,
      mitigation: metadata.mitigation,
      isNovelAIThreat: true, // Will be updated if firewall covers it
    };
  }

  /**
   * Check if a threat is already covered by the FirewallEngine.
   * Returns true if the firewall handles the threat's category.
   */
  private isFirewallCovered(
    _threat: ThreatAssessment,
    content: string,
    firewallCategory: string | null,
  ): boolean {
    if (!this.firewall || !this.firewall.evaluate || !firewallCategory) {
      return false;
    }

    try {
      const result = this.firewall.evaluate(content);
      // If the firewall found findings related to the same category, it covers this threat
      if (!result.passed && result.findings) {
        return result.findings.some(
          (finding) => finding.toLowerCase().includes(firewallCategory.toLowerCase()),
        );
      }
    } catch {
      // If firewall evaluation fails, treat as not covered
    }

    return false;
  }
}
