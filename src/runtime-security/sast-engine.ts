/**
 * SAST Engine — Static Analysis Security Testing with dataflow/taint tracking.
 *
 * Performs pattern-based taint analysis detecting when user-controlled input
 * flows into dangerous sinks (exec, eval, SQL queries, etc.).
 * Falls back to regex-only (RealtimeCodeAnalyzer) results on timeout.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { randomUUID } from 'node:crypto';
import type { ThreatSeverity } from './types.js';
import { RealtimeCodeAnalyzer } from './realtime-code-analyzer.js';

// ─── Interfaces ─────────────────────────────────────────────────

export interface SASTFinding {
  id: string;
  rule: string;
  severity: ThreatSeverity;
  file: string;
  line: number;
  column: number;
  message: string;
  remediation: string;
  /** Taint flow path (source → ... → sink) */
  dataflowPath?: string[];
  confidence: number; // 0.0-1.0
}

export interface SASTResult {
  passed: boolean;
  findings: SASTFinding[];
  durationMs: number;
  timedOut: boolean;
  /** When true, SAST timed out and regex results are used */
  fellBackToRegex: boolean;
}

// ─── Supported Languages ────────────────────────────────────────

export type SupportedLanguage = 'javascript' | 'typescript' | 'python' | 'go';

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.py': 'python',
  '.pyw': 'python',
  '.go': 'go',
};

// ─── Taint Source Patterns (per language) ───────────────────────

interface TaintSource {
  pattern: RegExp;
  name: string;
  languages: SupportedLanguage[];
}

const TAINT_SOURCES: TaintSource[] = [
  // JavaScript/TypeScript sources
  {
    pattern: /\b(?:req\.(?:body|query|params|headers)|request\.(?:body|query|params|headers))\b/,
    name: 'http-request-input',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:process\.env|process\.argv)\b/,
    name: 'environment-input',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:document\.(?:location|cookie|referrer|URL)|window\.location|location\.(?:search|hash|href))\b/,
    name: 'browser-input',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:localStorage|sessionStorage)\.getItem\s*\(/,
    name: 'storage-input',
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\breadline\b|\.on\s*\(\s*['"`]data['"`]/,
    name: 'user-stdin-input',
    languages: ['javascript', 'typescript'],
  },
  // Python sources
  {
    pattern: /\b(?:request\.(?:form|args|json|data|values|files|cookies|headers)|flask\.request)\b/,
    name: 'http-request-input',
    languages: ['python'],
  },
  {
    pattern: /\b(?:sys\.argv|os\.environ|input\s*\()/,
    name: 'environment-input',
    languages: ['python'],
  },
  {
    pattern: /\b(?:sys\.stdin|raw_input\s*\()/,
    name: 'user-stdin-input',
    languages: ['python'],
  },
  // Go sources
  {
    pattern: /\b(?:r\.(?:URL|Form|Body|Header|PostForm)|http\.Request)\b/,
    name: 'http-request-input',
    languages: ['go'],
  },
  {
    pattern: /\b(?:os\.Args|os\.Getenv|flag\.(?:String|Int|Bool))\b/,
    name: 'environment-input',
    languages: ['go'],
  },
  {
    pattern: /\b(?:bufio\.NewReader|os\.Stdin)\b/,
    name: 'user-stdin-input',
    languages: ['go'],
  },
];

// ─── Taint Sink Patterns (per language) ─────────────────────────

interface TaintSink {
  pattern: RegExp;
  name: string;
  rule: string;
  severity: ThreatSeverity;
  message: string;
  remediation: string;
  confidence: number;
  languages: SupportedLanguage[];
}

const TAINT_SINKS: TaintSink[] = [
  // JavaScript/TypeScript sinks
  {
    pattern: /\b(?:eval|Function)\s*\(/,
    name: 'code-execution',
    rule: 'sast-code-injection',
    severity: 'critical',
    message: 'User-controlled input flows into code execution sink (eval/Function)',
    remediation: 'Avoid eval/Function with dynamic input. Use safe alternatives like JSON.parse for data or a sandboxed execution environment.',
    confidence: 0.9,
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:exec|execSync|spawn|spawnSync|execFile)\s*\(/,
    name: 'command-execution',
    rule: 'sast-command-injection',
    severity: 'critical',
    message: 'User-controlled input flows into command execution sink',
    remediation: 'Use execFile or spawn with an argument array instead of exec with string interpolation. Validate and sanitize all inputs.',
    confidence: 0.85,
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:query|execute|raw)\s*\(/,
    name: 'sql-query',
    rule: 'sast-sql-injection',
    severity: 'critical',
    message: 'User-controlled input flows into SQL query sink without parameterization',
    remediation: 'Use parameterized queries or prepared statements. Never concatenate user input into SQL strings.',
    confidence: 0.8,
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\.innerHTML\s*=/,
    name: 'dom-xss',
    rule: 'sast-xss',
    severity: 'high',
    message: 'User-controlled input flows into innerHTML sink (DOM XSS)',
    remediation: 'Use textContent instead of innerHTML, or sanitize with DOMPurify before insertion.',
    confidence: 0.85,
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:readFile|writeFile|createReadStream|createWriteStream|unlink)\s*\(/,
    name: 'file-access',
    rule: 'sast-path-traversal',
    severity: 'high',
    message: 'User-controlled input flows into file system operation without path validation',
    remediation: 'Validate and normalize file paths. Ensure resolved path stays within allowed directories using path.resolve() and startsWith checks.',
    confidence: 0.75,
    languages: ['javascript', 'typescript'],
  },
  // Python sinks
  {
    pattern: /\b(?:eval|exec)\s*\(/,
    name: 'code-execution',
    rule: 'sast-code-injection',
    severity: 'critical',
    message: 'User-controlled input flows into code execution sink (eval/exec)',
    remediation: 'Avoid eval/exec with user input. Use ast.literal_eval for safe data parsing or a restricted execution environment.',
    confidence: 0.9,
    languages: ['python'],
  },
  {
    pattern: /\b(?:os\.system|os\.popen|subprocess\.(?:call|run|Popen|check_output))\s*\(/,
    name: 'command-execution',
    rule: 'sast-command-injection',
    severity: 'critical',
    message: 'User-controlled input flows into command execution sink',
    remediation: 'Use subprocess with shell=False and pass arguments as a list. Validate and sanitize all inputs.',
    confidence: 0.85,
    languages: ['python'],
  },
  {
    pattern: /\b(?:cursor\.execute|db\.execute|engine\.execute)\s*\(/,
    name: 'sql-query',
    rule: 'sast-sql-injection',
    severity: 'critical',
    message: 'User-controlled input flows into SQL query without parameterization',
    remediation: 'Use parameterized queries with %s or ? placeholders. Never use f-strings or format() for SQL.',
    confidence: 0.8,
    languages: ['python'],
  },
  {
    pattern: /\b(?:open|os\.(?:remove|unlink|rename|chmod))\s*\(/,
    name: 'file-access',
    rule: 'sast-path-traversal',
    severity: 'high',
    message: 'User-controlled input flows into file system operation without path validation',
    remediation: 'Validate file paths using os.path.abspath() and verify they remain within allowed directories.',
    confidence: 0.75,
    languages: ['python'],
  },
  // Go sinks
  {
    pattern: /\b(?:exec\.Command|exec\.CommandContext)\s*\(/,
    name: 'command-execution',
    rule: 'sast-command-injection',
    severity: 'critical',
    message: 'User-controlled input flows into command execution sink',
    remediation: 'Validate and sanitize all command arguments. Avoid passing user input directly to exec.Command.',
    confidence: 0.85,
    languages: ['go'],
  },
  {
    pattern: /\b(?:db\.(?:Query|Exec|QueryRow)|sql\.(?:Query|Exec))\s*\(/,
    name: 'sql-query',
    rule: 'sast-sql-injection',
    severity: 'critical',
    message: 'User-controlled input flows into SQL query without parameterization',
    remediation: 'Use parameterized queries with $1, $2 placeholders. Never concatenate user input into SQL strings.',
    confidence: 0.8,
    languages: ['go'],
  },
  {
    pattern: /\b(?:os\.(?:Open|Create|Remove|Rename)|ioutil\.(?:ReadFile|WriteFile))\s*\(/,
    name: 'file-access',
    rule: 'sast-path-traversal',
    severity: 'high',
    message: 'User-controlled input flows into file system operation without path validation',
    remediation: 'Validate file paths using filepath.Clean() and verify they remain within allowed base directories.',
    confidence: 0.75,
    languages: ['go'],
  },
  {
    pattern: /\bfmt\.Fprintf\s*\(\s*w\b/,
    name: 'response-injection',
    rule: 'sast-xss',
    severity: 'high',
    message: 'User-controlled input flows into HTTP response without escaping',
    remediation: 'Use html/template for HTML responses or html.EscapeString() for manual escaping.',
    confidence: 0.7,
    languages: ['go'],
  },
];

// ─── Sanitizer Patterns ─────────────────────────────────────────

interface Sanitizer {
  pattern: RegExp;
  neutralizes: string[]; // sink names it neutralizes
  languages: SupportedLanguage[];
}

const SANITIZERS: Sanitizer[] = [
  // JavaScript/TypeScript
  {
    pattern: /\b(?:DOMPurify\.sanitize|sanitize|escapeHtml|encodeURIComponent|encodeURI)\s*\(/,
    neutralizes: ['dom-xss', 'response-injection'],
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:parameterize|prepared|placeholder|\$\d+|\?)/,
    neutralizes: ['sql-query'],
    languages: ['javascript', 'typescript'],
  },
  {
    pattern: /\b(?:shell(?:Escape|Quote)|shellescape|shlex\.quote)\b/,
    neutralizes: ['command-execution'],
    languages: ['javascript', 'typescript', 'python'],
  },
  {
    pattern: /\b(?:path\.resolve|path\.normalize|path\.join).*(?:startsWith|includes|indexOf)\b/,
    neutralizes: ['file-access'],
    languages: ['javascript', 'typescript'],
  },
  // Python
  {
    pattern: /\b(?:bleach\.clean|markupsafe\.escape|html\.escape|cgi\.escape)\s*\(/,
    neutralizes: ['dom-xss', 'response-injection'],
    languages: ['python'],
  },
  {
    pattern: /\b(?:shlex\.quote|pipes\.quote)\s*\(/,
    neutralizes: ['command-execution'],
    languages: ['python'],
  },
  {
    pattern: /\b(?:os\.path\.abspath|os\.path\.realpath).*(?:startswith)\b/i,
    neutralizes: ['file-access'],
    languages: ['python'],
  },
  // Go
  {
    pattern: /\b(?:html\.EscapeString|template\.HTMLEscapeString)\s*\(/,
    neutralizes: ['dom-xss', 'response-injection'],
    languages: ['go'],
  },
  {
    pattern: /\b(?:filepath\.Clean|filepath\.Abs).*(?:strings\.HasPrefix)\b/,
    neutralizes: ['file-access'],
    languages: ['go'],
  },
];

// ─── Helper Functions ───────────────────────────────────────────

/**
 * Detect file language from extension.
 * Returns null for unsupported file types.
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

/**
 * Perform intra-procedural taint tracking on a single file.
 *
 * This is a simplified dataflow analysis that:
 * 1. Identifies taint sources on each line
 * 2. Tracks variable assignments that propagate taint
 * 3. Detects when tainted values reach security-sensitive sinks
 * 4. Checks for sanitizer calls that neutralize taint
 *
 * Returns findings for unsanitized source-to-sink flows.
 */
export function performTaintAnalysis(
  filePath: string,
  content: string,
  language: SupportedLanguage,
  deadline: number,
): SASTFinding[] {
  const findings: SASTFinding[] = [];
  const lines = content.split('\n');

  // Track tainted variables: variable name → { sourceLine, sourceName }
  const taintedVars = new Map<string, { sourceLine: number; sourceName: string }>();

  // Phase 1: Identify taint sources and track assignments
  const applicableSources = TAINT_SOURCES.filter(s => s.languages.includes(language));
  const applicableSinks = TAINT_SINKS.filter(s => s.languages.includes(language));
  const applicableSanitizers = SANITIZERS.filter(s => s.languages.includes(language));

  // Assignment pattern: captures variable name on the left side
  const assignmentPattern = /(?:(?:const|let|var|:=)\s+)?(\w+)\s*(?::=|=)\s*(.+)/;

  for (let i = 0; i < lines.length; i++) {
    // Check deadline
    if (Date.now() >= deadline) {
      return findings; // Return what we have so far
    }

    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) {
      continue;
    }

    // Check if this line contains a taint source
    for (const source of applicableSources) {
      if (source.pattern.test(line)) {
        // Try to find the variable being assigned
        const assignMatch = line.match(assignmentPattern);
        if (assignMatch) {
          taintedVars.set(assignMatch[1], { sourceLine: i + 1, sourceName: source.name });
        }
        // Also mark the line itself as tainted for direct use detection
        taintedVars.set(`__line_${i}__`, { sourceLine: i + 1, sourceName: source.name });
      }
    }

    // Check if tainted variable is being reassigned/propagated
    const assignMatch = line.match(assignmentPattern);
    if (assignMatch) {
      const varName = assignMatch[1];
      const rhsValue = assignMatch[2];
      // Check if RHS references any tainted variable
      for (const [taintedVar, info] of taintedVars) {
        if (taintedVar.startsWith('__line_')) continue;
        if (rhsValue.includes(taintedVar)) {
          // Taint propagates to new variable
          taintedVars.set(varName, info);
          break;
        }
      }
    }

    // Phase 2: Check if tainted values reach sinks
    for (const sink of applicableSinks) {
      if (!sink.pattern.test(line)) continue;

      // Check if any tainted variable appears on this line
      let isTainted = false;
      let taintSource: { sourceLine: number; sourceName: string } | undefined;

      // Direct source usage on same line as sink
      for (const source of applicableSources) {
        if (source.pattern.test(line)) {
          isTainted = true;
          taintSource = { sourceLine: i + 1, sourceName: source.name };
          break;
        }
      }

      // Check if any tainted variable is referenced on this line
      if (!isTainted) {
        for (const [taintedVar, info] of taintedVars) {
          if (taintedVar.startsWith('__line_')) continue;
          if (line.includes(taintedVar)) {
            isTainted = true;
            taintSource = info;
            break;
          }
        }
      }

      // Check for string interpolation with tainted vars (template literals, f-strings)
      if (!isTainted) {
        const templateMatch = line.match(/\$\{(\w+)\}|%\((\w+)\)|fmt\.Sprintf.*%[svdq].*(\w+)/);
        if (templateMatch) {
          const refVar = templateMatch[1] || templateMatch[2] || templateMatch[3];
          if (refVar && taintedVars.has(refVar)) {
            isTainted = true;
            taintSource = taintedVars.get(refVar);
          }
        }
      }

      if (!isTainted) continue;

      // Phase 3: Check for sanitizer on this line or nearby lines
      let isSanitized = false;
      // Check the current line and 2 lines above for sanitization
      const checkStart = Math.max(0, i - 2);
      for (let checkLine = checkStart; checkLine <= i; checkLine++) {
        for (const sanitizer of applicableSanitizers) {
          if (sanitizer.neutralizes.includes(sink.name) && sanitizer.pattern.test(lines[checkLine])) {
            isSanitized = true;
            break;
          }
        }
        if (isSanitized) break;
      }

      if (isSanitized) continue;

      // Build dataflow path
      const dataflowPath: string[] = [];
      if (taintSource) {
        dataflowPath.push(`source: ${taintSource.sourceName} (line ${taintSource.sourceLine})`);
        if (taintSource.sourceLine !== i + 1) {
          dataflowPath.push(`propagation: variable assignment`);
        }
        dataflowPath.push(`sink: ${sink.name} (line ${i + 1})`);
      }

      findings.push({
        id: randomUUID(),
        rule: sink.rule,
        severity: sink.severity,
        file: filePath,
        line: i + 1,
        column: line.indexOf(line.trim()) + 1,
        message: sink.message,
        remediation: sink.remediation,
        dataflowPath: dataflowPath.length > 0 ? dataflowPath : undefined,
        confidence: sink.confidence,
      });

      // Only report one finding per sink type per line
      break;
    }
  }

  return findings;
}

// ─── SASTEngine Class ───────────────────────────────────────────

/**
 * Production SAST pass using pattern-based taint analysis.
 * 5-second execution budget. Falls back to regex on timeout.
 * Supports: JavaScript, TypeScript, Python, Go.
 */
export class SASTEngine {
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 5000) {
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Analyze files for security vulnerabilities using dataflow/taint tracking.
   *
   * @param files - Array of file objects with path and content
   * @param timeoutMs - Maximum execution time in milliseconds (default: 5000)
   * @returns SASTResult with findings, timing, and fallback information
   */
  async analyze(
    files: Array<{ path: string; content: string }>,
    timeoutMs?: number,
  ): Promise<SASTResult> {
    const budget = timeoutMs ?? this.defaultTimeoutMs;
    const startTime = Date.now();
    const deadline = startTime + budget;
    const findings: SASTFinding[] = [];
    let timedOut = false;

    for (const file of files) {
      // Check if we've exceeded the time budget
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }

      // Detect language from file extension
      const language = detectLanguage(file.path);
      if (!language) {
        // Skip unsupported file types
        continue;
      }

      // Perform taint analysis on the file
      const fileFindings = performTaintAnalysis(file.path, file.content, language, deadline);
      findings.push(...fileFindings);

      // Check again after processing each file
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
    }

    const durationMs = Date.now() - startTime;

    // If timed out, fall back to regex-only analysis
    if (timedOut) {
      const regexFindings = await this.fallbackToRegex(files, deadline);
      return {
        passed: regexFindings.length === 0,
        findings: regexFindings,
        durationMs,
        timedOut: true,
        fellBackToRegex: true,
      };
    }

    return {
      passed: findings.length === 0,
      findings,
      durationMs,
      timedOut: false,
      fellBackToRegex: false,
    };
  }

  /**
   * Fall back to regex-only analysis using RealtimeCodeAnalyzer patterns.
   * Used when the full taint analysis times out.
   */
  private async fallbackToRegex(
    files: Array<{ path: string; content: string }>,
    _deadline: number,
  ): Promise<SASTFinding[]> {
    // Create a minimal callback engine for the regex analyzer
    const noopCallbackEngine = {
      emit: () => {},
      on: () => {},
      off: () => {},
    };

    const regexAnalyzer = new RealtimeCodeAnalyzer(
      noopCallbackEngine,
      null,
      // Use a generous latency budget for fallback (no timeout concern)
      30000,
      false,
    );

    const findings: SASTFinding[] = [];

    for (const file of files) {
      const result = await regexAnalyzer.analyzeBeforeWrite(
        file.path,
        file.content,
        'sast-fallback',
      );

      // Convert RealtimeAnalysisFinding to SASTFinding
      for (const finding of result.findings) {
        findings.push({
          id: finding.id,
          rule: `regex-${finding.category}`,
          severity: finding.severity,
          file: finding.file,
          line: finding.line,
          column: 1,
          message: finding.message,
          remediation: finding.remediation,
          confidence: 0.6, // Lower confidence for regex-only findings
        });
      }
    }

    return findings;
  }
}
