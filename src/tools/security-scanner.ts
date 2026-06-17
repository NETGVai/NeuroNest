/**
 * Security Scanner — AI Security Review Panel.
 *
 * Performs local, pattern-based vulnerability scanning on project files.
 * Detects: SQL injection, XSS, CSRF, hardcoded secrets, insecure patterns.
 * No external service dependencies — pure local pattern matching.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolContext, ToolResult } from '../shared/types.js';
import type { ExecutableToolDefinition } from './tool-system.js';

// ─── Interfaces ─────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'low';

export interface SecurityFinding {
  severity: Severity;
  file: string;
  line: number;
  description: string;
  suggestedFix: string;
}

export interface VulnerabilityPattern {
  id: string;
  category: string;
  severity: Severity;
  pattern: RegExp;
  description: string;
  suggestedFix: string;
}

export interface SecurityScanInput {
  /** Action to perform */
  action: 'scan';
  /** Specific files to scan (relative paths). If omitted, scans all project files. */
  files?: string[];
  /** File extensions to scan (default: ['.ts', '.js', '.tsx', '.jsx', '.html', '.py', '.rb', '.php']) */
  extensions?: string[];
}

export interface SecurityScanOutput {
  findings: SecurityFinding[];
  filesScanned: number;
  summary: {
    high: number;
    medium: number;
    low: number;
    total: number;
  };
}

// ─── Vulnerability Pattern Definitions ──────────────────────────

export const VULNERABILITY_PATTERNS: VulnerabilityPattern[] = [
  // SQL Injection patterns
  {
    id: 'sql-injection-concat',
    category: 'SQL Injection',
    severity: 'high',
    pattern: /(?:query|execute|exec|raw)\s*\(\s*(?:`[^`]*\$\{|['"].*['"])\s*\+/i,
    description: 'Potential SQL injection via string concatenation or template literal in query',
    suggestedFix: 'Use parameterized queries or prepared statements instead of string concatenation',
  },
  {
    id: 'sql-injection-format',
    category: 'SQL Injection',
    severity: 'high',
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|DROP)\s+.*(?:\$\{|\+\s*(?:req|params|input|user|body|query))/i,
    description: 'SQL statement with potentially unsanitized user input interpolation',
    suggestedFix: 'Use parameterized queries (e.g., $1, ?) instead of interpolating user input into SQL',
  },

  // XSS patterns
  {
    id: 'xss-innerhtml',
    category: 'XSS',
    severity: 'high',
    pattern: /\.innerHTML\s*=\s*(?!['"`]\s*$)/,
    description: 'Direct innerHTML assignment may allow cross-site scripting (XSS)',
    suggestedFix: 'Use textContent, or sanitize input with a library like DOMPurify before assigning to innerHTML',
  },
  {
    id: 'xss-dangerously-set',
    category: 'XSS',
    severity: 'high',
    pattern: /dangerouslySetInnerHTML/,
    description: 'dangerouslySetInnerHTML bypasses React XSS protections',
    suggestedFix: 'Avoid dangerouslySetInnerHTML; if necessary, sanitize with DOMPurify first',
  },
  {
    id: 'xss-document-write',
    category: 'XSS',
    severity: 'medium',
    pattern: /document\.write\s*\(/,
    description: 'document.write can introduce XSS vulnerabilities',
    suggestedFix: 'Use DOM manipulation methods (createElement, appendChild) instead of document.write',
  },

  // Hardcoded secrets
  {
    id: 'secret-password',
    category: 'Hardcoded Secrets',
    severity: 'high',
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{3,}['"`]/i,
    description: 'Hardcoded password detected in source code',
    suggestedFix: 'Move secrets to environment variables or a secrets manager',
  },
  {
    id: 'secret-api-key',
    category: 'Hardcoded Secrets',
    severity: 'high',
    pattern: /(?:api_key|apikey|api_secret|apiSecret)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
    description: 'Hardcoded API key or secret detected in source code',
    suggestedFix: 'Store API keys in environment variables or a secure vault, never in source code',
  },
  {
    id: 'secret-token',
    category: 'Hardcoded Secrets',
    severity: 'high',
    pattern: /(?:secret|token|private_key)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
    description: 'Hardcoded secret or token detected in source code',
    suggestedFix: 'Use environment variables or a secrets manager for tokens and secrets',
  },

  // CSRF patterns
  {
    id: 'csrf-no-token',
    category: 'CSRF',
    severity: 'medium',
    pattern: /app\.(?:post|put|delete|patch)\s*\([^)]*(?:(?!csrf|csrfToken|_token|xsrf)[\s\S])*\)\s*(?:=>|{)/i,
    description: 'State-changing HTTP endpoint may lack CSRF protection',
    suggestedFix: 'Add CSRF token validation middleware (e.g., csurf, csrf-csrf) to state-changing routes',
  },
  {
    id: 'csrf-form-no-token',
    category: 'CSRF',
    severity: 'medium',
    pattern: /<form[^>]*method\s*=\s*['"]post['"][^>]*>(?:(?!csrf|_token|xsrf)[\s\S]){0,500}<\/form>/i,
    description: 'HTML form with POST method may lack CSRF token',
    suggestedFix: 'Include a CSRF token hidden field in all forms that submit data',
  },

  // Insecure patterns
  {
    id: 'insecure-eval',
    category: 'Insecure Code',
    severity: 'high',
    pattern: /\beval\s*\(/,
    description: 'eval() executes arbitrary code and is a major security risk',
    suggestedFix: 'Avoid eval(); use JSON.parse() for data, or safer alternatives for dynamic execution',
  },
  {
    id: 'insecure-new-function',
    category: 'Insecure Code',
    severity: 'high',
    pattern: /new\s+Function\s*\(/,
    description: 'new Function() is equivalent to eval() and executes arbitrary code',
    suggestedFix: 'Avoid new Function(); restructure code to avoid dynamic code generation',
  },
  {
    id: 'insecure-http',
    category: 'Insecure Code',
    severity: 'low',
    pattern: /['"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    description: 'Insecure HTTP URL detected (should use HTTPS)',
    suggestedFix: 'Use HTTPS instead of HTTP for all external URLs to prevent data interception',
  },
];

// ─── Default ignored directories and file extensions ────────────

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'vendor',
]);

const DEFAULT_SCAN_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx', '.html', '.py', '.rb', '.php',
  '.vue', '.svelte', '.mjs', '.cjs',
]);

// ─── SecurityScanner Class ──────────────────────────────────────

export class SecurityScanner {
  private patterns: VulnerabilityPattern[];

  constructor(patterns?: VulnerabilityPattern[]) {
    this.patterns = patterns ?? VULNERABILITY_PATTERNS;
  }

  /**
   * Scan specified files or all project files for security vulnerabilities.
   * @param projectDir - Absolute path to the project directory.
   * @param files - Optional list of relative file paths to scan. If omitted, scans all files.
   * @param extensions - Optional list of file extensions to include.
   */
  async scanFiles(
    projectDir: string,
    files?: string[],
    extensions?: string[],
  ): Promise<SecurityFinding[]> {
    const scanExtensions = extensions
      ? new Set(extensions.map(ext => ext.startsWith('.') ? ext : `.${ext}`))
      : DEFAULT_SCAN_EXTENSIONS;

    let filesToScan: string[];

    if (files && files.length > 0) {
      // Scan only specified files
      filesToScan = files.map(f => path.resolve(projectDir, f));
    } else {
      // Discover all files in the project
      filesToScan = await this.discoverFiles(projectDir, scanExtensions);
    }

    const findings: SecurityFinding[] = [];

    for (const filePath of filesToScan) {
      const ext = path.extname(filePath);
      if (!scanExtensions.has(ext)) continue;

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relativePath = path.relative(projectDir, filePath);
        const fileFindings = this.scanContent(content, relativePath);
        findings.push(...fileFindings);
      } catch {
        // Skip files that cannot be read (permissions, binary, etc.)
      }
    }

    return findings;
  }

  /**
   * Scan a string of file content for vulnerabilities.
   * Exported for testing purposes.
   */
  scanContent(content: string, filePath: string): SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of this.patterns) {
        if (pattern.pattern.test(line)) {
          findings.push({
            severity: pattern.severity,
            file: filePath,
            line: i + 1,
            description: pattern.description,
            suggestedFix: pattern.suggestedFix,
          });
        }
      }
    }

    return findings;
  }

  /**
   * Recursively discover scannable files in a directory.
   */
  private async discoverFiles(
    dir: string,
    extensions: Set<string>,
    results: string[] = [],
  ): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return results;
    }

    for (const name of names) {
      if (name.startsWith('.') && DEFAULT_IGNORE_DIRS.has(name.slice(1))) {
        continue;
      }
      if (DEFAULT_IGNORE_DIRS.has(name)) {
        continue;
      }

      const fullPath = path.join(dir, name);

      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await this.discoverFiles(fullPath, extensions, results);
      } else if (stat.isFile()) {
        const ext = path.extname(name);
        if (extensions.has(ext)) {
          results.push(fullPath);
        }
      }
    }

    return results;
  }
}

// ─── SecurityScannerTool Execute Function ───────────────────────

async function securityScannerExecute(input: unknown, context: ToolContext): Promise<ToolResult> {
  const params = input as SecurityScanInput;

  if (!params || typeof params !== 'object') {
    return { success: false, output: null, error: 'Invalid input: expected an object' };
  }

  const { action } = params;

  if (action !== 'scan') {
    return {
      success: false,
      output: null,
      error: 'Invalid action. Supported actions: scan',
    };
  }

  if (!context.projectDir) {
    return { success: false, output: null, error: 'No project directory set in context' };
  }

  const projectDir = path.resolve(context.projectDir);

  const scanner = new SecurityScanner();
  const findings = await scanner.scanFiles(projectDir, params.files, params.extensions);

  // Build summary
  const summary = {
    high: findings.filter(f => f.severity === 'high').length,
    medium: findings.filter(f => f.severity === 'medium').length,
    low: findings.filter(f => f.severity === 'low').length,
    total: findings.length,
  };

  // Count files scanned (dedup from findings or report based on input)
  const uniqueFiles = new Set(findings.map(f => f.file));
  const filesScanned = params.files?.length ?? uniqueFiles.size;

  const output: SecurityScanOutput = {
    findings,
    filesScanned,
    summary,
  };

  return {
    success: true,
    output,
  };
}

// ─── Tool Definition ────────────────────────────────────────────

export const SecurityScannerTool: ExecutableToolDefinition = {
  id: 'security-scanner',
  name: 'SecurityScannerTool',
  description:
    'Scan project files for common security vulnerabilities including SQL injection, XSS, CSRF, hardcoded secrets, and insecure code patterns. Returns findings as a table with severity, location, description, and suggested fix.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['scan'],
        description: 'The action to perform (currently only "scan" is supported)',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of specific file paths (relative to project) to scan. If omitted, scans all project files.',
      },
      extensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of file extensions to include (e.g., [".ts", ".js"]). Defaults to common code extensions.',
      },
    },
    required: ['action'],
  },
  riskLevel: 'read-only',
  execute: securityScannerExecute,
};
